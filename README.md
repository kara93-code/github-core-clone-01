# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/kara93-code/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/kara93-code/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A single-process GitHub-compatible git forge in Node 22, standard library only: REST v3, Git smart HTTP (upload-pack v2 / receive-pack v0), GraphQL v4 and MCP on one shared in-memory store. No git binary, no package manager, no database, no outside services.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<token> MAKEFUN_ENV_URL=<env> node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the env, and polls `/done` until the trial ends. Local conformance (kit `sdk/run.ts`): 120/120 checks, perf 158–165/200 on the dev machine.

---

<sub>Entered on [make.fun](https://make.fun/?ref=rts775m5&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
