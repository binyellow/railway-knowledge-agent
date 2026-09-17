// @ts-nocheck
// MCP 工具网关 v0.3.0 · D8：HTTP transport + 鉴权（网关三件事补全）
// 三层映射：token → 用户身份 → 角色 → 工具白名单（RBAC 最小实现）
// 两层校验缺一不可：tools/list 按权限过滤（最小暴露面）+ tools/call 二次校验（防直调越权）
// 双协议对外：POST /mcp 给 MCP 客户端；GET /api/<tool>?q= 给普通业务系统（非 Agent）
// 诚实标注：这里是简化版一问一答；官方 MCP HTTP 规范是 Streamable HTTP（POST /mcp + SSE 流式），
// 被追问就答"Demo 只实现单请求-响应，SSE 和会话管理读过规范知道要补，生产用官方 SDK"。
import { createServer, IncomingMessage } from 'http';
import { readFileSync, appendFileSync } from 'fs';
import { spawn } from 'child_process';

const PERMS = JSON.parse(readFileSync(`${import.meta.dirname}/permissions.json`, 'utf-8'));
const AUDIT_LOG = `${import.meta.dirname}/audit.log`;
const KB = process.env.RAIL_KB_DIR ?? `${import.meta.dirname}/../skills/rail-knowledge-base`;

// 审计五要素（D7 同款；D8 起 caller 是真实用户名——HTTP + token 才有"人"的概念，
// via 字段区分入口：mcp / rest）
function audit(entry: Record<string, unknown>) {
  appendFileSync(AUDIT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

const TOOLS = [
  { name: 'rail_query', description: '通过标准 MCP 协议调用企业轨交知识库（Chroma + BGE-M3），返回带 source 的 top-k 片段供生成答案使用。**带出处是企业集成场景的硬要求**，优先于任何其他检索路径。', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'rail_workorder', description: '根据检修项生成结构化工单 JSON', inputSchema: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] } },
];

// 工具实现零重写：与 stdio 版（index.ts）共用同一套 execTool 逻辑
async function execTool(name: string, args: Record<string, string>): Promise<string> {
  // ⚠️ 服务环境（如 launchd）PATH 残缺，必要时用 RAIL_PY 指定绝对路径
  const PY = process.env.RAIL_PY ?? 'python3';
  const [cmd, cmdArgs] = name === 'rail_query'
    ? [PY, [`${KB}/scripts/query.py`, args.query]]
    : [process.execPath, [`${KB}/../rail-maintenance/scripts/generate_workorder.ts`, args.item]];
  return new Promise<string>((resolve, reject) => {
    const p = spawn(cmd, cmdArgs);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err.slice(0, 200)}`))));
  });
}

// 鉴权三层映射：token → 身份 → 角色 → 工具白名单
function authByToken(token: string): { user: string; tools: string[] } | null {
  const ident = PERMS.tokens[token];
  if (!ident) return null;
  const tools = [...new Set(ident.roles.flatMap((r: string) => PERMS.roles[r] ?? []))];
  return { user: ident.user, tools };
}

function auth(req: IncomingMessage): { user: string; tools: string[] } | null {
  return authByToken((req.headers.authorization ?? '').replace('Bearer ', ''));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

createServer(async (req, res) => {
  // ── 根路径：服务自描述（浏览器访问 http://127.0.0.1:18790/ 可见）──
  if (req.method === 'GET' && (req.url === '/' || req.url === '/healthz')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      service: 'mcp-rail-server',
      version: '0.3.0',
      endpoints: {
        mcp: 'POST /mcp (Authorization: Bearer <token>)',
        rest: 'GET /api/rail_query?q=... | /api/rail_workorder?q=...',
      },
    }));
    return;
  }

  // ── REST GET 双协议暴露：GET /api/<tool>?q=...（给不认识 JSON-RPC 的普通系统）──
  if (req.method === 'GET' && req.url!.startsWith('/api/')) {
    const u = new URL(req.url!, 'http://localhost');
    // 演示模式：RAIL_ALLOW_QUERY_TOKEN=1 时允许 ?token= 传凭证（浏览器直查用）。
    // 默认关闭——token 进 query 会留在访问日志，生产必须走 Authorization header。
    const caller = auth(req)
      ?? (process.env.RAIL_ALLOW_QUERY_TOKEN === '1' ? authByToken(u.searchParams.get('token') ?? '') : null);
    if (!caller) { audit({ tool: '(auth)', caller: 'unknown', via: 'rest', status: 'denied' }); res.writeHead(401).end(); return; }
    const tool = u.pathname.replace('/api/', '');
    if (!caller.tools.includes(tool)) { res.writeHead(403).end(); return; } // 权限复用
    const q = u.searchParams.get('q') ?? '';
    const start = Date.now();
    try {
      const text = await execTool(tool, { query: q, item: q }); // 工具复用
      audit({ tool, args: { q }, caller: caller.user, via: 'rest', duration_ms: Date.now() - start, status: 'ok' });
      res.writeHead(200, { 'content-type': 'application/json' }).end(text);
    } catch (e) {
      audit({ tool, args: { q }, caller: caller.user, via: 'rest', duration_ms: Date.now() - start, status: 'error', error: String(e).slice(0, 300) });
      res.writeHead(500).end(String(e));
    }
    return;
  }

  // ── MCP 主入口：POST /mcp（JSON-RPC，给 Agent 类 MCP 客户端）──
  if (req.method !== 'POST' || req.url !== '/mcp') { res.writeHead(404).end(); return; }
  const caller = auth(req);
  if (!caller) { audit({ tool: '(auth)', caller: 'unknown', via: 'mcp', status: 'denied' }); res.writeHead(401).end(); return; }

  const rpc = JSON.parse(await readBody(req));
  let result;
  if (rpc.method === 'initialize') {
    result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mcp-rail-server', version: '0.3.0' } };
  } else if (rpc.method === 'tools/list') {
    result = { tools: TOOLS.filter((t) => caller.tools.includes(t.name)) }; // 第一层：按权限过滤暴露面
  } else if (rpc.method === 'tools/call') {
    if (!caller.tools.includes(rpc.params.name)) { // 第二层：防绕过 list 直调（服务端不信客户端）
      audit({ tool: rpc.params.name, caller: caller.user, via: 'mcp', status: 'denied' });
      res.writeHead(403).end(); return;
    }
    const start = Date.now();
    try {
      const text = await execTool(rpc.params.name, rpc.params.arguments);
      audit({ tool: rpc.params.name, args: rpc.params.arguments, caller: caller.user, via: 'mcp', duration_ms: Date.now() - start, status: 'ok', result_bytes: text.length });
      result = { content: [{ type: 'text', text }] };
    } catch (e) {
      audit({ tool: rpc.params.name, args: rpc.params.arguments, caller: caller.user, via: 'mcp', duration_ms: Date.now() - start, status: 'error', error: String(e).slice(0, 300) });
      result = { content: [{ type: 'text', text: `工具执行失败: ${String(e)}` }], isError: true };
    }
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
}).listen(18790, () => {
  console.log('mcp-rail-server v0.3.0 (HTTP) listening on http://127.0.0.1:18790');
});
