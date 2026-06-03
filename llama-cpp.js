const { spawn } = require("child_process");
const http      = require("http");
const net       = require("net");

module.exports = function (RED) {
  function LlamaCppNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // ── Model ──────────────────────────────────────────────
    node.modelPath    = config.modelPath   || "";
    node.llamaBinary  = config.llamaBinary || "llama-server";
    node.alias        = config.alias       || "";

    // ── Mode ───────────────────────────────────────────────
    // "completion" | "chat" | "mcp-client"
    node.mode         = config.mode         || "completion";
    // autoToolLoop : true  = le nœud gère la boucle outil automatiquement
    //                false = le nœud émet tool_call et s'arrête, le flow prend la main
    node.autoToolLoop = config.autoToolLoop !== false; // défaut : true

    // ── Server ─────────────────────────────────────────────
    node.serverPort   = parseInt(config.serverPort)  || 8080;
    node.host         = config.host                  || "127.0.0.1";
    node.nSlots       = parseInt(config.nSlots)      || 1;
    node.contBatching = config.contBatching !== false;
    node.noMmap       = config.noMmap       === true;
    node.mlock        = config.mlock        === true;
    node.noWarmup     = config.noWarmup     === true;
    node.flashAttn    = config.flashAttn    === true;

    // ── Context ────────────────────────────────────────────
    node.contextSize  = parseInt(config.contextSize) || 2048;
    node.batchSize    = parseInt(config.batchSize)   || 512;
    node.ubatchSize   = parseInt(config.ubatchSize)  || 512;
    node.noCtxShift   = config.noCtxShift === true;

    // ── Threads ────────────────────────────────────────────
    node.threads      = parseInt(config.threads)      || -1;
    node.threadsBatch = parseInt(config.threadsBatch) || -1;

    // ── GPU ────────────────────────────────────────────────
    node.ngl         = parseInt(config.ngl) || 0;
    node.splitMode   = config.splitMode   || "";
    node.mainGpu     = (config.mainGpu !== "" && config.mainGpu !== undefined)
                         ? parseInt(config.mainGpu) : null;
    node.tensorSplit = config.tensorSplit || "";

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
    node.serverProcess  = null;
    node.serverReady    = false;
    node.pendingQueue   = [];
    // Mode mcp-client: conversations en attente de tool_result
    node.pendingToolCalls = {}; // taskId → { msg, messages }

    // ──────────────────────────────────────────────────────
    // Helpers
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

    function waitForHttp(port, maxAttempts, cb) {
      let attempts = 0;
      function attempt() {
        attempts++;
        const req = http.request(
          { hostname: "127.0.0.1", port, path: "/health", method: "GET" },
          () => cb(null)
        );
        req.on("error", () => {
          if (attempts >= maxAttempts) cb(new Error(`No response after ${maxAttempts} attempts`));
          else setTimeout(attempt, 500);
        });
        req.end();
      }
      attempt();
    }

    // ──────────────────────────────────────────────────────
    // Build spawn args
    // ──────────────────────────────────────────────────────

    function buildArgs() {
      const a = [];
      a.push("--model",        node.modelPath);
      a.push("--port",         String(node.serverPort));
      a.push("--host",         node.host);
      a.push("--ctx-size",     String(node.contextSize));
      a.push("--batch-size",   String(node.batchSize));
      a.push("--ubatch-size",  String(node.ubatchSize));
      a.push("--threads",      String(node.threads));
      a.push("--threads-batch", String(node.threadsBatch));
      a.push("--parallel",     String(node.nSlots));
      if (node.ngl > 0)        a.push("-ngl", String(node.ngl));
      if (node.seed !== -1)    a.push("--seed", String(node.seed));
      if (node.alias)          a.push("--alias", node.alias);
      // --jinja requis pour chat, mcp-client et openai
      if (node.mode !== "completion") a.push("--jinja");
      if (node.chatTemplate)   a.push("--chat-template", node.chatTemplate);
      if (node.flashAttn)      a.push("-fa");
      if (node.mlock)          a.push("--mlock");
      if (node.noMmap)         a.push("--no-mmap");
      if (node.noCtxShift)     a.push("--no-context-shift");
      if (node.noWarmup)       a.push("--no-warmup");
      if (!node.contBatching)  a.push("--no-cont-batching");
      if (node.splitMode)      a.push("--split-mode", node.splitMode);
      if (node.mainGpu !== null && node.mainGpu > 0)
                               a.push("--main-gpu", String(node.mainGpu));
      if (node.tensorSplit)    a.push("--tensor-split", node.tensorSplit);
      return a;
    }

    // ──────────────────────────────────────────────────────
    // HTTP helpers
    // ──────────────────────────────────────────────────────

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

    function samplingParams() {
      return {
        temperature:    node.temperature,
        max_tokens:     node.maxTokens,
        top_k:          node.topK,
        top_p:          node.topP,
        min_p:          node.minP,
        repeat_penalty: node.repeatPenalty,
        repeat_last_n:  node.repeatLastN,
        seed:           node.seed !== -1 ? node.seed : undefined,
        mirostat:       node.mirostat || undefined,
        mirostat_tau:   node.mirostat ? node.mirostatTau : undefined,
        mirostat_eta:   node.mirostat ? node.mirostatEta : undefined,
      };
    }

    // ──────────────────────────────────────────────────────
    // Mode 1 : /completion — proxy pur, une requête → une réponse, pas de boucle
    // ──────────────────────────────────────────────────────

    function handleCompletion(msg) {
      let p = msg.payload;

      // Auto-parse si le payload est une string JSON
      if (typeof p === "string") {
        try { p = JSON.parse(p); } catch (e) { /* pas du JSON, on garde la string */ }
      }

      let prompt;

      // Objet OpenAI { messages: [...] } → construire le prompt depuis l'historique
      if (p && typeof p === "object" && !Array.isArray(p) && Array.isArray(p.messages)) {
        prompt = p.messages.map((m) => {
          if (m.role === "system")    return `### System:\n${m.content}`;
          if (m.role === "user")      return `### Human:\n${m.content}`;
          if (m.role === "assistant") return `### Assistant:\n${m.content}`;
          return m.content;
        }).join("\n\n") + "\n\n### Assistant:\n";

      // Tableau messages[] direct
      } else if (Array.isArray(p)) {
        prompt = p.map((m) => {
          if (m.role === "system")    return `### System:\n${m.content}`;
          if (m.role === "user")      return `### Human:\n${m.content}`;
          if (m.role === "assistant") return `### Assistant:\n${m.content}`;
          return m.content;
        }).join("\n\n") + "\n\n### Assistant:\n";

      // String simple
      } else {
        const text = typeof p === "string" ? p : JSON.stringify(p);
        prompt = node.systemPrompt
          ? `### System:\n${node.systemPrompt}\n\n### Human:\n${text}\n\n### Assistant:\n`
          : `### Human:\n${text}\n\n### Assistant:\n`;
      }

      // Sampling : les valeurs du payload ont priorité sur les défauts du nœud
      const sp = (p && typeof p === "object" && !Array.isArray(p)) ? p : {};

      setStatus("blue", "inferring...");
      httpPost("/completion", {
        prompt,
        n_predict:      sp.max_tokens     || sp.n_predict     || node.maxTokens,
        temperature:    sp.temperature    !== undefined        ? sp.temperature    : node.temperature,
        top_k:          sp.top_k          !== undefined        ? sp.top_k          : node.topK,
        top_p:          sp.top_p          !== undefined        ? sp.top_p          : node.topP,
        min_p:          sp.min_p          !== undefined        ? sp.min_p          : node.minP,
        repeat_penalty: sp.repeat_penalty !== undefined        ? sp.repeat_penalty : node.repeatPenalty,
        repeat_last_n:  sp.repeat_last_n  !== undefined        ? sp.repeat_last_n  : node.repeatLastN,
        mirostat:       node.mirostat,
        mirostat_tau:   node.mirostatTau,
        mirostat_eta:   node.mirostatEta,
        stream:         false,
        stop:           ["\n### Human:", "\n### User:"]
      }, (err, parsed) => {
        if (err) { node.error(err.message, msg); setStatus("red", err.message); return; }
        // Réponse unique — on retourne le texte et c'est tout
        msg.payload = (parsed.content || "").trim();
        node.send([msg, null]);
        setStatus("green", `ready :${node.serverPort}`);
      });
    }

    // ──────────────────────────────────────────────────────
    // Mode 2 : /v1/chat/completions (chat simple)
    // ──────────────────────────────────────────────────────

    // Construit le body final pour /v1/chat/completions.
    // Si msg.payload est déjà un objet OpenAI complet (avec messages[]),
    // on le passe tel quel en complétant seulement les champs absents
    // avec les valeurs du nœud. Les champs du payload ont priorité.
    function buildChatBody(msg) {
      let p = msg.payload;

      // Auto-parse si le payload est une string JSON
      if (typeof p === "string") {
        try { p = JSON.parse(p); } catch (e) { /* pas du JSON, on garde la string */ }
      }

      // Cas 1 — payload est un objet OpenAI complet ou partiel : { messages, model?, temperature?, … }
      if (p && typeof p === "object" && !Array.isArray(p) && Array.isArray(p.messages)) {
        return Object.assign({
          model:          node.alias || "local",
          stream:         false,
          ...samplingParams()
        }, p); // les champs du payload écrasent les défauts du nœud
      }

      // Cas 2 — payload est un tableau messages[]
      let messages;
      if (Array.isArray(p)) {
        messages = p;
      } else if (typeof p === "string") {
        messages = [];
        if (node.systemPrompt) messages.push({ role: "system", content: node.systemPrompt });
        messages.push({ role: "user", content: p });
      } else {
        return null; // erreur gérée par l'appelant
      }

      return {
        model:    node.alias || "local",
        messages,
        stream:   false,
        ...samplingParams()
      };
    }

    function handleChat(msg) {
      const body = buildChatBody(msg);
      if (!body) {
        node.error("Mode chat: msg.payload doit être une string, un tableau messages[], ou un objet { messages: [] }", msg);
        return;
      }

      setStatus("blue", "inferring...");
      httpPost("/v1/chat/completions", body, (err, parsed) => {
        if (err) { node.error(err.message, msg); setStatus("red", err.message); return; }
        const choice = parsed.choices && parsed.choices[0];
        if (!choice) { node.error("Réponse vide du serveur", msg); return; }

        // Retourner le message complet (content + tool_calls éventuels)
        // Le flow externe (redclaw) gère la suite — le nœud ne boucle JAMAIS
        msg.payload  = choice.message;
        msg.messages = body.messages.concat([choice.message]);
        node.send([msg, null]);
        setStatus("green", `ready :${node.serverPort}`);
      });
    }

    // ──────────────────────────────────────────────────────
    // Mode 3 : client MCP — boucle d'appels d'outils
    // ──────────────────────────────────────────────────────

    function handleMcpClient(msg) {
      let p = msg.payload;

      // Auto-parse si le payload est une string JSON
      if (typeof p === "string") {
        try { p = JSON.parse(p); } catch (e) { /* pas du JSON, on garde la string */ }
      }

      let messages, tools;

      // Cas 1 — objet OpenAI complet : { messages[], tools?, model?, … }
      if (p && typeof p === "object" && !Array.isArray(p) && Array.isArray(p.messages)) {
        messages = p.messages;
        tools    = p.tools || msg.tools || [];
      }
      // Cas 2 — tableau messages[]
      else if (Array.isArray(p)) {
        messages = p;
        tools    = msg.tools || [];
      }
      // Cas 3 — string
      else if (typeof p === "string") {
        messages = [];
        if (node.systemPrompt) messages.push({ role: "system", content: node.systemPrompt });
        messages.push({ role: "user", content: p });
        tools = msg.tools || [];
      }
      else {
        node.error("Mode mcp-client: msg.payload doit être une string, un tableau messages[], ou un objet { messages: [] }", msg);
        return;
      }

      runMcpLoop(msg, messages, tools);
    }

    function runMcpLoop(originalMsg, messages, tools) {
      setStatus("blue", "inferring...");

      const body = {
        model:    originalMsg.alias || node.alias || "local",
        messages,
        ...samplingParams(),
        stream: false
      };
      if (tools.length > 0) body.tools = tools;

      httpPost("/v1/chat/completions", body, (err, parsed) => {
        if (err) {
          node.error(err.message, originalMsg);
          setStatus("red", err.message);
          return;
        }

        const choice = parsed.choices && parsed.choices[0];
        if (!choice) { node.error("Réponse vide du serveur", originalMsg); return; }

        const assistantMsg = choice.message;

        // ── Appels d'outils détectés
        if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
          const taskId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          const updatedMessages = messages.concat([assistantMsg]);

          if (node.autoToolLoop) {
            // ── Mode automatique : stocker l'état et attendre tool_result
            node.pendingToolCalls[taskId] = {
              originalMsg,
              messages: updatedMessages,
              tools,
              pendingCount: assistantMsg.tool_calls.length,
              toolResults:  []
            };
            node.send([null, {
              topic:   "tool_call",
              payload: { taskId, tool_calls: assistantMsg.tool_calls }
            }]);
            setStatus("yellow", `waiting tool results (${assistantMsg.tool_calls.length})`);

          } else {
            // ── Mode manuel : émettre et s'arrêter — le flow reprend la main
            // msg.messages contient l'historique complet pour que le flow
            // puisse construire le prochain tour et renvoyer au nœud
            originalMsg.messages = updatedMessages;
            node.send([null, {
              topic:   "tool_call",
              payload: {
                taskId,
                tool_calls: assistantMsg.tool_calls,
                messages:   updatedMessages,   // historique complet pour le flow
                tools                          // outils originaux, pour les passer au tour suivant
              }
            }]);
            setStatus("green", `ready :${node.serverPort}`);
          }
          return;
        }

        // ── Réponse texte finale
        originalMsg.payload  = assistantMsg.content || "";
        originalMsg.messages = messages.concat([assistantMsg]);
        node.send([originalMsg, null]);
        setStatus("green", `ready :${node.serverPort}`);
      });
    }

    // Réception d'un résultat d'outil (msg.topic = "tool_result")
    function handleToolResult(msg) {
      const taskId = msg.payload && msg.payload.taskId;
      if (!taskId || !node.pendingToolCalls[taskId]) {
        node.warn("tool_result reçu mais taskId inconnu : " + taskId);
        return;
      }
      const state = node.pendingToolCalls[taskId];

      // Ajouter les résultats à la conversation
      const results = Array.isArray(msg.payload.results)
        ? msg.payload.results : [msg.payload.results];

      results.forEach((r) => {
        state.messages.push({
          role:         "tool",
          tool_call_id: r.tool_call_id,
          content:      typeof r.content === "string" ? r.content : JSON.stringify(r.content)
        });
        state.toolResults.push(r);
      });

      state.pendingCount -= results.length;

      // Si tous les résultats sont reçus → relancer la boucle
      if (state.pendingCount <= 0) {
        delete node.pendingToolCalls[taskId];
        runMcpLoop(state.originalMsg, state.messages, state.tools);
      } else {
        setStatus("yellow", `waiting tool results (${state.pendingCount})`);
      }
    }

    // ──────────────────────────────────────────────────────
    // Dispatch entrée
    // ──────────────────────────────────────────────────────

    function handleMessage(msg) {
      if      (node.mode === "chat")       handleChat(msg);
      else if (node.mode === "mcp-client") handleMcpClient(msg);
      else if (node.mode === "openai")     handleOpenAIProxy(msg);
      else                                 handleCompletion(msg);
    }

    // ──────────────────────────────────────────────────────
    // Mode 4 : proxy OpenAI — pass-through pur
    // Modèle chargé une fois au deploy, jamais rechargé.
    // msg.payload = objet requête OpenAI complet → forwardé tel quel
    // msg.payload = string ou messages[] → wrappé minimalement
    // Sortie 1 : msg.payload = message complet { role, content, tool_calls? }
    // ──────────────────────────────────────────────────────

    function handleOpenAIProxy(msg) {
      let p = msg.payload;

      // Auto-parse si le payload est une string JSON
      if (typeof p === "string") {
        try { p = JSON.parse(p); } catch (e) { /* pas du JSON, on garde la string */ }
      }

      let body;

      // Cas 1 — objet complet { messages, temperature, max_tokens, … } → passé tel quel
      if (p && typeof p === "object" && !Array.isArray(p) && Array.isArray(p.messages)) {
        body = Object.assign({ model: node.alias || "local", stream: false }, p);

      // Cas 2 — tableau messages[]
      } else if (Array.isArray(p)) {
        body = { model: node.alias || "local", messages: p, stream: false, ...samplingParams() };

      // Cas 3 — string simple
      } else if (typeof p === "string") {
        const messages = [];
        if (node.systemPrompt) messages.push({ role: "system", content: node.systemPrompt });
        messages.push({ role: "user", content: p });
        body = { model: node.alias || "local", messages, stream: false, ...samplingParams() };

      } else {
        node.error("Mode openai: msg.payload doit être un objet { messages[] }, un tableau, ou une string", msg);
        return;
      }

      // Forcer stream: false — on ne gère pas le streaming dans Node-RED
      body.stream = false;

      setStatus("blue", "inferring...");
      httpPost("/v1/chat/completions", body, (err, parsed) => {
        if (err) { node.error(err.message, msg); setStatus("red", err.message); return; }
        const choice = parsed.choices && parsed.choices[0];
        if (!choice) { node.error("Réponse vide du serveur", msg); return; }

        // msg.payload   = contenu texte de la réponse (usage direct dans le flow)
        // msg.llamacpp  = réponse API complète (choices, usage, timings, model…)
        // msg.messages  = historique complet pour le tour suivant
        msg.payload   = choice.message.content || "";
        msg.llamacpp  = parsed;
        msg.messages  = body.messages.concat([choice.message]);
        node.send([msg, null]);
        setStatus("green", `ready :${node.serverPort}`);
      });
    }

    // ──────────────────────────────────────────────────────
    // Emitter debug (sortie 2)
    // ──────────────────────────────────────────────────────

    function emitDebugInfo(label) {
      const args = buildArgs();
      node.send([null, {
        topic:   "debug",
        payload: {
          message:          label || "server ready",
          mode:             node.mode,
          command:          node.llamaBinary + " " + args.join(" "),
          args,
          samplingDefaults: samplingParams(),
          port:             node.serverPort
        }
      }]);
    }

    // ──────────────────────────────────────────────────────
    // Démarrage serveur
    // ──────────────────────────────────────────────────────

    function markReady() {
      if (node.serverReady) return;
      node.serverReady = true;
      setStatus("green", `ready :${node.serverPort}`);
      node.log(`llama-server ready on port ${node.serverPort} [mode: ${node.mode}]`);
      emitDebugInfo("server ready");
      while (node.pendingQueue.length > 0) handleMessage(node.pendingQueue.shift());
    }

    function startServer() {
      if (!node.modelPath) {
        setStatus("red", "no model path");
        node.error("llama-cpp: modelPath is not set.");
        return;
      }
      isPortFree(node.serverPort, (free) => {
        if (free === false) {
          const m = `port ${node.serverPort} already in use`;
          node.error("llama-cpp: " + m);
          setStatus("red", m);
          return;
        }
        spawnServer();
      });
    }

    function spawnServer() {
      const args = buildArgs();
      node.log(`Spawning [${node.mode}]: ${node.llamaBinary} ${args.join(" ")}`);
      setStatus("yellow", `loading model :${node.serverPort}...`);

      node.serverProcess = spawn(node.llamaBinary, args, {
        stdio: ["ignore", "pipe", "pipe"]
      });

      let timingBuffer = [];
      let inTiming = false;

      function parseTiming(lines) {
        const result = { raw: lines.join("\n"), port: node.serverPort };
        for (const l of lines) {
          let m = l.match(/prompt eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens.*?([\d.]+)\s*tokens per second/);
          if (m) { result.promptEvalMs = parseFloat(m[1]); result.promptTokens = parseInt(m[2]); result.promptTokensPerSec = parseFloat(m[3]); }
          m = l.match(/^\s*eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens.*?([\d.]+)\s*tokens per second/);
          if (m) { result.evalMs = parseFloat(m[1]); result.evalTokens = parseInt(m[2]); result.evalTokensPerSec = parseFloat(m[3]); }
          m = l.match(/total time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens/);
          if (m) { result.totalMs = parseFloat(m[1]); result.totalTokens = parseInt(m[2]); }
        }
        return result;
      }

      function onData(chunk) {
        const lines = chunk.toString().split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (node.debugTrace) node.warn(`[llama-server:${node.serverPort}] ${trimmed}`);

          if (trimmed.includes("print_timing")) {
            inTiming = true; timingBuffer = [trimmed]; continue;
          }
          if (inTiming) {
            timingBuffer.push(trimmed);
            if (trimmed.includes("all slots are idle")) {
              node.send([null, { topic: "timing", payload: parseTiming(timingBuffer) }]);
              timingBuffer = []; inTiming = false;
            }
            continue;
          }

          if (!node.serverReady && (
            trimmed.includes("server is listening") ||
            trimmed.includes("HTTP server listening") ||
            trimmed.includes("all slots are idle") ||
            trimmed.includes("starting the main loop") ||
            trimmed.includes("llama server listening") ||
            trimmed.includes("listening on") ||
            trimmed.includes(String(node.serverPort))
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
        node.error("Spawn failed: " + err.message); setStatus("red", "spawn error");
        node.serverProcess = null; node.serverReady = false;
      });
      node.serverProcess.on("close", (code) => {
        node.log(`llama-server :${node.serverPort} exited (${code})`);
        node.serverProcess = null; node.serverReady = false;
        if (code !== null && code !== 0) setStatus("red", `exited (${code})`);
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
      // Résultat d'outil en retour (mode mcp-client)
      if (msg.topic === "tool_result") { handleToolResult(msg); return; }

      if (!node.serverReady) {
        node.pendingQueue.push(msg);
        if (!node.serverProcess) startServer();
        else setStatus("yellow", `queued (${node.pendingQueue.length}) :${node.serverPort}`);
        return;
      }
      handleMessage(msg);
    });

    node.on("close", (done) => {
      node.serverReady      = false;
      node.pendingQueue     = [];
      node.pendingToolCalls = {};
      if (node.serverProcess) {
        node.serverProcess.kill("SIGTERM");
        const t = setTimeout(() => { if (node.serverProcess) node.serverProcess.kill("SIGKILL"); }, 3000);
        node.serverProcess.on("close", () => { clearTimeout(t); node.serverProcess = null; done(); });
      } else { done(); }
    });

    // Démarrage immédiat au deploy pour tous les modes
    startServer();
  }

  RED.nodes.registerType("llama-cpp", LlamaCppNode);
};
