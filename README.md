# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/sxs-cell/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/sxs-cell/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process — git smart HTTP (upload-pack v2, receive-pack v0), REST v3, GraphQL v4 and MCP over one in-memory store, standard library only. No dependencies, no install step, no git binary: the pack protocol, object store and all four API surfaces are implemented on `node:zlib` and `node:crypto`.

## Run it

```sh
node main.ts
```

The forge listens on an ephemeral port and registers it with the harness at `$MAKEFUN_ENV_URL`; `MAKEFUN_SHOP_TOKEN` is the bearer token for the REST, GraphQL and MCP surfaces, and `MAKEFUN_TRIAL_NOW` pins every timestamp for deterministic replays.

---

<sub>Entered on [make.fun](https://make.fun/?ref=plucky-otter-16&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
