[README.md](https://github.com/user-attachments/files/26741266/README.md)
# node-red-contrib-llama-cpp

[![npm version](https://img.shields.io/npm/v/node-red-contrib-llama-cpp.svg)](https://www.npmjs.com/package/node-red-contrib-llama-cpp)
[![Node-RED](https://img.shields.io/badge/Node--RED-%3E%3D3.0-red)](https://nodered.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Node-RED node that runs **llama-server** ([llama.cpp](https://github.com/ggml-org/llama.cpp)) as a child process and exposes on-device LLM inference directly in your flows — no cloud, no Docker, no external service required.

Designed for edge devices and SBCs (Raspberry Pi, Radxa, Orange Pi…), but works on any machine where llama.cpp runs.

---

## Features

- 🔁 **Three inference modes** — raw completion, OpenAI-compatible chat, MCP tool-call orchestration
- ⚡ **Automatic lifecycle** — spawns `llama-server` on deploy, queues messages during model load, kills cleanly on redeploy
- 🔌 **Multi-model** — each node instance manages its own server on its own port
- 📊 **Performance metrics** — timing stats (tokens/sec, eval time…) parsed from logs and emitted on output 2
- 🛠️ **Full parameter coverage** — all llama-server flags exposed in the UI
- 🔍 **Live trace toggle** — enable/disable server logs at runtime without redeploying

---

## Prerequisites

- **Node-RED** ≥ 3.0
- **llama.cpp** compiled and `llama-server` accessible (in `$PATH` or absolute path configured in the node)
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
# On your machine
git clone https://github.com/YOUR_USERNAME/node-red-contrib-llama-cpp
cd node-red-contrib-llama-cpp

# Copy to Node-RED
cp llama-cpp.js llama-cpp.html package.json \
   ~/.node-red/node_modules/node-red-contrib-llama-cpp/

# Restart Node-RED
sudo systemctl restart nodered
```

---

## Quick Start

1. Drop a **llama.cpp** node onto your flow
2. Set **Model path** to your `.gguf` file
3. Set **Port** (default `8080`) — each node needs a unique port
4. Set **Threads** to match your CPU core count (or leave `-1` for auto-detect)
5. Deploy — the node spawns `llama-server` and shows `loading model…` then `ready :8080`
6. Connect an **inject** node with a string payload and wire to the input

---

## Modes

### `completion` (default)

Uses the `/completion` endpoint. Best for simple, stateless inference.

**Input:**
```
msg.payload = "What is the temperature in the living room?"
```

**Output 1:**
```
msg.payload = "The living room temperature is 21°C."
```

---

### `chat`

Uses `/v1/chat/completions` (OpenAI-compatible format). Enables `--jinja` automatically.

- Supports multi-turn conversations via a `messages[]` array
- The llama-server port is directly accessible by any OpenAI/MCP-compatible client

**Input — string (auto-wrapped):**
```javascript
msg.payload = "Turn off the bedroom lights"
```

**Input — messages array (multi-turn):**
```javascript
msg.payload = [
  { role: "system",    content: "You are a smart home assistant." },
  { role: "user",      content: "What did I ask before?" },
  { role: "assistant", content: "You asked about the bedroom lights." },
  { role: "user",      content: "Turn them off." }
]
```

**Output 1:**
```javascript
msg.payload  = "Done, bedroom lights are off."
msg.messages = [ /* full conversation history including this reply */ ]
```

Pass `msg.messages` back as `msg.payload` on the next turn to continue the conversation.

---

### `mcp-client`

Orchestrates a full tool-call loop. The node handles the back-and-forth between the LLM and your tools automatically until a final text response is produced.

**Input:**
```javascript
msg.payload = "What is the temperature in the salon?"
msg.tools = [{
  type: "function",
  function: {
    name: "get_sensor",
    description: "Read a sensor value",
    parameters: {
      type: "object",
      properties: {
        sensor_id: { type: "string", description: "Sensor identifier" }
      },
      required: ["sensor_id"]
    }
  }
}]
```

**Output 2 — tool call request:**
```javascript
msg.topic   = "tool_call"
msg.payload = {
  taskId:     "1714000000000-abc",
  tool_calls: [{
    id:   "call_xyz",
    type: "function",
    function: {
      name:      "get_sensor",
      arguments: "{\"sensor_id\": \"salon\"}"
    }
  }]
}
```

**Send tool result back to the node input:**
```javascript
msg.topic   = "tool_result"
msg.payload = {
  taskId:  "1714000000000-abc",   // same taskId received
  results: [{
    tool_call_id: "call_xyz",
    content:      "22.5"
  }]
}
```

The node re-runs the LLM with the tool result and repeats until the model returns a text response on **output 1**.

**Example flow:**
```
[inject: prompt + tools]
  → [llama-cpp (mcp-client)]
       output 1 → [handle final response]
       output 2 → [switch on msg.topic]
                    "tool_call" → [execute tool]
                                    → [build tool_result msg]
                                    → [llama-cpp input]
                    "timing"    → [dashboard]
                    "debug"     → [debug node]
```

---

## Output 2 — timing, debug, tool_call

All non-inference messages are emitted on output 2. Use a **Switch** node on `msg.topic` to route them.

### `timing` — after every inference

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

Send `msg.topic = "debug"` to the node input at any time to trigger this without running inference.

```javascript
{
  topic: "debug",
  payload: {
    message:         "server ready",
    mode:            "chat",
    command:         "llama-server --model /path/model.gguf --port 8082 --jinja …",
    args:            [ … ],
    samplingDefaults: { temperature: 0.8, top_k: 40, … },
    port:            8082
  }
}
```

---

## Control messages

These topics are handled by the node without triggering inference:

| `msg.topic`   | `msg.payload`       | Effect                                                    |
|---------------|---------------------|-----------------------------------------------------------|
| `"debug"`     | *(ignored)*         | Emits full config on output 2                             |
| `"trace"`     | `true` / `false`    | Enables/disables llama-server log forwarding to Node-RED debug panel |
| `"tool_result"` | `{ taskId, results[] }` | Feeds tool results back into an active mcp-client loop |

---

## Configuration Reference

### Model

| Field        | Default         | Description |
|--------------|-----------------|-------------|
| Model path   | *(required)*    | Absolute path to the `.gguf` model file |
| Binary       | `llama-server`  | Name or full path of the executable |
| Alias        | *(empty)*       | Model name exposed in the API (`--alias`) |

### Server

| Field                  | Default      | Flag                  | Description |
|------------------------|--------------|-----------------------|-------------|
| Port                   | `8080`       | `--port`              | Each node needs a unique port |
| Host                   | `127.0.0.1`  | `--host`              | Bind address |
| Parallel slots (-np)   | `1`          | `--parallel`          | Simultaneous requests; each slot uses RAM |
| Continuous batching    | `true`       | `--cont-batching`     | Better throughput with multiple slots |
| Flash Attention        | `false`      | `-fa`                 | Reduces KV-cache memory for large contexts |
| mlock                  | `false`      | `--mlock`             | Lock model in RAM, prevents swap |
| Disable mmap           | `false`      | `--no-mmap`           | Load fully into RAM (faster inference, slower start) |
| No warmup              | `false`      | `--no-warmup`         | Skip warmup pass (faster start, slower first token) |

### Context

| Field             | Default | Flag            | Description |
|-------------------|---------|-----------------|-------------|
| Context size      | `2048`  | `--ctx-size`    | Token window size. `0` = use model's built-in value |
| Batch size        | `512`   | `--batch-size`  | Tokens processed in parallel during prompt prefill |
| μBatch size       | `512`   | `--ubatch-size` | Physical micro-batch size, must be ≤ batch size |
| Disable ctx shift | `false` | `--no-context-shift` | Stop generating when context is full instead of rolling |

### CPU / Threads

| Field              | Default | Flag               | Description |
|--------------------|---------|--------------------|-------------|
| Inference threads  | `-1`    | `--threads`        | CPU threads for token generation. `-1` = auto |
| Batch threads      | `-1`    | `--threads-batch`  | CPU threads for prompt prefill. `-1` = same as inference |

### GPU

| Field        | Default | Flag             | Description |
|--------------|---------|------------------|-------------|
| GPU layers   | `0`     | `-ngl`           | Layers offloaded to GPU. `0` = CPU only, `-1` = all. Not sent if 0 |
| Split mode   | *(none)*| `--split-mode`   | Multi-GPU split strategy: `none`, `layer`, `row` |
| Main GPU     | *(none)*| `--main-gpu`     | Primary GPU index. Not sent if 0 or empty |
| Tensor split | *(none)*| `--tensor-split`  | Per-GPU memory ratios, e.g. `3,1` |

### Sampling

| Field          | Default | Description |
|----------------|---------|-------------|
| Max tokens     | `512`   | Maximum tokens to generate (`n_predict`) |
| Temperature    | `0.8`   | Randomness. `0` = deterministic, `>1` = very random |
| Top-K          | `40`    | Limit selection to K most probable tokens. `0` = disabled |
| Top-P          | `0.95`  | Nucleus sampling threshold. `1.0` = disabled |
| Min-P          | `0.05`  | Filter tokens below P × max_prob. `0` = disabled |
| Repeat penalty | `1.1`   | Penalise repeated tokens. `1.0` = no penalty |
| Repeat last N  | `64`    | Token window for repeat penalty. `0` = disabled |
| Seed           | `-1`    | RNG seed for reproducibility. `-1` = random, not sent |
| Mirostat       | `off`   | Adaptive sampling targeting fixed perplexity. v1 or v2 |
| Mirostat τ     | `5.0`   | Target entropy (higher = more diverse) |
| Mirostat η     | `0.1`   | Learning rate (how fast it adapts) |

### Chat / Prompt

| Field          | Description |
|----------------|-------------|
| Chat template  | Model's conversation format. Leave blank to auto-detect from GGUF metadata. Available: `chatml`, `llama3`, `llama2`, `llama4`, `phi3`, `phi4`, `gemma`, `mistral-v3`, `mistral-v7`, `deepseek3`, `command-r`, `vicuna`, `zephyr`… |
| System prompt  | Injected at the start of each conversation. In `completion` mode: prepended as `### System:`. In `chat`/`mcp-client` modes: inserted as `{role: "system"}`. Ignored if `msg.payload` is already a `messages[]` array. |

### Debug

| Field           | Description |
|-----------------|-------------|
| Enable traces   | Forward every stdout/stderr line from llama-server to the Node-RED debug panel as `[llama-server:port] …`. Also controllable at runtime via `msg.topic = "trace"`. |

---

## Tips for edge / SBC devices

- **Threads**: set to physical core count, not hyperthreads. On a Radxa Dragon Q6A (4× A55 + 4× A78), try `6`.
- **Context**: smaller context = less RAM and faster prefill. Start with `512`-`1024` and increase if needed.
- **μBatch size**: reduce to `128` if you get OOM errors during prefill.
- **mlock**: useful if you have enough RAM and want to avoid swap latency on first inference after idle.
- **Flash Attention**: reduces KV-cache size significantly for larger contexts — enable if your build supports it.
- **Multi-model**: use one node per model on different ports. Total RAM = sum of all loaded models.

---

## Troubleshooting

### Node stays on `loading model…`

Enable the **trace** checkbox in the node settings, redeploy, and check the Node-RED debug panel. Look for the exact startup line llama-server prints — if it doesn't match any known pattern, open an issue with the line.

You can also manually probe the server:
```bash
curl http://127.0.0.1:8080/health
```

### Port already in use

Each node needs a unique port. The node detects this at deploy time and shows `port XXXX already in use` in the badge.

### Model not found

Use an absolute path (not `~/models/…`). Node-RED may run as a different user with a different home directory.

### Slow inference

Check the `timing` message on output 2 — it shows `tokens/sec` for both prompt eval and generation. Common fixes:
- Increase **Threads** (up to physical core count)
- Reduce **Context size**
- Use a more quantized model (Q4_K_M instead of Q8_0)
- Enable **Flash Attention** if available

---

## License

MIT
