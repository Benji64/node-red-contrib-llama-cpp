# node-red-contrib-llama-cpp

[![npm version](https://img.shields.io/npm/v/node-red-contrib-llama-cpp.svg)](https://www.npmjs.com/package/node-red-contrib-llama-cpp)
[![Node-RED](https://img.shields.io/badge/Node--RED-%3E%3D3.0-red)](https://nodered.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Node-RED node that runs **llama-server** ([llama.cpp](https://github.com/ggml-org/llama.cpp)) as a child process and exposes on-device LLM inference directly in your flows — no cloud, no Docker, no external service required.

Designed for edge devices and SBCs (Raspberry Pi, Radxa, Orange Pi…), but works on any machine where llama.cpp runs.

**Single responsibility**: this node manages the llama-server process and handles inference requests. Tool-call orchestration and agentic loops belong to your orchestration layer (e.g. RedClaw).

---

## Features

- 🚀 **Three focused API modes** — raw completion, OpenAI-compatible proxy, multi-turn chat
- 🌐 **Distributed RPC cluster** — spread a model too large for one machine across several, via llama.cpp's RPC backend (standalone / master / worker roles)
- ⚡ **Automatic lifecycle** — spawns `llama-server` on deploy, queues messages during model load, kills cleanly on redeploy
- 🔌 **Multi-model** — each node instance manages its own server on its own port
- 📊 **Performance metrics** — timing stats (tokens/sec, eval time…) parsed and emitted on output 2
- 🛠️ **Full parameter coverage** — all llama-server flags exposed in the UI
- 🔍 **Live trace toggle** — enable/disable server logs at runtime without redeploying
- 🤝 **Orchestrator-friendly** — raw API response available in `msg.llamacpp` for downstream agents

---

## Prerequisites

- **Node-RED** ≥ 3.0
- **llama.cpp** compiled with `llama-server` accessible (in `$PATH` or full path configured in the node)
- A **GGUF model file**

No npm dependencies — uses only Node.js built-in modules (`child_process`, `http`, `net`).

---

## Installation

### Via Node-RED Palette Manager

Search for `node-red-contrib-llama-cpp` in **Manage Palette → Install**.

### Via npm

```bash
cd ~/.node-red
npm install node-red-contrib-llama-cpp
```

### Manual (for development / SBC without internet)

```bash
cp llama-cpp.js llama-cpp.html package.json \
   ~/.node-red/node_modules/node-red-contrib-llama-cpp/
sudo systemctl restart nodered
```

---

## Quick Start

1. Drop a **llama.cpp** node onto your flow
2. Set **Model path** to your `.gguf` file
3. Set **Port** (default `8080`) — each node needs a unique port
4. Set **Threads** to match your CPU core count (or leave `-1` for auto-detect)
5. Deploy — the badge shows `loading model…` then `ready :8080`
6. Wire an **inject** node with a string payload and connect to the input

---

## Modes

### `completion`

Uses the `/completion` endpoint. Simple string in, string out. Best for stateless inference or when you manage the prompt format yourself.

**Input:**
```javascript
// String simple
msg.payload = "What is the boiling point of water?"

// Or full OpenAI object — messages are converted to ### Human/Assistant format
msg.payload = { messages: [{ role: "user", content: "..." }], temperature: 0.2 }
```

**Output 1:**
```javascript
msg.payload  = "Water boils at 100°C at standard pressure."
msg.llamacpp = { /* raw /completion response */ }
```

---

### `openai`

Pure proxy to `/v1/chat/completions`. The payload is forwarded as-is, the response is returned as-is. No internal state, no loops. Use this when your orchestration layer (RedClaw or similar) drives the conversation.

Activates `--jinja` automatically on the server.

**Input — full OpenAI request object (recommended):**
```javascript
msg.payload = {
  model:       "gemma-4-E2B-it-Q4_K_M.gguf",
  messages: [
    { role: "system", content: "You are a smart home assistant..." },
    { role: "user",   content: "Turn off the living room light" }
  ],
  temperature: 0.1,
  max_tokens:  400,
  stream:      false
}
```

Fields present in `msg.payload` **override** the node's default sampling values. `stream` is always forced to `false`.

**Input — string or messages array (auto-wrapped):**
```javascript
msg.payload = "Turn off the living room light"
// or
msg.payload = [{ role: "user", content: "..." }]
```

**Output 1:**
```javascript
msg.payload  = "Done, the living room light is now off."  // content string
msg.llamacpp = {                                           // full API response
  id:      "chatcmpl-...",
  model:   "gemma-4-E2B-it-Q4_K_M.gguf",
  choices: [{
    message:       { role: "assistant", content: "..." },
    finish_reason: "stop"
  }],
  usage:   { prompt_tokens: 214, completion_tokens: 33, total_tokens: 247 },
  timings: { predicted_per_second: 3.51, ... }
}
msg.messages = [ /* full history including assistant reply */ ]
```

> **Note for agentic flows**: if the model returns `tool_calls` instead of `content`, `msg.payload` will be an empty string and `msg.llamacpp.choices[0].message.tool_calls` will contain the tool call requests. Your orchestration layer (RedClaw…) intercepts this, executes the tools, appends results to `msg.messages`, and re-sends to the node for the next turn.

---

### `chat`

Identical to `openai` mode but designed for multi-turn conversations. `msg.messages` is maintained automatically across turns — pass it back as `msg.payload` on the next message.

**Multi-turn example:**
```javascript
// Turn 1
msg.payload = "What is the temperature in the salon?"
// → msg.messages = [{ role:"user", ... }, { role:"assistant", content:"..." }]

// Turn 2 — continue the conversation
msg.payload = msg.messages   // array of previous messages
// → msg.messages updated with the new exchange
```

**Output 1:**
```javascript
msg.payload  = "The salon temperature is 22.5°C."
msg.llamacpp = { /* full API response */ }
msg.messages = [ /* updated conversation history */ ]
```

---

## Cluster mode (distributed RPC)

llama.cpp can shard a single model's layers across multiple machines using its built-in RPC backend (`ggml-rpc`). This node supports all three roles via the **Cluster Role** field (separate from the API **Mode** above — a master still uses `completion`/`openai`/`chat` to talk to its own llama-server, a worker doesn't use any of them since it never runs inference).

⚠️ llama.cpp's RPC backend is documented upstream as a proof-of-concept: functional but unauthenticated. Keep it on a trusted local network, never expose it to the internet.

### `standalone` (default)

Unchanged behaviour — a single `llama-server` on one machine.

### `master`

Loads the model locally and starts `llama-server` with `--rpc host1:port1,host2:port2,...`, pointing at one or more `worker` nodes. It still answers through the normal HTTP API (`completion`/`openai`/`chat` modes all work) — RPC distribution is transparent to your flow.

**Configuration:**

| Field         | Description |
|---------------|--------------|
| RPC Workers   | One `host:port` per line (or comma-separated). Joined into `--rpc host1:port1,host2:port2` |
| Model path    | Same as standalone — the master is the only one that needs the `.gguf` file |
| GPU layers    | **Must be set high** (e.g. `99`) or no layers will actually be offloaded to the workers — this is the most common setup mistake |
| Tensor split  | Optional manual override for how memory is proportioned across local + remote devices |

If no workers are configured, the node logs a warning and runs on local resources only — it won't fail to start.

### `worker`

Runs `rpc-server` instead of `llama-server`. It doesn't load a model or run inference — it just exposes this machine's CPU/GPU to whichever `master` connects to it. Any inference message sent to a worker node is ignored with a warning; only `debug`/`trace` control topics still work.

**Configuration:**

| Field       | Default   | Description |
|-------------|-----------|--------------|
| RPC Binary  | `rpc-server` | Name or full path of the executable |
| RPC Host    | `0.0.0.0` | Bind address — `0.0.0.0` so the master (on another machine) can reach it |
| RPC Port    | `50052`   | Matches llama.cpp's own default |
| RPC Device  | *(empty)* | Restrict to one device, e.g. `CUDA0`. Empty = expose all detected devices |

### Example topology

```
Machine A (low-RAM SBC) — clusterRole: master
  Model path : /models/big-model.gguf
  RPC Workers:
    192.168.1.42:50052
    192.168.1.43:50052
  GPU layers : 99

Machine B — clusterRole: worker         Machine C — clusterRole: worker
  RPC Host: 0.0.0.0                       RPC Host: 0.0.0.0
  RPC Port: 50052                         RPC Port: 50052
```

A model too large for Machine A alone gets sharded across all three, weighted by each machine's available memory.

### Readiness & error handling

- **Worker** readiness is detected differently from standalone/master: `rpc-server` has no HTTP API, so the node watches for `Starting RPC server` in its logs, then confirms with a raw TCP connect (not an HTTP probe).
- **Port conflicts** are checked before spawning in every role — worker checks `RPC Port`, standalone/master check `Port`. On conflict the node status turns red with a clear message; it never crashes silently.
- **Spawn failures** (binary not found, permissions…) set the node to a red **Error** status via `node.status()` and log the underlying error.
- **Shutdown** is always clean regardless of role: `SIGTERM`, then `SIGKILL` after 3s if the process hasn't exited — no zombie processes on redeploy.

---

## Output 2 — metrics & debug

All non-inference messages are emitted on output 2. Use a **Switch** node on `msg.topic` to route them.

### `timing` — after every inference

Parsed automatically from llama-server logs after each request:

```javascript
{
  topic: "timing",
  payload: {
    port:               8082,
    promptEvalMs:       53624.66,
    promptTokens:       209,
    promptTokensPerSec: 3.90,
    evalMs:             9399.87,
    evalTokens:         33,
    evalTokensPerSec:   3.51,
    totalMs:            63024.53,
    totalTokens:        242,
    raw:                "… raw log lines …"
  }
}
```

### `debug` — on deploy or on demand

```javascript
{
  topic: "debug",
  payload: {
    message:         "server ready",
    mode:            "openai",
    command:         "llama-server --model /path/model.gguf --port 8082 --jinja …",
    args:            [ … ],
    samplingDefaults: { temperature: 0.8, max_tokens: 512, … },
    port:            8082
  }
}
```

---

## Control messages

| `msg.topic` | `msg.payload`    | Effect |
|-------------|------------------|--------|
| `"debug"`   | *(ignored)*      | Emits full config on output 2 |
| `"trace"`   | `true` / `false` | Enables/disables llama-server log forwarding to the Node-RED debug panel |

---

## Configuration Reference

### Mode (API)

| Value        | Endpoint                   | Use case |
|--------------|----------------------------|----------|
| `completion` | `/completion`              | Simple stateless inference |
| `openai`     | `/v1/chat/completions`     | Orchestrated flows, agentic pipelines |
| `chat`       | `/v1/chat/completions`     | Multi-turn conversations |

Irrelevant when Cluster Role is `worker` — see [Cluster mode](#cluster-mode-distributed-rpc) below.

### Cluster Role

| Value        | Runs                      | Description |
|--------------|----------------------------|--------------|
| `standalone` | `llama-server`             | Single machine, default |
| `master`     | `llama-server --rpc ...`   | Loads the model, distributes layers to workers |
| `worker`     | `rpc-server`                | Exposes local compute, runs no inference |

### Model

| Field       | Default        | Description |
|-------------|----------------|-------------|
| Model path  | *(required)*   | Absolute path to the `.gguf` model file |
| Binary      | `llama-server` | Name or full path of the executable |
| Alias       | *(empty)*      | Model name exposed in the API (`--alias`) |

### Server

| Field               | Default     | Flag                  | Description |
|---------------------|-------------|-----------------------|-------------|
| Port                | `8080`      | `--port`              | Each node needs a unique port |
| Host                | `127.0.0.1` | `--host`              | Bind address |
| Parallel slots      | `1`         | `--parallel`          | Simultaneous requests; each slot uses extra RAM |
| Continuous batching | `true`      | `--cont-batching`     | Better throughput with multiple slots |
| Flash Attention     | `false`     | `-fa`                 | Reduces KV-cache memory for large contexts |
| mlock               | `false`     | `--mlock`             | Lock model in RAM, prevents swap |
| Disable mmap        | `false`     | `--no-mmap`           | Load fully into RAM (faster inference, slower start) |
| No warmup           | `false`     | `--no-warmup`         | Skip warmup pass at startup |

### Context

| Field             | Default | Flag              | Description |
|-------------------|---------|-------------------|-------------|
| Context size      | `2048`  | `--ctx-size`      | Token window. `0` = use model's built-in value |
| Batch size        | `512`   | `--batch-size`    | Tokens processed in parallel during prefill |
| μBatch size       | `512`   | `--ubatch-size`   | Physical micro-batch, must be ≤ batch size |
| Disable ctx shift | `false` | `--no-context-shift` | Stop at context limit instead of rolling |

### CPU / Threads

| Field             | Default | Flag               | Description |
|-------------------|---------|--------------------|-------------|
| Inference threads | `-1`    | `--threads`        | CPU threads for generation. `-1` = auto |
| Batch threads     | `-1`    | `--threads-batch`  | CPU threads for prefill. `-1` = same as above |

### GPU

| Field        | Default  | Flag             | Description |
|--------------|----------|------------------|-------------|
| GPU layers   | `0`      | `-ngl`           | Layers offloaded to GPU. `0` = CPU only, `-1` = all. Not sent if 0 |
| Split mode   | *(none)* | `--split-mode`   | Multi-GPU: `none`, `layer`, `row` |
| Main GPU     | *(none)* | `--main-gpu`     | Primary GPU index. Not sent if 0 or empty |
| Tensor split | *(none)* | `--tensor-split` | Per-GPU memory ratios, e.g. `3,1` |

### Sampling (node defaults — overridden by payload fields)

| Field          | Default | Description |
|----------------|---------|-------------|
| Max tokens     | `512`   | Maximum tokens to generate |
| Temperature    | `0.8`   | Randomness. `0` = deterministic |
| Top-K          | `40`    | `0` = disabled |
| Top-P          | `0.95`  | `1.0` = disabled |
| Min-P          | `0.05`  | `0` = disabled |
| Repeat penalty | `1.1`   | `1.0` = no penalty |
| Repeat last N  | `64`    | `0` = disabled |
| Seed           | `-1`    | `-1` = random, not sent |
| Mirostat       | `off`   | Adaptive sampling. v1 or v2 |
| Mirostat τ     | `5.0`   | Target entropy |
| Mirostat η     | `0.1`   | Learning rate |

### Chat / Prompt

| Field          | Description |
|----------------|-------------|
| Chat template  | Leave blank to auto-detect from GGUF metadata. Options: `chatml`, `llama3`, `llama4`, `phi4`, `gemma`, `mistral-v7`, `deepseek3`… |
| System prompt  | In `completion` mode: prepended as `### System:`. In `openai`/`chat` modes: inserted as `{role:"system"}`. Ignored if payload already contains a `messages[]` array with a system message. |

### Debug

| Field         | Description |
|---------------|-------------|
| Enable traces | Forwards every stdout/stderr line from llama-server to the Node-RED debug panel as `[llama-server:port] …`. Also togglable at runtime: `msg.topic = "trace"`, `msg.payload = true/false`. |

---

## Integration with agentic orchestrators (RedClaw…)

The `openai` mode is designed to be a transparent inference brick in an agentic pipeline:

```
[RedClaw / orchestrator]
  │  msg.payload = { model, messages, tools, temperature… }
  ▼
[llama-cpp (openai mode)]
  │  msg.payload  = content string
  │  msg.llamacpp = full API response (inspect choices[0].message for tool_calls)
  │  msg.messages = updated history
  ▼
[RedClaw / orchestrator]
  → detects tool_calls in msg.llamacpp
  → executes tools via skill system
  → appends tool results to msg.messages
  → re-sends to llama-cpp for next turn
```

The node never interprets or acts on `tool_calls` — it forwards raw API output and lets the orchestrator decide what to do next. This keeps the node stateless and reusable across different orchestration strategies.

---

## Multiple models

Each node instance spawns its own `llama-server` process on its own port. Nodes are fully independent.

```
Node A: model = fast-model.gguf   port = 8080  → quick decisions
Node B: model = large-model.gguf  port = 8081  → deep reasoning
```

Total RAM usage = sum of all loaded models. On memory-constrained SBCs, load only what you need.

---

## Tips for edge / SBC devices

- **Threads**: set to physical core count. On a Radxa Dragon Q6A (4× A55 + 4× A78), try `6`.
- **Context**: start small (`512`–`1024`) and increase only if needed.
- **μBatch size**: reduce to `128` if you hit OOM errors during prefill.
- **mlock**: useful if you have enough RAM and want to avoid swap latency.
- **Flash Attention**: reduces KV-cache footprint for large contexts.

---

## Troubleshooting

### Node stays on `loading model…`

Enable **traces** in the node settings, redeploy, and watch the Node-RED debug panel. Look for the startup line llama-server prints. You can also probe manually:

```bash
curl http://127.0.0.1:8080/health
```

### Port already in use

Each node needs a unique port. The badge shows `port XXXX already in use` at deploy time.

### Model not found

Use an absolute path. Node-RED may run as a different user with a different home directory.

### Slow inference

Check `msg.llamacpp.timings` (modes `openai`/`chat`) or the `timing` message on output 2. Common fixes:
- Increase **Threads** (up to physical core count)
- Reduce **Context size**
- Use a more quantised model (Q4_K_M instead of Q8_0)
- Enable **Flash Attention**

---

## License

MIT
