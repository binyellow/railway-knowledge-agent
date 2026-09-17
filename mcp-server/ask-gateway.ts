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
      endpoints: ["GET /ask?q=<自然语言问题>"],
      upstream: `openclaw gateway ${OC_HOST}:${OC_PORT}`,
      openclawBin: OC_BIN,
      session: SESSION,
    });
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
