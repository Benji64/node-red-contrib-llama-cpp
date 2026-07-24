const { spawn } = require("child_process");
const http      = require("http");
const net       = require("net");

module.exports = function (RED) {
  function LlamaCppNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // ── Model ──────────────────────────────────────────────
    node.modelPath   = config.modelPath   || "";
    node.llamaBinary = config.llamaBinary || "llama-server";
    node.alias       = config.alias       || "";

    // ── Mode API : "completion" | "openai" | "chat" ────────
    node.mode = config.mode || "completion";

    // ── Cluster role : "standalone" | "master" | "worker" ──
    node.clusterRole = config.clusterRole || "standalone";

    // ── Worker (RPC) ────────────────────────────────────────
    node.rpcBinary = config.rpcBinary || "rpc-server";
    node.rpcHost   = config.rpcHost   || "0.0.0.0";
    node.rpcPort   = parseInt(config.rpcPort) || 50052;
    node.rpcDevice = config.rpcDevice || "";

    // ── Master (RPC) ────────────────────────────────────────
    // Texte brut, un "host:port" par ligne (ou séparés par virgules)
    node.rpcWorkers = config.rpcWorkers || "";

    // ── Server ─────────────────────────────────────────────
    node.serverPort   = parseInt(config.serverPort)  || 8080;
    node.host         = config.host                  || "127.0.0.1";
    node.nSlots       = parseInt(config.nSlots)      || 1;
    node.contBatching = config.contBatching !== false;
    node.noMmap       = config.noMmap     === true;
    node.mlock        = config.mlock      === true;
    node.noWarmup     = config.noWarmup   === true;
    node.flashAttn    = config.flashAttn  === true;

    // ── Context ────────────────────────────────────────────
    node.contextSize = parseInt(config.contextSize) || 2048;
    node.batchSize   = parseInt(config.batchSize)   || 512;
    node.ubatchSize  = parseInt(config.ubatchSize)  || 512;
    node.noCtxShift  = config.noCtxShift === true;

    // ── Threads ────────────────────────────────────────────
    node.threads      = parseInt(config.threads)      || -1;
    node.threadsBatch = parseInt(config.threadsBatch) || -1;

    // ── GPU ────────────────────────────────────────────────
    node.ngl         = parseInt(config.ngl) || 0;
    node.splitMode   = config.splitMode     || "";
    node.mainGpu     = (config.mainGpu !== "" && config.mainGpu !== undefined)
                         ? parseInt(config.mainGpu) : null;
    node.tensorSplit = config.tensorSplit   || "";

    // ── Sampling ───────────────────────────────────────────
    node.temperature   = parseFloat(config.temperature)   || 0.8;
    node.maxTokens     = parseInt(config.maxTokens)       || 512;
    node.topK          = parseInt(config.topK)            || 40;
    node.topP          = parseFloat(config.topP)          || 0.95;
    node.minP          = parseFloat(config.minP)          || 0.05;
    node.repeatPenalty = parseFloat(config.repeatPenalty) || 1.1;
    node.repeatLastN   = parseInt(config.repeatLastN)     || 64;
    node.seed          = parseInt(config.seed)            || -1;
    node.mirostat      = parseInt(config.mirostat)        || 0;
    node.mirostatTau   = parseFloat(config.mirostatTau)   || 5.0;
    node.mirostatEta   = parseFloat(config.mirostatEta)   || 0.1;

    // ── Chat ───────────────────────────────────────────────
    node.chatTemplate = config.chatTemplate || "";
    node.systemPrompt = config.systemPrompt || "";

    // ── Debug ──────────────────────────────────────────────
    node.debugTrace = config.debugTrace === true;

    // ── Internal state ─────────────────────────────────────
    node.serverProcess = null;
    node.serverReady   = false;
    node.pendingQueue  = [];

    // ──────────────────────────────────────────────────────
    // Utilitaires
    // ──────────────────────────────────────────────────────

    function setStatus(color, text) {
      node.status({ fill: color, shape: "dot", text });
    }

    function isPortFree(port, cb) {
      const srv = net.createServer();
      srv.once("error", (e) => cb(e.code === "EADDRINUSE" ? false : null));
      srv.once("listening", () => srv.close(() => cb(true)));
      srv.listen(port, "127.0.0.1");
    }

    // Probe HTTP — utilisé pour llama-server (standalone / master)
    function waitForHttp(port, maxAttempts, cb) {
      let attempts = 0;
      function attempt() {
        attempts++;
        const req = http.request(
          { hostname: "127.0.0.1", port, path: "/health", method: "GET" },
          () => cb(null)
        );
        req.on("error", () => {
          if (attempts >= maxAttempts) cb(new Error(`Pas de réponse après ${maxAttempts} tentatives`));
          else setTimeout(attempt, 500);
        });
        req.end();
      }
      attempt();
    }

    // Probe TCP brut — utilisé pour rpc-server (worker), qui ne parle pas HTTP
    function waitForTcp(host, port, maxAttempts, cb) {
      const probeHost = (host === "0.0.0.0") ? "127.0.0.1" : host;
      let attempts = 0;
      function attempt() {
        attempts++;
        const socket = net.connect({ host: probeHost, port }, () => {
          socket.end();
          cb(null);
        });
        socket.on("error", () => {
          socket.destroy();
          if (attempts >= maxAttempts) cb(new Error(`Pas de réponse après ${maxAttempts} tentatives`));
          else setTimeout(attempt, 500);
        });
      }
      attempt();
    }

    function httpPost(path, body, callback) {
      const bodyStr = JSON.stringify(body);
      const options = {
        hostname: "127.0.0.1",
        port:     node.serverPort,
        path,
        method:   "POST",
        headers: {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(bodyStr)
        }
      };
      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          try { callback(null, JSON.parse(data)); }
          catch (e) { callback(new Error("Parse error: " + e.message)); }
        });
      });
      req.on("error", callback);
      req.write(bodyStr);
      req.end();
    }

    function samplingDefaults() {
      return {
        temperature:    node.temperature,
        max_tokens:     node.maxTokens,
        top_k:          node.topK,
        top_p:          node.topP,
        min_p:          node.minP,
        repeat_penalty: node.repeatPenalty,
        repeat_last_n:  node.repeatLastN,
        ...(node.seed !== -1  && { seed: node.seed }),
        ...(node.mirostat > 0 && {
          mirostat:     node.mirostat,
          mirostat_tau: node.mirostatTau,
          mirostat_eta: node.mirostatEta
        })
      };
    }

    function parsePayload(p) {
      if (typeof p === "string") {
        try { return JSON.parse(p); } catch (e) { /* pas du JSON */ }
      }
      return p;
    }

    // "192.168.1.42:50052\n192.168.1.43:50052" ou "a:1,b:2" → ["a:1","b:2"]
    function parseRpcWorkers(raw) {
      return String(raw || "")
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }

    // ──────────────────────────────────────────────────────
    // Build args — llama-server (standalone & master)
    // ──────────────────────────────────────────────────────

    function buildArgs() {
      const a = [];
      a.push("--model",         node.modelPath);
      a.push("--port",          String(node.serverPort));
      a.push("--host",          node.host);
      a.push("--ctx-size",      String(node.contextSize));
      a.push("--batch-size",    String(node.batchSize));
      a.push("--ubatch-size",   String(node.ubatchSize));
      a.push("--threads",       String(node.threads));
      a.push("--threads-batch", String(node.threadsBatch));
      a.push("--parallel",      String(node.nSlots));
      if (node.ngl > 0)         a.push("-ngl", String(node.ngl));
      if (node.seed !== -1)     a.push("--seed", String(node.seed));
      if (node.alias)           a.push("--alias", node.alias);
      // --jinja nécessaire pour /v1/chat/completions (modes openai et chat)
      if (node.mode !== "completion") a.push("--jinja");
      if (node.chatTemplate)    a.push("--chat-template", node.chatTemplate);
      if (node.flashAttn)       a.push("-fa");
      if (node.mlock)           a.push("--mlock");
      if (node.noMmap)          a.push("--no-mmap");
      if (node.noCtxShift)      a.push("--no-context-shift");
      if (node.noWarmup)        a.push("--no-warmup");
      if (!node.contBatching)   a.push("--no-cont-batching");
      if (node.splitMode)       a.push("--split-mode", node.splitMode);
      if (node.mainGpu !== null && node.mainGpu > 0)
                                a.push("--main-gpu", String(node.mainGpu));
      if (node.tensorSplit)     a.push("--tensor-split", node.tensorSplit);

      // Cluster master : ajoute les workers RPC distants
      if (node.clusterRole === "master") {
        const workers = parseRpcWorkers(node.rpcWorkers);
        if (workers.length > 0) a.push("--rpc", workers.join(","));
      }
      return a;
    }

    // ──────────────────────────────────────────────────────
    // Build args — rpc-server (worker)
    // ──────────────────────────────────────────────────────

    function buildRpcArgs() {
      const a = [];
      a.push("--host", node.rpcHost);
      a.push("-p",     String(node.rpcPort));
      if (node.rpcDevice) a.push("--device", node.rpcDevice);
      return a;
    }

    // ──────────────────────────────────────────────────────
    // Mode completion — /completion
    // ──────────────────────────────────────────────────────

    function handleCompletion(msg) {
      let p = parsePayload(msg.payload);
      let prompt;

      if (p && typeof p === "object" && !Array.isArray(p) && Array.isArray(p.messages)) {
        prompt = p.messages.map((m) => {
          if (m.role === "system")    return `### System:\n${m.content}`;
          if (m.role === "user")      return `### Human:\n${m.content}`;
          if (m.role === "assistant") return `### Assistant:\n${m.content}`;
          return m.content;
        }).join("\n\n") + "\n\n### Assistant:\n";
      } else if (Array.isArray(p)) {
        prompt = p.map((m) => {
          if (m.role === "system")    return `### System:\n${m.content}`;
          if (m.role === "user")      return `### Human:\n${m.content}`;
          if (m.role === "assistant") return `### Assistant:\n${m.content}`;
          return m.content;
        }).join("\n\n") + "\n\n### Assistant:\n";
      } else {
        const text = typeof p === "string" ? p : JSON.stringify(p);
        prompt = node.systemPrompt
          ? `### System:\n${node.systemPrompt}\n\n### Human:\n${text}\n\n### Assistant:\n`
          : `### Human:\n${text}\n\n### Assistant:\n`;
      }

      const sp = (p && typeof p === "object" && !Array.isArray(p)) ? p : {};
      setStatus("blue", "inferring...");

      httpPost("/completion", {
        prompt,
        n_predict:      sp.max_tokens     || sp.n_predict     || node.maxTokens,
        temperature:    sp.temperature    !== undefined ? sp.temperature    : node.temperature,
        top_k:          sp.top_k          !== undefined ? sp.top_k          : node.topK,
        top_p:          sp.top_p          !== undefined ? sp.top_p          : node.topP,
        min_p:          sp.min_p          !== undefined ? sp.min_p          : node.minP,
        repeat_penalty: sp.repeat_penalty !== undefined ? sp.repeat_penalty : node.repeatPenalty,
        repeat_last_n:  sp.repeat_last_n  !== undefined ? sp.repeat_last_n  : node.repeatLastN,
        mirostat:       node.mirostat,
        mirostat_tau:   node.mirostatTau,
        mirostat_eta:   node.mirostatEta,
        stream:         false,
        stop:           ["\n### Human:", "\n### User:"]
      }, (err, parsed) => {
        if (err) { node.error(err.message, msg); setStatus("red", err.message); return; }
        msg.payload  = (parsed.content || "").trim();
        msg.llamacpp = parsed;
        node.send([msg, null]);
        setStatus("green", statusReadyText());
      });
    }

    // ──────────────────────────────────────────────────────
    // Mode openai — proxy pur /v1/chat/completions
    // ──────────────────────────────────────────────────────

    function handleOpenAI(msg) {
      let p = parsePayload(msg.payload);
      let body;

      if (p && typeof p === "object" && !Array.isArray(p) && Array.isArray(p.messages)) {
        body = Object.assign({ model: node.alias || "local", stream: false }, p);
      } else if (Array.isArray(p)) {
        body = { model: node.alias || "local", messages: p, stream: false, ...samplingDefaults() };
      } else {
        const text = typeof p === "string" ? p : JSON.stringify(p);
        const messages = [];
        if (node.systemPrompt) messages.push({ role: "system", content: node.systemPrompt });
        messages.push({ role: "user", content: text });
        body = { model: node.alias || "local", messages, stream: false, ...samplingDefaults() };
      }

      body.stream = false;
      setStatus("blue", "inferring...");

      httpPost("/v1/chat/completions", body, (err, parsed) => {
        if (err) { node.error(err.message, msg); setStatus("red", err.message); return; }
        const choice = parsed.choices && parsed.choices[0];
        if (!choice) { node.error("Réponse vide du serveur", msg); return; }

        msg.payload  = choice.message.content || "";
        msg.llamacpp = parsed;
        msg.messages = body.messages.concat([choice.message]);
        node.send([msg, null]);
        setStatus("green", statusReadyText());
      });
    }

    // ──────────────────────────────────────────────────────
    // Mode chat — /v1/chat/completions + historique multi-tour
    // ──────────────────────────────────────────────────────

    function handleChat(msg) {
      let p = parsePayload(msg.payload);
      let body;

      if (p && typeof p === "object" && !Array.isArray(p) && Array.isArray(p.messages)) {
        body = Object.assign({ model: node.alias || "local", stream: false }, p);
      } else if (Array.isArray(p)) {
        body = { model: node.alias || "local", messages: p, stream: false, ...samplingDefaults() };
      } else {
        const text = typeof p === "string" ? p : JSON.stringify(p);
        const messages = [];
        if (node.systemPrompt) messages.push({ role: "system", content: node.systemPrompt });
        messages.push({ role: "user", content: text });
        body = { model: node.alias || "local", messages, stream: false, ...samplingDefaults() };
      }

      body.stream = false;
      setStatus("blue", "inferring...");

      httpPost("/v1/chat/completions", body, (err, parsed) => {
        if (err) { node.error(err.message, msg); setStatus("red", err.message); return; }
        const choice = parsed.choices && parsed.choices[0];
        if (!choice) { node.error("Réponse vide du serveur", msg); return; }

        msg.payload  = choice.message.content || "";
        msg.llamacpp = parsed;
        msg.messages = body.messages.concat([choice.message]);
        node.send([msg, null]);
        setStatus("green", statusReadyText());
      });
    }

    // ──────────────────────────────────────────────────────
    // Dispatch inférence (standalone / master uniquement)
    // ──────────────────────────────────────────────────────

    function handleMessage(msg) {
      if      (node.mode === "openai") handleOpenAI(msg);
      else if (node.mode === "chat")   handleChat(msg);
      else                             handleCompletion(msg);
    }

    function statusReadyText() {
      if (node.clusterRole === "master") return `ready :${node.serverPort} [master]`;
      return `ready :${node.serverPort}`;
    }

    // ──────────────────────────────────────────────────────
    // Debug info (sortie 2) — branché selon le rôle
    // ──────────────────────────────────────────────────────

    function emitDebugInfo(label) {
      if (node.clusterRole === "worker") {
        const args = buildRpcArgs();
        node.send([null, {
          topic: "debug",
          payload: {
            message:     label || "rpc-server ready",
            clusterRole: "worker",
            command:     node.rpcBinary + " " + args.join(" "),
            args,
            host:        node.rpcHost,
            port:        node.rpcPort
          }
        }]);
        return;
      }

      const args = buildArgs();
      node.send([null, {
        topic: "debug",
        payload: {
          message:          label || "server ready",
          clusterRole:      node.clusterRole,
          mode:             node.mode,
          command:          node.llamaBinary + " " + args.join(" "),
          args,
          samplingDefaults: samplingDefaults(),
          port:             node.serverPort,
          ...(node.clusterRole === "master" && { rpcWorkers: parseRpcWorkers(node.rpcWorkers) })
        }
      }]);
    }

    // ──────────────────────────────────────────────────────
    // Démarrage — standalone / master (llama-server)
    // ──────────────────────────────────────────────────────

    function markReady() {
      if (node.serverReady) return;
      node.serverReady = true;
      setStatus("green", statusReadyText());
      node.log(`llama-server ready [${node.clusterRole}/${node.mode}] :${node.serverPort}`);
      emitDebugInfo("server ready");
      while (node.pendingQueue.length > 0) handleMessage(node.pendingQueue.shift());
    }

    function spawnServer() {
      const args = buildArgs();
      node.log(`Spawn [${node.clusterRole}]: ${node.llamaBinary} ${args.join(" ")}`);
      setStatus("yellow", `loading model :${node.serverPort}...`);

      node.serverProcess = spawn(node.llamaBinary, args, {
        stdio: ["ignore", "pipe", "pipe"]
      });

      let timingBuffer = [];
      let inTiming = false;

      function parseTiming(lines) {
        const r = { raw: lines.join("\n"), port: node.serverPort };
        for (const l of lines) {
          let m = l.match(/prompt eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens.*?([\d.]+)\s*tokens per second/);
          if (m) { r.promptEvalMs = parseFloat(m[1]); r.promptTokens = parseInt(m[2]); r.promptTokensPerSec = parseFloat(m[3]); }
          m = l.match(/^\s*eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens.*?([\d.]+)\s*tokens per second/);
          if (m) { r.evalMs = parseFloat(m[1]); r.evalTokens = parseInt(m[2]); r.evalTokensPerSec = parseFloat(m[3]); }
          m = l.match(/total time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens/);
          if (m) { r.totalMs = parseFloat(m[1]); r.totalTokens = parseInt(m[2]); }
        }
        return r;
      }

      function onData(chunk) {
        const lines = chunk.toString().split("\n");
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          if (node.debugTrace) node.warn(`[llama-server:${node.serverPort}] ${t}`);

          if (t.includes("print_timing")) { inTiming = true; timingBuffer = [t]; continue; }
          if (inTiming) {
            timingBuffer.push(t);
            if (t.includes("all slots are idle")) {
              node.send([null, { topic: "timing", payload: parseTiming(timingBuffer) }]);
              timingBuffer = []; inTiming = false;
            }
            continue;
          }

          if (!node.serverReady && (
            t.includes("server is listening") ||
            t.includes("HTTP server listening") ||
            t.includes("all slots are idle") ||
            t.includes("starting the main loop") ||
            t.includes("llama server listening") ||
            t.includes("listening on") ||
            t.includes(String(node.serverPort))
          )) {
            waitForHttp(node.serverPort, 20, (err) => {
              if (err) node.warn("HTTP probe failed: " + err.message);
              else markReady();
            });
          }
        }
      }

      node.serverProcess.stdout.on("data", onData);
      node.serverProcess.stderr.on("data", onData);
      node.serverProcess.on("error", (err) => {
        node.error("Spawn failed (" + node.llamaBinary + "): " + err.message);
        setStatus("red", "spawn error");
        node.serverProcess = null;
        node.serverReady   = false;
      });
      node.serverProcess.on("close", (code) => {
        node.log(`llama-server :${node.serverPort} exited (${code})`);
        node.serverProcess = null;
        node.serverReady   = false;
        if (code !== null && code !== 0) setStatus("red", `exited (${code})`);
      });
    }

    // ──────────────────────────────────────────────────────
    // Démarrage — worker (rpc-server)
    // ──────────────────────────────────────────────────────

    function markReadyWorker() {
      if (node.serverReady) return;
      node.serverReady = true;
      setStatus("green", `RPC ready :${node.rpcPort}`);
      node.log(`rpc-server ready on ${node.rpcHost}:${node.rpcPort}`);
      emitDebugInfo("rpc-server ready");
      // Un worker ne traite jamais de messages d'inférence : pas de drain de queue.
    }

    function spawnWorker() {
      const args = buildRpcArgs();
      node.log(`Spawn [worker]: ${node.rpcBinary} ${args.join(" ")}`);
      setStatus("yellow", `starting RPC :${node.rpcPort}...`);

      node.serverProcess = spawn(node.rpcBinary, args, {
        stdio: ["ignore", "pipe", "pipe"]
      });

      function onData(chunk) {
        const lines = chunk.toString().split("\n");
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          if (node.debugTrace) node.warn(`[rpc-server:${node.rpcPort}] ${t}`);

          if (!node.serverReady && t.includes("Starting RPC server")) {
            waitForTcp(node.rpcHost, node.rpcPort, 20, (err) => {
              if (err) node.warn("TCP probe failed: " + err.message);
              else markReadyWorker();
            });
          }
        }
      }

      node.serverProcess.stdout.on("data", onData);
      node.serverProcess.stderr.on("data", onData);
      node.serverProcess.on("error", (err) => {
        node.error("Spawn failed (" + node.rpcBinary + "): " + err.message);
        setStatus("red", "spawn error");
        node.serverProcess = null;
        node.serverReady   = false;
      });
      node.serverProcess.on("close", (code) => {
        node.log(`rpc-server :${node.rpcPort} exited (${code})`);
        node.serverProcess = null;
        node.serverReady   = false;
        if (code !== null && code !== 0) setStatus("red", `exited (${code})`);
      });
    }

    // ──────────────────────────────────────────────────────
    // Démarrage — dispatch par rôle
    // ──────────────────────────────────────────────────────

    function startServer() {
      if (node.clusterRole === "worker") {
        isPortFree(node.rpcPort, (free) => {
          if (free === false) {
            const m = `port RPC ${node.rpcPort} déjà utilisé`;
            node.error("llama-cpp (worker): " + m);
            setStatus("red", m);
            return;
          }
          spawnWorker();
        });
        return;
      }

      // standalone / master : nécessite un modèle local
      if (!node.modelPath) {
        setStatus("red", "no model path");
        node.error("llama-cpp: modelPath non défini.");
        return;
      }
      if (node.clusterRole === "master" && parseRpcWorkers(node.rpcWorkers).length === 0) {
        node.warn("llama-cpp (master): aucun worker RPC configuré — tourne uniquement sur les ressources locales.");
      }
      isPortFree(node.serverPort, (free) => {
        if (free === false) {
          const m = `port ${node.serverPort} déjà utilisé`;
          node.error("llama-cpp: " + m);
          setStatus("red", m);
          return;
        }
        spawnServer();
      });
    }

    // ──────────────────────────────────────────────────────
    // Input / Close
    // ──────────────────────────────────────────────────────

    node.on("input", (msg) => {
      if (msg.topic === "debug") { emitDebugInfo("manual debug"); return; }
      if (msg.topic === "trace") {
        node.debugTrace = !!msg.payload;
        node.log(`trace ${node.debugTrace ? "ON" : "OFF"}`);
        return;
      }

      if (node.clusterRole === "worker") {
        node.warn("llama-cpp (worker): ce nœud n'exécute pas d'inférence, il expose uniquement ses ressources RPC à un nœud master. Message ignoré.");
        return;
      }

      if (!node.serverReady) {
        node.pendingQueue.push(msg);
        if (!node.serverProcess) startServer();
        else setStatus("yellow", `queued (${node.pendingQueue.length}) :${node.serverPort}`);
        return;
      }
      handleMessage(msg);
    });

    node.on("close", (done) => {
      node.serverReady  = false;
      node.pendingQueue = [];
      if (node.serverProcess) {
        node.serverProcess.kill("SIGTERM");
        const t = setTimeout(() => {
          if (node.serverProcess) node.serverProcess.kill("SIGKILL");
        }, 3000);
        node.serverProcess.on("close", () => {
          clearTimeout(t);
          node.serverProcess = null;
          done();
        });
      } else {
        done();
      }
    });

    // Démarrage immédiat au deploy, quel que soit le rôle
    startServer();
  }

  RED.nodes.registerType("llama-cpp", LlamaCppNode);
};
