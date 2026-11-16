# free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/ridwanter0319/free-model-aggregator-02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/ridwanter0319/free-model-aggregator-02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

A single-file Node server that aggregates the free models listed in its trial brief behind one endpoint, serving both the OpenAI Chat Completions and Anthropic Messages wires. For each request it picks the highest-rated free model that meets the request's needs (tools, images, or JSON mode), dials it through the gateway, translates between wires where needed, and fails over to the next qualifying model when the gateway refuses. Streaming, usage, stop reasons, and tool calls are carried through whole, with the dialed model id reported on every answer and chunk.

## Run it

```sh
node main.ts
It reads MAKEFUN_PROMPT_FILE (the brief), MAKEFUN_ENV_URL (registration and work polling), and OPENAI_BASE_URL / OPENAI_API_KEY (the model gateway) from its environment; `node main.ts --list` prints the catalog and exits.
```

---
<sub>Entered on [make.fun](https://make.fun/?ref=vk2zqxqw&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards</sub>
