// 薄网关：GET /ask?q=... → OpenClaw agent（Gateway 模式）→ 同步 JSON 响应
// 前置：OpenClaw Gateway 已启动（默认 18789），且 rail-tools 已在 OpenClaw 中注册
// 启动：node mcp-server/ask-gateway.ts（需 Node 23.6+，openclaw 在 PATH 中）
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";

const PORT = Number(process.env.RAIL_GATEWAY_PORT ?? 18791);
const OC_BIN = process.env.RAIL_OPENCLAW_BIN ?? "openclaw";
const SESSION = process.env.RAIL_ASK_SESSION ?? "web-demo";
const OC_HOST = process.env.RAIL_OC_HOST ?? "127.0.0.1";
const OC_PORT = Number(process.env.RAIL_OC_PORT ?? 18789);
const TIMEOUT_MS = Number(process.env.RAIL_ASK_TIMEOUT_MS ?? 120) * 1000;
const LOG_FILE = process.env.RAIL_ASK_LOG ?? `${import.meta.dirname}/ask-gateway.log`;
const SESSION_FILE = `${process.env.HOME}/.openclaw/agents/main/sessions/${SESSION}.jsonl`;

// 每次请求一行 JSONL：ts / q / 状态 / 耗时 / 是否调了工具
function logLine(obj: Record<string, unknown>) {
  fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
}

function gatewayUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: OC_HOST, port: OC_PORT, timeout: 1500 });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
    s.once("timeout", () => { s.destroy(); resolve(false); });
  });
}

// openclaw 的 shim 用 #!/usr/bin/env node 运行，若 PATH 里是旧 node（如 22.22.2）会被
// 版本检查拒绝；把 openclaw 所在 bin 目录前置到子进程 PATH，保证与其同源的 node 运行它
const childEnv = OC_BIN.includes("/")
  ? { ...process.env, PATH: `${dirname(OC_BIN)}:${process.env.PATH ?? ""}` }
  : { ...process.env };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://localhost");
  const json = (code: number, obj: unknown) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj, null, 2));
  };

  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/healthz")) {
    return json(200, {
      service: "ask-gateway",
      version: "0.1.0",
      endpoints: ["GET /ask?q=<自然语言问题>", "GET /ask-stream?q=<问题>（SSE 流式：思考/工具/文本实时推送）"],
      upstream: `openclaw gateway ${OC_HOST}:${OC_PORT}`,
      openclawBin: OC_BIN,
      session: SESSION,
    });
  }

  if (req.method === "GET" && u.pathname === "/ask-stream") {
    const q = u.searchParams.get("q");
    if (!q?.trim()) {
      return json(400, { error: "missing q", hint: "GET /ask-stream?q=钢轨多久检查一次" });
    }
    if (!(await gatewayUp())) {
      return json(503, { error: `OpenClaw Gateway (${OC_HOST}:${OC_PORT}) 未运行`, hint: "先启动：openclaw gateway" });
    }

    // SSE 流式：spawn CLI 的同时 tail 会话 jsonl 文件，把 agent 的增量过程实时推给浏览器。
    // 原理：openclaw 每完成一步（思考/调工具/生成文本）就往 session 文件 append 一行，
    // 网关从当前 offset 起轮询读取新增行，解析成 SSE 事件 —— CLI 契约不变，流式在网关层实现。
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send("open", { q, session: SESSION, note: "tail 会话文件实现流式，CLI 跑完即 done" });

    // 会话文件可能不存在（新 session），CLI 会创建它
    let offset = fs.existsSync(SESSION_FILE) ? fs.statSync(SESSION_FILE).size : 0;
    const started = Date.now();
    let pending = "";
    const toolsSeen = new Set<string>();

    const poll = setInterval(() => {
      try {
        if (!fs.existsSync(SESSION_FILE)) return;
        const fd = fs.openSync(SESSION_FILE, "r");
        const size = fs.fstatSync(fd).size;
        if (size > offset) {
          const buf = Buffer.alloc(size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          fs.closeSync(fd);
          offset = size;
          pending += buf.toString("utf-8");
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            let d: any;
            try { d = JSON.parse(line); } catch { continue; }
            if (d.type !== "message" || !d.message) continue;
            const msg = d.message;
            if (msg.role === "user") { send("user", { text: msg.content }); continue; }
            if (msg.role !== "assistant") continue;
            // content 两种形态：纯文本回复是 string，带思考/工具时是块数组——都要覆盖
            if (typeof msg.content === "string") { send("text", { text: msg.content }); continue; }
            if (!Array.isArray(msg.content)) continue;
            for (const block of msg.content) {
              if (block.type === "thinking") send("thinking", { text: (block.thinking ?? "").slice(0, 600) });
              else if (block.type === "toolCall") {
                toolsSeen.add(block.name);
                send("tool", { name: block.name, args: block.arguments });
              } else if (block.type === "text" && block.text) send("text", { text: block.text });
            }
          }
        } else { fs.closeSync(fd); }
      } catch { /* 文件读取竞态：下一轮重试 */ }
    }, 400);

    const args = ["agent", "--message", q, "--session-id", SESSION, "--json"];
    execFile(OC_BIN, args, { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: childEnv }, (err) => {
      clearInterval(poll);
      // CLI 退出后补读最后一段，避免轮询间隔漏行
      try {
        const size = fs.statSync(SESSION_FILE).size;
        if (size > offset) {
          const extra = fs.readFileSync(SESSION_FILE, "utf-8").slice(offset);
          for (const line of extra.split("\n")) {
            if (!line.trim()) continue;
            try {
              const d = JSON.parse(line);
              if (d.type === "message" && d.message?.role === "assistant") {
                const c = d.message.content;
                if (typeof c === "string") send("text", { text: c });
                else if (Array.isArray(c)) {
                  for (const block of c) {
                    if (block.type === "text" && block.text) send("text", { text: block.text });
                    else if (block.type === "toolCall") toolsSeen.add(block.name);
                  }
                }
              }
            } catch {}
          }
        }
      } catch {}
      const duration = Date.now() - started;
      logLine({ q, status: err ? 502 : 200, duration_ms: duration, tools: [...toolsSeen], stream: true });
      send("done", { duration_ms: duration, tools: [...toolsSeen], error: err?.message ?? null });
      res.end();
    });
    return;
  }

  if (req.method === "GET" && u.pathname === "/demo") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>ask-gateway stream demo</title>
<style>body{font:14px/1.7 -apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 16px}
#out div{padding:6px 10px;margin:4px 0;border-radius:6px}
.thinking{background:#f4f2fb;color:#534ab7;font-size:12px;white-space:pre-wrap}
.tool{background:#e6f1fb;color:#0c447c;font-family:monospace;font-size:12px}
.text{background:#f1efe8;white-space:pre-wrap}
.done{background:#e1f5ee;color:#0f6e56}
input{width:70%;padding:8px}button{padding:8px 16px}</style>
<h3>rail-knowledge-agent · SSE 流式演示</h3>
<form id="f"><input id="q" value="无缝线路发生胀轨跑轨怎么处置" autofocus><button>提问</button></form>
<div id="out"></div>
<script>
const out = document.getElementById('out');
document.getElementById('f').onsubmit = e => {
  e.preventDefault();
  out.innerHTML = '';
  const es = new EventSource('/ask-stream?q=' + encodeURIComponent(document.getElementById('q').value));
  const add = (cls, txt) => { const d = document.createElement('div'); d.className = cls; d.textContent = txt; out.appendChild(d); window.scrollTo(0, 9e9); };
  es.addEventListener('open',    e => add('tool', '[boot] 正在拉起 agent 运行时（CLI 冷启动约 10 秒，实测 97% 耗时在此，LLM 仅约 0.7 秒）…'));
  es.addEventListener('user',    e => add('tool', '[user] ' + JSON.parse(e.data).text));
  es.addEventListener('thinking',e => add('thinking', '[think] ' + JSON.parse(e.data).text));
  es.addEventListener('tool',    e => { const d = JSON.parse(e.data); add('tool', '[tool] 调用 ' + d.name + ' ' + JSON.stringify(d.args)); });
  es.addEventListener('text',    e => { const d = JSON.parse(e.data); const last = out.lastChild; if (last && last.className === 'text') last.textContent += d.text; else add('text', d.text); window.scrollTo(0, 9e9); });
  es.addEventListener('done',    e => { const d = JSON.parse(e.data); add('done', '[done] 完成 · ' + d.duration_ms + 'ms · 工具: ' + (d.tools.join(', ') || '无（记忆捷径）')); es.close(); });
  es.onerror = () => { add('done', '连接结束'); es.close(); };
};
</script>`);
    return;
  }

  if (req.method !== "GET" || u.pathname !== "/ask") {
    return json(404, { error: "not found", hint: "GET /ask?q=..." });
  }

  const q = u.searchParams.get("q");
  if (!q?.trim()) {
    return json(400, { error: "missing q", hint: "GET /ask?q=钢轨多久检查一次" });
  }

  if (!(await gatewayUp())) {
    logLine({ q, status: 503, error: "gateway-down" });
    return json(503, {
      error: `OpenClaw Gateway (${OC_HOST}:${OC_PORT}) 未运行`,
      hint: "先启动：openclaw gateway，再重试本接口",
    });
  }

  const started = Date.now();
  const args = ["agent", "--message", q, "--session-id", SESSION, "--json"];
  execFile(OC_BIN, args, { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: childEnv }, (err, stdout, stderr) => {
    if (err) {
      logLine({ q, status: 502, duration_ms: Date.now() - started, error: err.message });
      return json(502, { error: err.message, stderr: stderr.slice(0, 500), hint: "检查 openclaw 日志与 rail-tools 注册状态" });
    }
    let agent;
    try {
      agent = JSON.parse(stdout);
    } catch {
      agent = { raw: stdout };
    }
    const ts = agent?.result?.meta?.toolSummary;
    logLine({ q, status: 200, duration_ms: Date.now() - started, tools: ts?.tools ?? [] });
    json(200, { question: q, session: SESSION, duration_ms: Date.now() - started, agent });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`ask-gateway listening http://127.0.0.1:${PORT} → ${OC_BIN} agent (gateway ${OC_HOST}:${OC_PORT})`);
});
