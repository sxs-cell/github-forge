// github-forge: a single-process, GitHub-compatible git forge.
// Node 22 standard library only. Serves git smart HTTP (v2 upload-pack, v0 receive-pack),
// REST v3, GraphQL v4 and MCP over streamable HTTP, all over one in-memory store.
//
// Determinism: no wall clock or Math.random in anything sent or stored. Timestamps come
// from MAKEFUN_TRIAL_NOW when set, otherwise a fixed constant. Ids are sequential counters.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// --------------------------------------------------------------------------- constants

const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const TRIAL_NOW_RAW = process.env.MAKEFUN_TRIAL_NOW ?? '';
const TRIAL_NOW = (() => {
  if (TRIAL_NOW_RAW !== '') {
    const d = new Date(TRIAL_NOW_RAW);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    if (/^\d+$/.test(TRIAL_NOW_RAW)) return new Date(Number(TRIAL_NOW_RAW)).toISOString();
  }
  return '2026-11-14T06:30:00.000Z';
})();
const TRIAL_EPOCH = Math.floor(new Date(TRIAL_NOW).getTime() / 1000);
const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const ZERO_OID = '0'.repeat(40);
const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

// --------------------------------------------------------------------------- git objects

type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject {
  type: GitObjectType;
  data: Buffer;
}
interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}
function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1(Buffer.concat([header, data]));
}
function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
}

function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, message, author, committer };
}

function buildCommit(tree: string, parents: string[], message: string, timestamp: number): Buffer {
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${timestamp} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '', message.endsWith('\n') ? message : `${message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** All objects reachable from `roots` (commits, trees, blobs, tags), following parents/tree links. */
function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid) || !isOid(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      const text = object.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match) queue.push(match[1]);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` (or equal to it). */
function isAncestor(ancestor: string, tip: string, lookup: (oid: string) => GitObject | undefined): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** Commits reachable from `tip`, tip-first (pre-order DFS), deduplicated. */
function listCommits(tip: string, lookup: (oid: string) => GitObject | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (oid: string): void => {
    if (seen.has(oid) || !isOid(oid)) return;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') return;
    seen.add(oid);
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) visit(parent);
  };
  visit(tip);
  return out;
}

// --------------------------------------------------------------------------- pkt-lines

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

type PktItem = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/**
 * Parse pkt-lines. With allowTrailingPack, stop at the first 4-byte header that
 * is not a pkt-line (the start of a raw packfile, e.g. "PACK") and report the
 * byte offset where the trailing data begins instead of failing.
 */
function parsePktLines(buf: Buffer, allowTrailingPack = false): { items: PktItem[]; offset: number } | null {
  const items: PktItem[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) return null;
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      items.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (head === '0001') {
      items.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      if (allowTrailingPack) return { items, offset };
      return null;
    }
    const length = Number.parseInt(head, 16);
    if (length < 4 || offset + length > buf.length) return null;
    items.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { items, offset };
}

// --------------------------------------------------------------------------- packfiles

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Encode plain (non-delta) objects as a packfile v2. */
function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/** Decode a packfile (plain, OFS_DELTA and REF_DELTA entries), resolving bases from the pack or `external`. */
function readPack(
  pack: Buffer,
  external?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: Buffer;
    resolvedType?: GitObjectType;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack trailing bytes');
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const ext = external?.(wanted);
        if (!ext) throw new Error(`ref-delta base ${wanted} missing`);
        type = ext.type;
        data = applyDelta(ext.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// --------------------------------------------------------------------------- store

interface IssueComment {
  id: number;
  body: string;
}
interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
}
interface Label {
  name: string;
  color: string;
}
interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}
interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  baseSha: string;
  files: PullFile[];
  seq: number;
}
interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  labels: Map<string, Label>;
  pulls: Pull[];
  nextNumber: number;
  nextCommentId: number;
}

const repos = new Map<string, Repo>(); // key: owner + '/' + name
let repoSeq = 0;
let globalIdSeq = 0;
let seqCounter = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}
function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}
function createRepoRecord(name: string, description: string, isPrivate: boolean): Repo {
  repoSeq += 1;
  const repo: Repo = {
    id: repoSeq,
    name,
    owner: VIEWER_LOGIN,
    description,
    private: isPrivate,
    defaultBranch: 'main',
    createdSeq: (seqCounter += 1),
    refs: new Map(),
    objects: new Map(),
    issues: [],
    labels: new Map(),
    pulls: [],
    nextNumber: 1,
    nextCommentId: 1,
  };
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}
function nextGlobalId(): number {
  globalIdSeq += 1;
  return globalIdSeq;
}

function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}
function b64decode(text: string): string {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8');
}
function gid(kind: string, parts: string): string {
  return Buffer.from(`${kind}:${parts}`, 'utf8').toString('base64url');
}
function parseGid(id: string): { kind: string; parts: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), parts: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// --- tree / file helpers -----------------------------------------------------

function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function lookupObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** The tree oid at `commitOid`, or null. */
function treeOfCommit(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Resolve a path inside a tree; returns the entry or null. */
function findInTree(repo: Repo, treeOid: string, segments: string[]): TreeEntry | null {
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) return entry;
    current = entry.oid;
  }
  return null;
}

/** List a directory's immediate entries inside a tree; null when the path is not a tree. */
function listTreeDir(repo: Repo, treeOid: string, segments: string[]): TreeEntry[] | null {
  let current = treeOid;
  for (const segment of segments) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (!entry || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  const object = repo.objects.get(current);
  if (!object || object.type !== 'tree') return null;
  return parseTree(object.data);
}

/** Return a new tree oid with `path` set to `blobOid` (or removed when blobOid is null). */
function setFileInTree(repo: Repo, treeOid: string, segments: string[], blobOid: string | null): string {
  const object = repo.objects.get(treeOid);
  const entries: TreeEntry[] = object && object.type === 'tree' ? parseTree(object.data) : [];
  const [head, ...rest] = segments;
  const existing = entries.findIndex((entry) => entry.name === head);
  if (rest.length === 0) {
    if (blobOid === null) {
      if (existing >= 0) entries.splice(existing, 1);
    } else if (existing >= 0) {
      entries[existing] = { mode: '100644', name: head, oid: blobOid };
    } else {
      entries.push({ mode: '100644', name: head, oid: blobOid });
    }
  } else {
    let childTree = '';
    if (existing >= 0 && entries[existing].mode === '40000') childTree = entries[existing].oid;
    else if (existing >= 0) return treeOid; // a file blocks the path; leave unchanged
    const updated = setFileInTree(repo, childTree, rest, blobOid);
    if (existing >= 0) entries[existing] = { mode: '40000', name: head, oid: updated };
    else entries.push({ mode: '40000', name: head, oid: updated });
    // Prune directories that became empty after a delete.
    if (blobOid === null) {
      const child = repo.objects.get(updated);
      if (child && child.type === 'tree' && parseTree(child.data).length === 0) {
        entries.splice(entries.findIndex((entry) => entry.name === head), 1);
      }
    }
  }
  return putObject(repo, 'tree', buildTree(entries));
}

/** Flatten a tree into path -> {mode, oid}. */
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, TreeEntry>): void {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, entry);
  }
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 0;
  for (let index = 0; index < data.length; index += 1) if (data[index] === 0x0a) count += 1;
  if (data[data.length - 1] !== 0x0a) count += 1;
  return count;
}

/** Diff two trees; returns the changed files with line counts. */
function diffTrees(repo: Repo, baseTree: string, headTree: string): PullFile[] {
  const base = new Map<string, TreeEntry>();
  const head = new Map<string, TreeEntry>();
  flattenTree(repo, baseTree, '', base);
  flattenTree(repo, headTree, '', head);
  const files: PullFile[] = [];
  for (const [path, entry] of head) {
    const old = base.get(path);
    if (!old) {
      const blob = repo.objects.get(entry.oid);
      const additions = blob ? countLines(blob.data) : 0;
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (old.oid !== entry.oid) {
      const oldBlob = repo.objects.get(old.oid);
      const newBlob = repo.objects.get(entry.oid);
      const additions = newBlob ? countLines(newBlob.data) : 0;
      const deletions = oldBlob ? countLines(oldBlob.data) : 0;
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  for (const [path, entry] of base) {
    if (!head.has(path)) {
      const blob = repo.objects.get(entry.oid);
      const deletions = blob ? countLines(blob.data) : 0;
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    }
  }
  files.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return files;
}

/** Resolve a ref-ish (branch name, full ref, or commit oid) to a commit oid, or null. */
function resolveRef(repo: Repo, ref: string): string | null {
  if (isOid(ref) && repo.objects.has(ref)) return ref;
  if (ref === 'HEAD') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  if (ref.startsWith('refs/')) {
    return repo.refs.get(ref) ?? null;
  }
  return repo.refs.get(`refs/heads/${ref}`) ?? null;
}

/** Create a commit on top of `parent` (or root) that sets one file; returns the commit oid. */
function commitFile(
  repo: Repo,
  parent: string | null,
  path: string,
  content: Buffer | null,
  message: string,
): string {
  const blobOid = content === null ? null : putObject(repo, 'blob', content);
  const baseTree = parent === null ? '' : (treeOfCommit(repo, parent) ?? '');
  const treeOid = setFileInTree(repo, baseTree, path.split('/'), blobOid);
  const commitData = buildCommit(treeOid, parent === null ? [] : [parent], message, TRIAL_EPOCH);
  return putObject(repo, 'commit', commitData);
}

/** Whether merging `pull` would conflict: base moved and both sides changed a file. */
function pullIsConflicted(repo: Repo, pull: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseBranch}`);
  if (!baseTip || baseTip === pull.baseSha) return false;
  const baseTree = treeOfCommit(repo, pull.baseSha);
  const newBaseTree = treeOfCommit(repo, baseTip);
  const headTree = treeOfCommit(repo, pull.headSha);
  if (baseTree === null || newBaseTree === null || headTree === null) return false;
  const baseFiles = diffTrees(repo, baseTree, newBaseTree).map((file) => file.filename);
  const headFiles = diffTrees(repo, baseTree, headTree).map((file) => file.filename);
  return baseFiles.some((path) => headFiles.includes(path));
}

// --------------------------------------------------------------------------- HTTP plumbing

interface ReqInfo {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: Buffer;
  params: Record<string, string>;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

function sendNoContent(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId(), 'content-length': '0' });
  res.end();
}

function errJson(res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
  sendJson(res, status, { message }, extra);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function authOk(req: IncomingMessage): boolean {
  // Read the token per request so a token set after module load still applies.
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? SHOP_TOKEN;
  if (shopToken === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${shopToken}`;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Split a path into decoded segments, dropping empty ones. */
function segmentsOf(path: string): string[] {
  return path.split('/').filter((part) => part !== '').map(decodeSegment);
}

// --------------------------------------------------------------------------- REST v3

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: gid('R', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    created_at: TRIAL_NOW,
    updated_at: TRIAL_NOW,
    pushed_at: TRIAL_NOW,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gid('I', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: '' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: TRIAL_NOW,
    updated_at: TRIAL_NOW,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: gid('P', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.headBranch, sha: pull.headSha, label: `${repo.owner}:${pull.headBranch}` },
    base: { ref: pull.baseBranch, sha: pull.baseSha, label: `${repo.owner}:${pull.baseBranch}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: TRIAL_NOW,
    updated_at: TRIAL_NOW,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function requireRepo(res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) {
    errJson(res, 404, 'Not Found');
    return null;
  }
  const repo = getRepo(owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

/** Absolute URL for pagination links, same origin as the request. */
function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function pageLink(req: IncomingMessage, path: string, query: URLSearchParams, page: number, perPage: number, rel: string): string {
  const params = new URLSearchParams(query);
  params.set('page', String(page));
  params.set('per_page', String(perPage));
  return `<${originOf(req)}${path}?${params.toString()}>; rel="${rel}"`;
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; perPage: number; pageNum: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), perPage, pageNum };
}

function linkHeader(req: IncomingMessage, path: string, query: URLSearchParams, total: number, perPage: number, pageNum: number): string {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const parts: string[] = [];
  if (pageNum < lastPage) parts.push(pageLink(req, path, query, pageNum + 1, perPage, 'next'));
  if (pageNum > 1) parts.push(pageLink(req, path, query, pageNum - 1, perPage, 'prev'));
  parts.push(pageLink(req, path, query, 1, perPage, 'first'));
  parts.push(pageLink(req, path, query, lastPage, perPage, 'last'));
  return parts.join(', ');
}

const SCOPES_HEADER = { 'x-oauth-scopes': 'repo, read:org' };

async function handleRest(req: IncomingMessage, res: ServerResponse, info: ReqInfo): Promise<boolean> {
  const seg = segmentsOf(info.path);
  // All /api/v3 routes need a valid bearer token.
  if (!authOk(req)) {
    errJson(res, 401, 'Requires authentication', SCOPES_HEADER);
    return true;
  }
  const bodyParsed = info.method === 'POST' || info.method === 'PUT' || info.method === 'PATCH' || info.method === 'DELETE'
    ? parseJsonBody(info.body)
    : { ok: true as const, value: {} };
  if (!bodyParsed.ok) {
    errJson(res, 400, 'Problems parsing JSON', SCOPES_HEADER);
    return true;
  }
  const body = isRecord(bodyParsed.value) ? bodyParsed.value : {};

  // GET /api/v3/ — API root.
  if (seg.length === 2 && info.method === 'GET') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, SCOPES_HEADER);
    return true;
  }
  // GET /api/v3/meta
  if (seg.length === 3 && seg[2] === 'meta' && info.method === 'GET') {
    sendJson(res, 200, { installed_version: SERVER_VERSION }, SCOPES_HEADER);
    return true;
  }
  // GET /api/v3/user
  if (seg.length === 3 && seg[2] === 'user' && info.method === 'GET') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' }, SCOPES_HEADER);
    return true;
  }
  // GET /api/v3/user/repos (list, paginated) and POST /api/v3/user/repos (create).
  if (seg.length === 3 && seg[2] === 'user' && seg[1] === 'api' && false) return false; // unreachable guard
  if (seg[1] === 'v3' && seg.length >= 3 && seg[2] === 'user') {
    if (seg.length === 4 && seg[3] === 'repos' && info.method === 'GET') {
      const all = [...repos.values()]
        .filter((repo) => repo.owner === VIEWER_LOGIN)
        .sort((a, b) => a.createdSeq - b.createdSeq);
      const { page, perPage, pageNum } = paginate(all, info.query);
      sendJson(res, 200, page.map(repoJson), {
        ...SCOPES_HEADER,
        link: linkHeader(req, '/api/v3/user/repos', info.query, all.length, perPage, pageNum),
      });
      return true;
    }
    if (seg.length === 4 && seg[3] === 'repos' && info.method === 'POST') {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') {
        errJson(res, 422, 'Validation Failed: name is required', SCOPES_HEADER);
        return true;
      }
      if (getRepo(VIEWER_LOGIN, name)) {
        errJson(res, 422, 'Repository already exists', SCOPES_HEADER);
        return true;
      }
      const repo = createRepoRecord(
        name,
        typeof body.description === 'string' ? body.description : '',
        body.private === true,
      );
      sendJson(res, 201, repoJson(repo), SCOPES_HEADER);
      return true;
    }
  }

  // /api/v3/repos/{owner}/{name}[...]
  if (seg[1] === 'v3' && seg[2] === 'repos' && seg.length >= 5) {
    const owner = seg[3];
    const name = seg[4];
    const rest = seg.slice(5);
    // GET /repos/{o}/{r}
    if (rest.length === 0 && info.method === 'GET') {
      const repo = requireRepo(res, owner, name);
      if (!repo) return true;
      sendJson(res, 200, repoJson(repo), SCOPES_HEADER);
      return true;
    }
    // PATCH /repos/{o}/{r}
    if (rest.length === 0 && info.method === 'PATCH') {
      const repo = requireRepo(res, owner, name);
      if (!repo) return true;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      sendJson(res, 200, repoJson(repo), SCOPES_HEADER);
      return true;
    }
    // DELETE /repos/{o}/{r}
    if (rest.length === 0 && info.method === 'DELETE') {
      const repo = requireRepo(res, owner, name);
      if (!repo) return true;
      repos.delete(repoKey(owner, name));
      sendNoContent(res, 204);
      return true;
    }
    const repo = requireRepo(res, owner, name);
    if (!repo) return true;

    // GET /branches and GET /branches/{branch}
    if (rest[0] === 'branches' && info.method === 'GET') {
      if (rest.length === 1) {
        const list = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }));
        sendJson(res, 200, list, SCOPES_HEADER);
        return true;
      }
      if (rest.length === 2) {
        const sha = repo.refs.get(`refs/heads/${rest[1]}`);
        if (!sha) {
          errJson(res, 404, 'Not Found', SCOPES_HEADER);
          return true;
        }
        sendJson(res, 200, { name: rest[1], commit: { sha } }, SCOPES_HEADER);
        return true;
      }
    }
    // GET /commits[?sha=]
    if (rest[0] === 'commits' && rest.length === 1 && info.method === 'GET') {
      const ref = info.query.get('sha') ?? repo.defaultBranch;
      const tip = resolveRef(repo, ref);
      if (!tip) {
        errJson(res, 404, 'Not Found', SCOPES_HEADER);
        return true;
      }
      const commits = listCommits(tip, (oid) => lookupObject(repo, oid)).map((oid) => {
        const commit = parseCommit(lookupObject(repo, oid)!.data);
        return {
          sha: oid,
          commit: {
            // Git stores the message with a trailing newline; the API surface
            // returns it without, matching what the client sent.
            message: commit.message.replace(/\n$/, ''),
            author: { name: VIEWER_NAME, email: VIEWER_EMAIL },
            committer: { name: VIEWER_NAME, email: VIEWER_EMAIL },
          },
        };
      });
      sendJson(res, 200, commits, SCOPES_HEADER);
      return true;
    }
    // POST /git/refs and GET /git/refs/heads/{branch}
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (info.method === 'POST' && rest.length === 2) {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
          errJson(res, 422, 'Validation Failed', SCOPES_HEADER);
          return true;
        }
        if (repo.refs.has(ref)) {
          errJson(res, 422, 'Reference already exists', SCOPES_HEADER);
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: 'commit' } }, SCOPES_HEADER);
        return true;
      }
      if (info.method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
        const sha = repo.refs.get(`refs/heads/${rest[3]}`);
        if (!sha) {
          errJson(res, 404, 'Not Found', SCOPES_HEADER);
          return true;
        }
        sendJson(res, 200, { ref: `refs/heads/${rest[3]}`, object: { sha, type: 'commit' } }, SCOPES_HEADER);
        return true;
      }
    }
    // Contents: /contents[/{path...}]
    if (rest[0] === 'contents') {
      return handleContents(req, res, info, repo, rest.slice(1), body);
    }
    // Labels: POST /labels
    if (rest[0] === 'labels' && rest.length === 1 && info.method === 'POST') {
      const labelName = typeof body.name === 'string' ? body.name : '';
      if (labelName === '') {
        errJson(res, 422, 'Validation Failed: name is required', SCOPES_HEADER);
        return true;
      }
      const label: Label = { name: labelName, color: typeof body.color === 'string' ? body.color : 'ededed' };
      repo.labels.set(labelName, label);
      sendJson(res, 201, { name: label.name, color: label.color, description: '' }, SCOPES_HEADER);
      return true;
    }
    // Issues: /issues[/{n}[/comments]]
    if (rest[0] === 'issues') {
      return handleIssues(req, res, info, repo, rest.slice(1), body);
    }
    // Pulls: /pulls[/{n}[/merge|/files]]
    if (rest[0] === 'pulls') {
      return handlePulls(req, res, info, repo, rest.slice(1), body);
    }
  }

  errJson(res, 404, 'Not Found', SCOPES_HEADER);
  return true;
}

function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  info: ReqInfo,
  repo: Repo,
  pathSegs: string[],
  body: Record<string, unknown>,
): boolean {
  const path = pathSegs.join('/');
  const refParam = info.query.get('ref') ?? undefined;
  const branchParam = typeof body.branch === 'string' ? body.branch : undefined;

  if (info.method === 'GET') {
    const ref = refParam ?? repo.defaultBranch;
    const tip = resolveRef(repo, ref);
    if (!tip) {
      errJson(res, 404, 'Not Found', SCOPES_HEADER);
      return true;
    }
    const treeOid = treeOfCommit(repo, tip);
    if (treeOid === null) {
      errJson(res, 404, 'Not Found', SCOPES_HEADER);
      return true;
    }
    if (path === '') {
      const entries = listTreeDir(repo, treeOid, []) ?? [];
      sendJson(res, 200, entries.map((entry) => contentEntryJson(repo, '', entry)), SCOPES_HEADER);
      return true;
    }
    const segments = path.split('/');
    const entry = findInTree(repo, treeOid, segments);
    if (!entry) {
      errJson(res, 404, 'Not Found', SCOPES_HEADER);
      return true;
    }
    if (entry.mode === '40000') {
      const children = listTreeDir(repo, treeOid, segments) ?? [];
      sendJson(res, 200, children.map((child) => contentEntryJson(repo, path, child)), SCOPES_HEADER);
      return true;
    }
    const blob = repo.objects.get(entry.oid);
    if (!blob) {
      errJson(res, 404, 'Not Found', SCOPES_HEADER);
      return true;
    }
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: segments[segments.length - 1],
      path,
      content: blob.data.toString('base64'),
      sha: entry.oid,
    }, SCOPES_HEADER);
    return true;
  }

  if (info.method === 'PUT') {
    const message = typeof body.message === 'string' ? body.message : 'update';
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    let content: Buffer;
    try {
      content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
    } catch {
      errJson(res, 400, 'Invalid base64 content', SCOPES_HEADER);
      return true;
    }
    const branch = branchParam ?? repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    let tip = repo.refs.get(refName) ?? null;
    if (branchParam !== undefined && tip === null) {
      // A new branch starts from the default branch tip (or an unborn repo).
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    const existingSha = tip === null ? null : findInTree(repo, treeOfCommit(repo, tip) ?? '', path.split('/'))?.oid ?? null;
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (givenSha !== undefined && existingSha !== null && givenSha.toLowerCase() !== existingSha.toLowerCase()) {
      errJson(res, 409, 'Conflict: sha does not match', SCOPES_HEADER);
      return true;
    }
    if (givenSha !== undefined && existingSha === null) {
      errJson(res, 409, 'Conflict: file does not exist', SCOPES_HEADER);
      return true;
    }
    const isUpdate = existingSha !== null;
    const commitOid = commitFile(repo, tip, path, content, message);
    repo.refs.set(refName, commitOid);
    const blobOid = findInTree(repo, treeOfCommit(repo, commitOid) ?? '', path.split('/'))!.oid;
    sendJson(res, isUpdate ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, encoding: 'base64', type: 'file' },
      commit: { sha: commitOid, message },
    }, SCOPES_HEADER);
    return true;
  }

  if (info.method === 'DELETE') {
    const branch = branchParam ?? repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName);
    if (!tip) {
      errJson(res, 404, 'Not Found', SCOPES_HEADER);
      return true;
    }
    const entry = findInTree(repo, treeOfCommit(repo, tip) ?? '', path.split('/'));
    if (!entry) {
      errJson(res, 404, 'Not Found', SCOPES_HEADER);
      return true;
    }
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (givenSha !== undefined && givenSha.toLowerCase() !== entry.oid.toLowerCase()) {
      errJson(res, 409, 'Conflict: sha does not match', SCOPES_HEADER);
      return true;
    }
    const message = typeof body.message === 'string' ? body.message : 'delete';
    const commitOid = commitFile(repo, tip, path, null, message);
    repo.refs.set(refName, commitOid);
    sendJson(res, 200, { commit: { sha: commitOid, message } }, SCOPES_HEADER);
    return true;
  }

  errJson(res, 404, 'Not Found', SCOPES_HEADER);
  return true;
}

function contentEntryJson(repo: Repo, dirPath: string, entry: TreeEntry): Record<string, unknown> {
  const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
  const object = repo.objects.get(entry.oid);
  return {
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (object?.data.length ?? 0),
  };
}

function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  info: ReqInfo,
  repo: Repo,
  rest: string[],
  body: Record<string, unknown>,
): boolean {
  // POST /issues — create.
  if (rest.length === 0 && info.method === 'POST') {
    const title = typeof body.title === 'string' ? body.title : '';
    const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).map(String) : [];
    for (const label of labels) {
      if (!repo.labels.has(label)) {
        errJson(res, 422, `Validation Failed: label "${label}" does not exist`, SCOPES_HEADER);
        return true;
      }
    }
    const issue: Issue = {
      id: nextGlobalId(),
      number: repo.nextNumber,
      title,
      body: typeof body.body === 'string' ? body.body : '',
      state: 'open',
      labels,
      comments: [],
      seq: (seqCounter += 1),
    };
    repo.nextNumber += 1;
    repo.issues.push(issue);
    sendJson(res, 201, issueJson(repo, issue), SCOPES_HEADER);
    return true;
  }
  // GET /issues — list.
  if (rest.length === 0 && info.method === 'GET') {
    const state = info.query.get('state') ?? 'open';
    const sort = info.query.get('sort') ?? 'created';
    const direction = info.query.get('direction') ?? 'asc';
    let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    if (sort === 'created') {
      list = [...list].sort((a, b) => (direction === 'desc' ? b.seq - a.seq : a.seq - b.seq));
    }
    const { page } = paginate(list, info.query);
    sendJson(res, 200, page.map((issue) => issueJson(repo, issue)), SCOPES_HEADER);
    return true;
  }
  const number = Number(rest[0]);
  const issue = repo.issues.find((candidate) => candidate.number === number);
  if (!issue) {
    errJson(res, 404, 'Not Found', SCOPES_HEADER);
    return true;
  }
  // GET /issues/{n}
  if (rest.length === 1 && info.method === 'GET') {
    sendJson(res, 200, issueJson(repo, issue), SCOPES_HEADER);
    return true;
  }
  // PATCH /issues/{n}
  if (rest.length === 1 && info.method === 'PATCH') {
    if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
    sendJson(res, 200, issueJson(repo, issue), SCOPES_HEADER);
    return true;
  }
  // POST /issues/{n}/comments and GET /issues/{n}/comments
  if (rest.length === 2 && rest[1] === 'comments') {
    if (info.method === 'POST') {
      const comment: IssueComment = { id: repo.nextCommentId, body: typeof body.body === 'string' ? body.body : '' };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID } }, SCOPES_HEADER);
      return true;
    }
    if (info.method === 'GET') {
      sendJson(res, 200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID } })), SCOPES_HEADER);
      return true;
    }
  }
  errJson(res, 404, 'Not Found', SCOPES_HEADER);
  return true;
}

function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  info: ReqInfo,
  repo: Repo,
  rest: string[],
  body: Record<string, unknown>,
): boolean {
  // POST /pulls — create.
  if (rest.length === 0 && info.method === 'POST') {
    const head = typeof body.head === 'string' ? body.head : '';
    const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
    const title = typeof body.title === 'string' ? body.title : '';
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) {
      errJson(res, 422, 'Validation Failed: head or base branch not found', SCOPES_HEADER);
      return true;
    }
    const existing = repo.pulls.find((pull) => pull.headBranch === head && pull.baseBranch === base && pull.state === 'open');
    if (existing) {
      errJson(res, 422, 'Validation Failed: a pull request already exists for this head', SCOPES_HEADER);
      return true;
    }
    const headTree = treeOfCommit(repo, headSha) ?? '';
    const baseTree = treeOfCommit(repo, baseSha) ?? '';
    const pull: Pull = {
      id: nextGlobalId(),
      number: repo.nextNumber,
      title,
      body: typeof body.body === 'string' ? body.body : '',
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headBranch: head,
      baseBranch: base,
      headSha,
      baseSha,
      files: diffTrees(repo, baseTree, headTree),
      seq: (seqCounter += 1),
    };
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    sendJson(res, 201, pullJson(repo, pull), SCOPES_HEADER);
    return true;
  }
  // GET /pulls — list.
  if (rest.length === 0 && info.method === 'GET') {
    const state = info.query.get('state') ?? 'open';
    const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
    const { page } = paginate(list, info.query);
    sendJson(res, 200, page.map((pull) => pullJson(repo, pull)), SCOPES_HEADER);
    return true;
  }
  const number = Number(rest[0]);
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (!pull) {
    errJson(res, 404, 'Not Found', SCOPES_HEADER);
    return true;
  }
  // GET /pulls/{n}
  if (rest.length === 1 && info.method === 'GET') {
    sendJson(res, 200, pullJson(repo, pull), SCOPES_HEADER);
    return true;
  }
  // GET /pulls/{n}/files
  if (rest.length === 2 && rest[1] === 'files' && info.method === 'GET') {
    sendJson(res, 200, pull.files, SCOPES_HEADER);
    return true;
  }
  // PUT /pulls/{n}/merge
  if (rest.length === 2 && rest[1] === 'merge' && info.method === 'PUT') {
    if (pull.state !== 'open') {
      errJson(res, 405, 'Pull request is already closed', SCOPES_HEADER);
      return true;
    }
    if (pullIsConflicted(repo, pull)) {
      errJson(res, 405, 'Merge conflict', SCOPES_HEADER);
      return true;
    }
    const baseTip = repo.refs.get(`refs/heads/${pull.baseBranch}`)!;
    const headTree = treeOfCommit(repo, pull.headSha) ?? '';
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headBranch}\n\n${pull.title}\n`;
    const mergeData = buildCommit(headTree, [baseTip], message, TRIAL_EPOCH);
    const mergeSha = putObject(repo, 'commit', mergeData);
    repo.refs.set(`refs/heads/${pull.baseBranch}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = TRIAL_NOW;
    pull.merge_commit_sha = mergeSha;
    sendJson(res, 200, { sha: mergeSha, merged: true, message: `Pull request successfully merged` }, SCOPES_HEADER);
    return true;
  }
  errJson(res, 404, 'Not Found', SCOPES_HEADER);
  return true;
}

// --------------------------------------------------------------------------- git smart HTTP

const GIT_CAPS_V2 = [
  'agent=github-forge/1.0',
  'ls-refs=unborn',
  'fetch=shallow wait-for-done',
  'server-option',
  'object-format=sha1',
  'object-info',
];
const GIT_CAPS_UPLOAD_V0 = 'side-band-64k thin-pack ofs-delta shallow multi_ack symref=HEAD:refs/heads/main agent=github-forge/1.0';
const GIT_CAPS_RECEIVE_V0 = 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=github-forge/1.0';

interface RefInfo {
  name: string;
  oid: string;
}

function sortedRefs(repo: Repo): RefInfo[] {
  const refs: RefInfo[] = [];
  for (const [name, oid] of repo.refs) refs.push({ name, oid });
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** Peel an annotated tag ref to its target commit oid, or null when not a tag object. */
function peelTag(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  const text = object.data.toString('utf8');
  const match = /^object ([0-9a-f]{40})$/m.exec(text);
  return match ? match[1] : null;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? GIT_CAPS_UPLOAD_V0 : GIT_CAPS_RECEIVE_V0;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    // HEAD first, carrying the capabilities after a NUL.
    const headOid = defaultTip ?? refs[0].oid;
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peelTag(repo, ref.oid);
      if (peeled) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(repo: Repo): Buffer {
  void repo;
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
  ];
  for (const capability of GIT_CAPS_V2) parts.push(pktLine(`${capability}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65000;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Objects to send for wants, minus what the client holds, honouring a depth cutoff. */
/**
 * What the client already holds, given its haves and its current shallow
 * boundaries. A have that is a shallow boundary contributes only itself plus
 * its tree — the client does NOT hold that commit's ancestors. A have that is
 * not a boundary contributes its full ancestry (the non-shallow case).
 */
function collectHeld(repo: Repo, haves: string[], shallowBoundaries: string[]): Set<string> {
  const held = new Set<string>();
  const visited = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const object = repo.objects.get(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const { tree, parents } = parseCommit(object.data);
      const treeStack = [tree];
      while (treeStack.length > 0) {
        const treeOid = treeStack.pop()!;
        if (held.has(treeOid)) continue;
        const treeObject = repo.objects.get(treeOid);
        if (!treeObject) continue;
        held.add(treeOid);
        if (treeObject.type === 'tree') {
          for (const entry of parseTree(treeObject.data)) treeStack.push(entry.oid);
        }
      }
      if (!shallowBoundaries.includes(oid)) {
        for (const parent of parents) stack.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const target = peelTag(repo, oid);
      if (target) stack.push(target);
    }
  }
  return held;
}

function fetchObjects(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  shallowBoundaries: string[] = [],
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const held = collectHeld(repo, haves, shallowBoundaries);
  if (depth === null) {
    const wanted = collectReachable(wants, lookup);
    const objects: GitObject[] = [];
    for (const oid of wanted) {
      if (held.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object) objects.push(object);
    }
    return { objects, shallow: [], unshallow: [] };
  }
  // Shallow: include commits within `depth` generations of the wants, plus their trees/blobs.
  const generations = new Map<string, number>();
  const queue: Array<[string, number]> = wants.map((oid) => [oid, 0] as [string, number]);
  const includedCommits = new Set<string>();
  while (queue.length > 0) {
    const [oid, gen] = queue.shift()!;
    if (gen >= depth || generations.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    generations.set(oid, gen);
    includedCommits.add(oid);
    for (const parent of parseCommit(object.data).parents) queue.push([parent, gen + 1]);
  }
  const shallow: string[] = [];
  for (const oid of includedCommits) {
    const object = repo.objects.get(oid)!;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.some((parent) => !includedCommits.has(parent))) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const have of haves) {
    if (includedCommits.has(have) && !shallow.includes(have)) unshallow.push(have);
  }
  // Objects reachable from included commits without crossing into excluded commits.
  const objects = new Map<string, GitObject>();
  const addTree = (treeOid: string): void => {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return;
    if (!objects.has(treeOid)) objects.set(treeOid, tree);
    for (const entry of parseTree(tree.data)) {
      const child = repo.objects.get(entry.oid);
      if (!child) continue;
      if (entry.mode === '40000') addTree(entry.oid);
      else if (!objects.has(entry.oid)) objects.set(entry.oid, child);
    }
  };
  for (const oid of includedCommits) {
    const commit = repo.objects.get(oid)!;
    if (!objects.has(oid)) objects.set(oid, commit);
    addTree(parseCommit(commit.data).tree);
  }
  const out: GitObject[] = [];
  for (const [oid, object] of objects) {
    if (held.has(oid) && !includedCommits.has(oid)) continue;
    if (held.has(oid) && includedCommits.has(oid)) {
      // A commit the client already holds is still needed when it is a want's ancestor
      // inside the depth window? No: the client holds it, so it is not re-sent — unless it
      // is itself a want. Keep wants even when held (a re-fetch of a held tip).
      if (!wants.includes(oid)) continue;
    }
    out.push(object);
  }
  // Tags pointing at included commits are not part of a fetch's wants here; ignore.
  void unshallow;
  return { objects: out, shallow, unshallow };
}

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  // HEAD is a ref too: emit it when a prefix matches it (clone asks for
  // ref-prefix HEAD; without it the client cannot resolve the remote HEAD).
  if (keep('HEAD')) {
    if (defaultTip) {
      parts.push(pktLine(`${defaultTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/main\n`));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peelTag(repo, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV2(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowBoundaries.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
  }
  const { objects, shallow, unshallow } = fetchObjects(repo, wants, haves, depth, shallowBoundaries);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  // The acknowledgments section is only sent when the client sent haves;
  // a fresh clone (no haves) expects the packfile section directly.
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine('NAK\n'));
    parts.push(PKT_FLUSH);
  }
  if (depth !== null || shallowBoundaries.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, args: string[], haves: string[]): Buffer {
  const wants: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).split(' ')[0]);
    else if (arg.startsWith('shallow ')) shallowBoundaries.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
  }
  const { objects, shallow } = fetchObjects(repo, wants, haves, depth, shallowBoundaries);
  const pack = writePack(objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

async function handleGitUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  info: ReqInfo,
  repo: Repo,
): Promise<boolean> {
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  const parsed = parsePktLines(info.body);
  if (parsed === null) {
    sendRaw(res, 400, Buffer.from('bad pkt-line\n', 'utf8'), 'text/plain; charset=utf-8');
    return true;
  }
  const items = parsed.items;
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind === 'data') lines.push(item.payload.toString('utf8'));
  }
  if (!isV2) {
    // v0: wants section, flush, then haves + done, flush.
    const flushIndex = items.findIndex((item) => item.kind === 'flush');
    const wantLines = lines.slice(0, flushIndex < 0 ? lines.length : flushIndex);
    // Haves live after the first flush; recover them from the raw line list order.
    const haves: string[] = [];
    let afterFlush = false;
    let lineIndex = 0;
    for (const item of items) {
      if (item.kind === 'flush') {
        afterFlush = true;
        continue;
      }
      if (item.kind === 'data') {
        const text = item.payload.toString('utf8');
        if (afterFlush && text.startsWith('have ')) haves.push(text.slice(5).trim());
        lineIndex += 1;
      }
    }
    void lineIndex;
    const body = handleFetchV0(repo, wantLines, haves);
    sendRaw(res, 200, body, 'application/x-git-upload-pack-result');
    return true;
  }
  const commandLine = lines.find((line) => line.startsWith('command='));
  const command = commandLine?.slice('command='.length).trim() ?? '';
  const delimIndex = items.findIndex((item) => item.kind === 'delim');
  const argLines: string[] = [];
  let seenDelim = false;
  for (const item of items) {
    if (item.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (item.kind === 'data' && seenDelim) argLines.push(item.payload.toString('utf8').replace(/\n$/, ''));
  }
  void delimIndex;
  if (command === 'ls-refs') {
    const body = handleLsRefs(repo, argLines);
    sendRaw(res, 200, body, 'application/x-git-upload-pack-result');
    return true;
  }
  if (command === 'fetch') {
    const body = handleFetchV2(repo, argLines);
    sendRaw(res, 200, body, 'application/x-git-upload-pack-result');
    return true;
  }
  sendRaw(res, 400, Buffer.from('unknown command\n', 'utf8'), 'text/plain; charset=utf-8');
  return true;
}

async function handleGitReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  info: ReqInfo,
  repo: Repo,
): Promise<boolean> {
  const parsed = parsePktLines(info.body, true);
  if (parsed === null) {
    sendRaw(res, 400, Buffer.from('bad pkt-line\n', 'utf8'), 'text/plain; charset=utf-8');
    return true;
  }
  const items = parsed.items;
  // The pack follows the command pkt-lines; parsePktLines stopped at its first bytes.
  const packOffset = parsed.offset;
  const reportLines: string[] = [];
  const sendReport = (): void => {
    const inner = Buffer.concat([
      ...reportLines.map((line) => pktLine(`${line}\n`)),
      PKT_FLUSH,
    ]);
    const band = Buffer.concat([Buffer.from([1]), inner]);
    const body = Buffer.concat([pktLine(band), PKT_FLUSH]);
    sendRaw(res, 200, body, 'application/x-git-receive-pack-result');
  };
  if (items === null) {
    sendRaw(res, 400, Buffer.from('bad pkt-line\n', 'utf8'), 'text/plain; charset=utf-8');
    return true;
  }
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const item of items) {
    if (item.kind !== 'data') continue;
    let text = item.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.split(' ');
    if (parts.length >= 3 && isOid(parts[0]) && isOid(parts[1]) && parts[2].startsWith('refs/')) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }
  if (commands.length === 0) {
    sendRaw(res, 400, Buffer.from('no commands\n', 'utf8'), 'text/plain; charset=utf-8');
    return true;
  }
  const packBytes = info.body.subarray(packOffset);
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpack failed: empty pack';
    } else {
      try {
        const objects = readPack(Buffer.from(packBytes), (oid) => repo.objects.get(oid));
        for (const [oid, object] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = `unpack failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }
  reportLines.push(`unpack ${unpackOk ? 'ok' : unpackDetail}`);
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (!current) {
          reportLines.push(`ng ${command.ref} remote ref does not exist`);
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          reportLines.push(`ng ${command.ref} invalid old value`);
        } else {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}`);
        }
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        reportLines.push(`ng ${command.ref} object not found`);
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        if (current) {
          reportLines.push(`ng ${command.ref} already exists`);
        } else {
          repo.refs.set(command.ref, command.newOid);
          reportLines.push(`ok ${command.ref}`);
        }
        continue;
      }
      if (!current) {
        reportLines.push(`ng ${command.ref} invalid old value`);
        continue;
      }
      if (command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} invalid old value`);
        continue;
      }
      if (!isAncestor(command.oldOid, command.newOid, (oid) => repo.objects.get(oid))) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}`);
    }
  } else {
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed`);
  }
  sendReport();
  return true;
}

async function handleGit(req: IncomingMessage, res: ServerResponse, info: ReqInfo): Promise<boolean> {
  const seg = segmentsOf(info.path);
  // /{owner}/{repo}.git/...
  if (seg.length < 3 || !seg[1].endsWith('.git')) return false;
  const owner = seg[0];
  const name = seg[1].slice(0, -4);
  const rest = seg.slice(2);
  const repo = owner === VIEWER_LOGIN ? getRepo(owner, name) : undefined;
  if (rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs' && info.method === 'GET') {
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const service = info.query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const body = isV2 ? v2Advertisement(repo) : v0Advertisement(repo, 'git-upload-pack');
      sendRaw(res, 200, body, 'application/x-git-upload-pack-advertisement');
      return true;
    }
    if (service === 'git-receive-pack') {
      const body = v0Advertisement(repo, 'git-receive-pack');
      sendRaw(res, 200, body, 'application/x-git-receive-pack-advertisement');
      return true;
    }
    sendJson(res, 400, { message: 'Bad Request' });
    return true;
  }
  if (rest.length === 1 && rest[0] === 'git-upload-pack' && info.method === 'POST') {
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    return handleGitUploadPack(req, res, info, repo);
  }
  if (rest.length === 1 && rest[0] === 'git-receive-pack' && info.method === 'POST') {
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    return handleGitReceivePack(req, res, info, repo);
  }
  return false;
}

// --------------------------------------------------------------------------- GraphQL v4

const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt'];
const PULL_TYPE_FIELDS = ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'url'];
const REPO_TYPE_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

type GqlValue = string | number | boolean | null | GqlValue[] | { [key: string]: GqlValue };

interface GqlSelection {
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  children: GqlSelection[] | null;
  fragmentType: string | null;
}

function gqlTokenize(query: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < query.length) {
    const char = query[index];
    if (/\s/.test(char) || char === ',') {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < query.length && query[index] !== '\n') index += 1;
      continue;
    }
    if ('{}():![]=@$...'.includes(char) || (char === '.' && query.startsWith('...', index))) {
      if (query.startsWith('...', index)) {
        tokens.push('...');
        index += 3;
      } else {
        tokens.push(char);
        index += 1;
      }
      continue;
    }
    if (char === '"') {
      let end = index + 1;
      let value = '';
      while (end < query.length && query[end] !== '"') {
        if (query[end] === '\\' && end + 1 < query.length) {
          value += query[end + 1];
          end += 2;
        } else {
          value += query[end];
          end += 1;
        }
      }
      tokens.push(JSON.stringify(value));
      index = end + 1;
      continue;
    }
    let end = index;
    while (end < query.length && !/[\s,{}():!@$\[\]]/.test(query[end]) && !query.startsWith('...', end)) end += 1;
    tokens.push(query.slice(index, end));
    index = end;
  }
  return tokens;
}

class GqlParser {
  private tokens: string[];
  private pos = 0;
  private variables: Record<string, unknown>;
  constructor(
    query: string,
    variables: Record<string, unknown>,
  ) {
    this.tokens = gqlTokenize(query);
    this.variables = variables;
  }
  peek(): string | undefined {
    return this.tokens[this.pos];
  }
  next(): string {
    return this.tokens[this.pos++] ?? '';
  }
  expect(token: string): void {
    if (this.next() !== token) throw new Error(`expected ${token}`);
  }
  parseValue(): GqlValue {
    const token = this.next();
    if (token === '$') {
      const name = this.next();
      return this.variables[name] as GqlValue;
    }
    if (token === '{') {
      const object: Record<string, GqlValue> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        object[key] = this.parseValue();
      }
      this.expect('}');
      return object;
    }
    if (token === '[') {
      const list: GqlValue[] = [];
      while (this.peek() !== ']') list.push(this.parseValue());
      this.expect(']');
      return list;
    }
    if (token.startsWith('"')) return JSON.parse(token) as string;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (/^-?\d+$/.test(token)) return Number(token);
    if (/^-?\d+\.\d+$/.test(token)) return Number(token);
    return token; // enum literal
  }
  parseArgs(): Record<string, GqlValue> {
    const args: Record<string, GqlValue> = {};
    if (this.peek() !== '(') return args;
    this.expect('(');
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }
  parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        let fragmentType: string | null = null;
        if (this.peek() === 'on') {
          this.next();
          fragmentType = this.next();
        }
        const children = this.parseSelectionSet();
        selections.push({ alias: null, name: '...', args: {}, children, fragmentType });
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args = this.parseArgs();
      let children: GqlSelection[] | null = null;
      if (this.peek() === '{') children = this.parseSelectionSet();
      selections.push({ alias, name, args, children, fragmentType: null });
    }
    this.expect('}');
    return selections;
  }
  /** Parse one operation: returns its root selections. */
  parseOperation(): GqlSelection[] {
    let token = this.peek();
    if (token === 'query' || token === 'mutation' || token === 'subscription') {
      this.next();
      token = this.peek();
      if (token !== undefined && token !== '{' && token !== '(') this.next(); // operation name
      if (this.peek() === '(') {
        // variable definitions — skip them.
        let depth = 0;
        while (this.pos < this.tokens.length) {
          const tok = this.next();
          if (tok === '(') depth += 1;
          else if (tok === ')') {
            depth -= 1;
            if (depth === 0) break;
          }
        }
      }
    }
    return this.parseSelectionSet();
  }
}

interface GqlContext {
  errors: Array<{ message: string }>;
}

function gqlIssueState(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function gqlIssueJson(repo: Repo, issue: Issue): Record<string, GqlValue> {
  return {
    id: gid('I', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    state: gqlIssueState(issue.state),
    body: issue.body,
  };
}

function gqlPullJson(repo: Repo, pull: Pull): Record<string, GqlValue> {
  return {
    id: gid('P', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    headRefName: pull.headBranch,
    baseRefName: pull.baseBranch,
    mergeable: pullIsConflicted(repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
  };
}

function gqlRepoJson(repo: Repo): Record<string, GqlValue> {
  return {
    id: gid('R', String(repo.id)),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

/** Resolve one selection against a value of a known type; unknown fields record an error. */
function resolveSelections(
  selections: GqlSelection[],
  value: Record<string, GqlValue> | null,
  typeName: string,
  ctx: GqlContext,
  repo: Repo | null,
): Record<string, GqlValue> {
  const out: Record<string, GqlValue> = {};
  if (value === null) return out;
  for (const selection of selections) {
    if (selection.name === '...') {
      // Inline fragment: apply when the type matches (or no condition).
      if (selection.fragmentType === null || selection.fragmentType === typeName) {
        Object.assign(out, resolveSelections(selection.children ?? [], value, typeName, ctx, repo));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (!(selection.name in value)) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      continue;
    }
    const raw = value[selection.name];
    out[key] = resolveFieldValue(selection, raw, typeName, ctx, repo);
  }
  return out;
}

function resolveFieldValue(
  selection: GqlSelection,
  raw: GqlValue,
  parentType: string,
  ctx: GqlContext,
  repo: Repo | null,
): GqlValue {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const record = raw as Record<string, GqlValue>;
  if (selection.children === null) return raw;
  // Nested object: figure out its type from the field name.
  let typeName = 'Object';
  if (selection.name === 'owner') typeName = 'User';
  else if (selection.name === 'defaultBranchRef') typeName = 'Ref';
  else if (selection.name === 'issue') typeName = 'Issue';
  else if (selection.name === 'issues') typeName = 'IssueConnection';
  else if (selection.name === 'pullRequests') typeName = 'PullRequestConnection';
  else if (selection.name === 'pullRequest') typeName = 'PullRequest';
  else if (selection.name === 'nodes') typeName = parentType === 'IssueConnection' ? 'Issue' : 'PullRequest';
  else if (selection.name === 'pageInfo') typeName = 'PageInfo';
  else if (selection.name === 'commentEdge') typeName = 'CommentEdge';
  else if (selection.name === 'node') typeName = 'Node';
  else if (selection.name === 'repository') typeName = 'Repository';
  else if (selection.name === 'viewer') typeName = 'User';
  void repo;
  return resolveSelections(selection.children, record, typeName, ctx, repo);
}

function executeGraphQL(query: string, variables: Record<string, unknown>): { data: Record<string, GqlValue> | null; errors: Array<{ message: string }> } {
  const ctx: GqlContext = { errors: [] };
  let selections: GqlSelection[];
  try {
    selections = new GqlParser(query, variables).parseOperation();
  } catch {
    return { data: null, errors: [{ message: 'Syntax Error: could not parse query.' }] };
  }
  const isMutation = /^\s*mutation\b/.test(query);
  const data: Record<string, GqlValue> = {};
  for (const selection of selections) {
    const key = selection.alias ?? selection.name;
    if (selection.name === '__type') {
      const name = String(selection.args.name ?? '');
      let typeValue: Record<string, GqlValue> | null = null;
      if (name === 'Issue') typeValue = { fields: ISSUE_TYPE_FIELDS.map((field) => ({ name: field })), enumValues: null };
      else if (name === 'PullRequest') typeValue = { fields: PULL_TYPE_FIELDS.map((field) => ({ name: field })), enumValues: null };
      else if (name === 'Repository') typeValue = { fields: REPO_TYPE_FIELDS.map((field) => ({ name: field })), enumValues: null };
      else if (name === 'SearchType') typeValue = { fields: null, enumValues: SEARCH_TYPE_VALUES.map((value) => ({ name: value })) };
      if (typeValue === null) {
        data[key] = null;
        continue;
      }
      data[key] = resolveSelections(selection.children ?? [], typeValue, '__Type', ctx, null);
      continue;
    }
    if (isMutation) {
      data[key] = executeMutation(selection, ctx);
      continue;
    }
    if (selection.name === 'viewer') {
      const viewerValue: Record<string, GqlValue> = { login: VIEWER_LOGIN, id: VIEWER_ID };
      data[key] = selection.children === null ? viewerValue : resolveSelections(selection.children, viewerValue, 'User', ctx, null);
      continue;
    }
    if (selection.name === 'repository') {
      const owner = String(selection.args.owner ?? '');
      const name = String(selection.args.name ?? '');
      const repo = owner === VIEWER_LOGIN ? getRepo(owner, name) : undefined;
      if (!repo) {
        data[key] = null;
        continue;
      }
      const repoValue = buildRepoValue(repo, selection);
      data[key] = selection.children === null ? repoValue : resolveSelections(selection.children, repoValue, 'Repository', ctx, repo);
      continue;
    }
    if (selection.name === 'node') {
      const parsed = parseGid(String(selection.args.id ?? ''));
      let nodeValue: Record<string, GqlValue> | null = null;
      let nodeType = 'Node';
      if (parsed?.kind === 'R') {
        const repo = [...repos.values()].find((candidate) => candidate.id === Number(parsed.parts));
        if (repo) {
          nodeValue = { id: gid('R', String(repo.id)), name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` };
          nodeType = 'Repository';
        }
      }
      if (nodeValue === null) {
        data[key] = null;
        continue;
      }
      data[key] = selection.children === null ? nodeValue : resolveSelections(selection.children, nodeValue, nodeType, ctx, null);
      continue;
    }
    ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "Query".` });
  }
  return { data, errors: ctx.errors };
}

/** Build the Repository value with its connection fields resolved from the selection args. */
function buildRepoValue(repo: Repo, selection: GqlSelection): Record<string, GqlValue> {
  const value: Record<string, GqlValue> = gqlRepoJson(repo);
  for (const child of selection.children ?? []) {
    if (child.name === 'issue') {
      const number = Number(child.args.number ?? 0);
      const issue = repo.issues.find((candidate) => candidate.number === number);
      value.issue = issue ? gqlIssueJson(repo, issue) : null;
    } else if (child.name === 'issues') {
      value.issues = issuesConnection(repo, child);
    } else if (child.name === 'pullRequests') {
      const first = Number(child.args.first ?? 100);
      const nodes = repo.pulls.slice(0, first).map((pull) => gqlPullJson(repo, pull));
      value.pullRequests = { nodes };
    } else if (child.name === 'pullRequest') {
      const number = Number(child.args.number ?? 0);
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (!pull) {
        value.pullRequest = null;
      } else {
        const pullValue = gqlPullJson(repo, pull);
        pullValue.files = { nodes: pull.files.slice(0, Number(child.args.first ?? 10)).map((file) => ({ path: file.filename })) };
        // files is nested under pullRequest; the child selection for pullRequest carries it.
        value.pullRequest = pullValue;
      }
    }
  }
  return value;
}

function issuesConnection(repo: Repo, selection: GqlSelection): Record<string, GqlValue> {
  const states = Array.isArray(selection.args.states) ? (selection.args.states as string[]) : null;
  const orderBy = isRecord(selection.args.orderBy) ? selection.args.orderBy : null;
  const first = Number(selection.args.first ?? 100);
  const after = typeof selection.args.after === 'string' ? selection.args.after : null;
  let list = [...repo.issues];
  if (states) {
    list = list.filter((issue) => states.includes(gqlIssueState(issue.state)));
  }
  const direction = orderBy && String(orderBy.direction ?? '') === 'DESC' ? -1 : 1;
  const field = orderBy ? String(orderBy.field ?? 'CREATED_AT') : 'CREATED_AT';
  if (field === 'CREATED_AT') {
    list.sort((a, b) => (a.number - b.number) * direction);
  }
  let startIndex = 0;
  if (after) {
    try {
      const decoded = Buffer.from(after, 'base64url').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match) startIndex = Number(match[1]) + 1;
    } catch {
      startIndex = 0;
    }
  }
  const page = list.slice(startIndex, startIndex + first);
  const endIndex = startIndex + page.length - 1;
  const hasNextPage = startIndex + page.length < list.length;
  const endCursor = page.length > 0 ? Buffer.from(`cursor:${endIndex}`, 'utf8').toString('base64url') : null;
  return {
    nodes: page.map((issue) => gqlIssueJson(repo, issue)),
    pageInfo: { hasNextPage, endCursor },
  };
}

function findRepoByGid(id: string): Repo | undefined {
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'R') return undefined;
  return [...repos.values()].find((candidate) => candidate.id === Number(parsed.parts));
}

function findIssueByGid(id: string): { repo: Repo; issue: Issue } | undefined {
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'I') return undefined;
  const [repoId, number] = parsed.parts.split(':');
  const repo = [...repos.values()].find((candidate) => candidate.id === Number(repoId));
  if (!repo) return undefined;
  const issue = repo.issues.find((candidate) => candidate.number === Number(number));
  if (!issue) return undefined;
  return { repo, issue };
}

function findPullByGid(id: string): { repo: Repo; pull: Pull } | undefined {
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'P') return undefined;
  const [repoId, number] = parsed.parts.split(':');
  const repo = [...repos.values()].find((candidate) => candidate.id === Number(repoId));
  if (!repo) return undefined;
  const pull = repo.pulls.find((candidate) => candidate.number === Number(number));
  if (!pull) return undefined;
  return { repo, pull };
}

function executeMutation(selection: GqlSelection, ctx: GqlContext): GqlValue {
  const input = isRecord(selection.args.input) ? selection.args.input : {};
  const children = selection.children ?? [];
  if (selection.name === 'createIssue') {
    const repo = findRepoByGid(String(input.repositoryId ?? ''));
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
      return null;
    }
    const issue: Issue = {
      id: nextGlobalId(),
      number: repo.nextNumber,
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      comments: [],
      seq: (seqCounter += 1),
    };
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return resolveSelections(children, { issue: gqlIssueJson(repo, issue) }, 'CreateIssuePayload', ctx, repo);
  }
  if (selection.name === 'closeIssue') {
    const found = findIssueByGid(String(input.issueId ?? ''));
    if (!found) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
      return null;
    }
    found.issue.state = 'closed';
    return resolveSelections(children, { issue: gqlIssueJson(found.repo, found.issue) }, 'CloseIssuePayload', ctx, found.repo);
  }
  if (selection.name === 'createPullRequest') {
    const repo = findRepoByGid(String(input.repositoryId ?? ''));
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
      return null;
    }
    const headBranch = String(input.headRefName ?? '');
    const baseBranch = String(input.baseRefName ?? '');
    const headSha = repo.refs.get(`refs/heads/${headBranch}`);
    const baseSha = repo.refs.get(`refs/heads/${baseBranch}`);
    if (!headSha || !baseSha) {
      ctx.errors.push({ message: 'Head or base branch not found.' });
      return null;
    }
    const headTree = treeOfCommit(repo, headSha) ?? '';
    const baseTree = treeOfCommit(repo, baseSha) ?? '';
    const pull: Pull = {
      id: nextGlobalId(),
      number: repo.nextNumber,
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headBranch,
      baseBranch,
      headSha,
      baseSha,
      files: diffTrees(repo, baseTree, headTree),
      seq: (seqCounter += 1),
    };
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    return resolveSelections(children, { pullRequest: gqlPullJson(repo, pull) }, 'CreatePullRequestPayload', ctx, repo);
  }
  if (selection.name === 'mergePullRequest') {
    const found = findPullByGid(String(input.pullRequestId ?? ''));
    if (!found) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
      return null;
    }
    const { repo, pull } = found;
    if (pull.state !== 'open') {
      ctx.errors.push({ message: 'Pull request is already closed.' });
      return resolveSelections(children, { pullRequest: gqlPullJson(repo, pull) }, 'MergePullRequestPayload', ctx, repo);
    }
    if (pullIsConflicted(repo, pull)) {
      ctx.errors.push({ message: 'Merge conflict.' });
      return resolveSelections(children, { pullRequest: gqlPullJson(repo, pull) }, 'MergePullRequestPayload', ctx, repo);
    }
    const baseTip = repo.refs.get(`refs/heads/${pull.baseBranch}`)!;
    const headTree = treeOfCommit(repo, pull.headSha) ?? '';
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headBranch}\n\n${pull.title}\n`;
    const mergeSha = putObject(repo, 'commit', buildCommit(headTree, [baseTip], message, TRIAL_EPOCH));
    repo.refs.set(`refs/heads/${pull.baseBranch}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = TRIAL_NOW;
    pull.merge_commit_sha = mergeSha;
    return resolveSelections(children, { pullRequest: gqlPullJson(repo, pull) }, 'MergePullRequestPayload', ctx, repo);
  }
  if (selection.name === 'addComment') {
    const found = findIssueByGid(String(input.subjectId ?? ''));
    if (!found) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
      return null;
    }
    const comment: IssueComment = { id: found.repo.nextCommentId, body: String(input.body ?? '') };
    found.repo.nextCommentId += 1;
    found.issue.comments.push(comment);
    const node = { id: gid('C', `${found.repo.id}:${found.issue.number}:${comment.id}`), body: comment.body };
    return resolveSelections(children, { commentEdge: { node } }, 'AddCommentPayload', ctx, found.repo);
  }
  ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "Mutation".` });
  return null;
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse, info: ReqInfo): Promise<boolean> {
  if (!authOk(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  const parsed = parseJsonBody(info.body);
  if (!parsed.ok) {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return true;
  }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (!isRecord(doc) || typeof doc.query !== 'string') {
      return { data: null, errors: [{ message: 'Expected a query string.' }] };
    }
    const variables = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    const result = executeGraphQL(doc.query, variables);
    const out: Record<string, unknown> = { data: result.data };
    if (result.errors.length > 0) out.errors = result.errors;
    return out;
  };
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map(runOne));
    return true;
  }
  sendJson(res, 200, runOne(parsed.value));
  return true;
}

// --------------------------------------------------------------------------- MCP

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function toolTextResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}
function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = MCP_TOOLS.find((tool) => tool.name === name);
  if (!def) return toolErrorResult(`Unknown tool: ${name}`);
  const required = (def.inputSchema.required as string[]) ?? [];
  const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) return toolErrorResult(`Missing required arguments: ${missing.join(', ')}`);
  const owner = String(args.owner ?? VIEWER_LOGIN);
  const repoName = String(args.repo ?? args.name ?? '');
  if (name === 'create_repo') {
    const repoNameArg = String(args.name ?? '');
    if (repoNameArg === '') return toolErrorResult('Missing required arguments: name');
    if (getRepo(VIEWER_LOGIN, repoNameArg)) return toolErrorResult('Repository already exists');
    const repo = createRepoRecord(
      repoNameArg,
      typeof args.description === 'string' ? args.description : '',
      args.private === true,
    );
    return toolTextResult(repoJson(repo));
  }
  const repo = owner === VIEWER_LOGIN ? getRepo(owner, repoName) : undefined;
  if (!repo) return toolErrorResult(`Repository not found: ${owner}/${repoName}`);
  if (name === 'get_repo') return toolTextResult(repoJson(repo));
  if (name === 'create_issue') {
    const issue: Issue = {
      id: nextGlobalId(),
      number: repo.nextNumber,
      title: String(args.title ?? ''),
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      comments: [],
      seq: (seqCounter += 1),
    };
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return toolTextResult(issueJson(repo, issue));
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    return toolTextResult(list.map((issue) => issueJson(repo, issue)));
  }
  if (name === 'create_pull_request') {
    const head = String(args.head ?? '');
    const base = String(args.base ?? repo.defaultBranch);
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return toolErrorResult('Head or base branch not found');
    const headTree = treeOfCommit(repo, headSha) ?? '';
    const baseTree = treeOfCommit(repo, baseSha) ?? '';
    const pull: Pull = {
      id: nextGlobalId(),
      number: repo.nextNumber,
      title: String(args.title ?? ''),
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headBranch: head,
      baseBranch: base,
      headSha,
      baseSha,
      files: diffTrees(repo, baseTree, headTree),
      seq: (seqCounter += 1),
    };
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    return toolTextResult(pullJson(repo, pull));
  }
  if (name === 'merge_pull_request') {
    const number = Number(args.pull_number ?? 0);
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (!pull) return toolErrorResult(`Pull request #${number} not found`);
    if (pull.state !== 'open') return toolErrorResult('Pull request is already closed');
    if (pullIsConflicted(repo, pull)) return toolErrorResult('Merge conflict');
    const baseTip = repo.refs.get(`refs/heads/${pull.baseBranch}`)!;
    const headTree = treeOfCommit(repo, pull.headSha) ?? '';
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headBranch}\n\n${pull.title}\n`;
    const mergeSha = putObject(repo, 'commit', buildCommit(headTree, [baseTip], message, TRIAL_EPOCH));
    repo.refs.set(`refs/heads/${pull.baseBranch}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = TRIAL_NOW;
    pull.merge_commit_sha = mergeSha;
    return toolTextResult({ sha: mergeSha, merged: true, message: 'Pull request successfully merged', number: pull.number });
  }
  return toolErrorResult(`Unknown tool: ${name}`);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, info: ReqInfo): Promise<boolean> {
  if (info.method === 'DELETE') {
    sendJson(res, 200, {});
    return true;
  }
  if (info.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (!authOk(req)) {
    const parsedEarly = parseJsonBody(info.body);
    const id = parsedEarly.ok && isRecord(parsedEarly.value) ? parsedEarly.value.id : null;
    sendJson(res, 401, mcpError(id, -32000, 'Unauthorized'));
    return true;
  }
  const parsed = parseJsonBody(info.body);
  if (!parsed.ok) {
    sendJson(res, 400, mcpError(null, -32700, 'Parse error'));
    return true;
  }
  const rpc = parsed.value;
  if (!isRecord(rpc) || typeof rpc.method !== 'string') {
    sendJson(res, 400, mcpError(isRecord(rpc) ? rpc.id : null, -32600, 'Invalid Request'));
    return true;
  }
  const id = rpc.id ?? null;
  const method = rpc.method;
  const params = isRecord(rpc.params) ? rpc.params : {};
  // Notifications carry no id: answer 202 with no body.
  if (id === null && id !== 0 && rpc.id === undefined) {
    res.writeHead(202, { 'content-length': '0' });
    res.end();
    return true;
  }
  if (method === 'server/discover') {
    sendJson(res, 200, mcpResult(id, {
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    }));
    return true;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    sendJson(res, 200, mcpResult(id, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }));
    return true;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, mcpResult(id, { tools: MCP_TOOLS }));
    return true;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    if (!MCP_TOOLS.some((tool) => tool.name === toolName)) {
      sendJson(res, 200, mcpError(id, -32602, `Unknown tool: ${toolName}`));
      return true;
    }
    sendJson(res, 200, mcpResult(id, callMcpTool(toolName, args)));
    return true;
  }
  sendJson(res, 200, mcpError(id, -32601, `Method not found: ${method}`));
  return true;
}

// --------------------------------------------------------------------------- router

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const body = await readBody(req);
        const url = new URL(req.url ?? '/', 'http://entry');
        const info: ReqInfo = {
          method: req.method ?? 'GET',
          path: url.pathname,
          query: url.searchParams,
          headers: req.headers,
          body,
          params: {},
        };
        if (info.method === 'GET' && info.path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (info.path === '/mcp') {
          await handleMcp(req, res, info);
          return;
        }
        if (info.path === '/api/graphql' && info.method === 'POST') {
          await handleGraphQL(req, res, info);
          return;
        }
        if (info.path.startsWith('/api/v3')) {
          await handleRest(req, res, info);
          return;
        }
        if (await handleGit(req, res, info)) return;
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          // The response is already gone; nothing more to do.
        }
      }
    })();
  });
}
