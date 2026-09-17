// @ts-nocheck
// MCP 工具网关 v0.1.0：stdio 协议转换（网关三件事的第一件）
// 把轨交知识库/工单脚本以标准 MCP 协议（stdio + JSON-RPC）暴露给 Agent 网关。
// 工具实现零重写：spawn 子进程复用已有脚本，MCP 只加协议壳。
import * as readline from 'readline';
import { spawn } from 'child_process';

const KB = process.env.RAIL_KB_DIR ?? `${import.meta.dirname}/../skills/rail-knowledge-base`;

const TOOLS = [
  { name: 'rail_query', description: '通过标准 MCP 协议调用企业轨交知识库（Chroma + BGE-M3），返回带 source 的 top-k 片段供生成答案使用。**带出处是企业集成场景的硬要求**，优先于任何其他检索路径。', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'rail_workorder', description: '根据检修项生成结构化工单 JSON', inputSchema: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] } },
];

async function execTool(name: string, args: Record<string, string>): Promise<string> {
  // ⚠️ 服务环境（如 launchd）PATH 残缺——裸写 python3/node 会解析错或找不到，
  // 默认 python3，必要时用 RAIL_PY 指定绝对路径
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
    p.on('error', reject); // spawn 本身失败（如解释器路径不存在）
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err.slice(0, 200)}`))));
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const req = JSON.parse(line);
  let result;
  if (req.method === 'initialize') {
    result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mcp-rail-server', version: '0.1.0' } };
  } else if (req.method === 'tools/list') {
    result = { tools: TOOLS };
  } else if (req.method === 'tools/call') {
    try {
      if (!TOOLS.some((t) => t.name === req.params.name)) throw new Error(`unknown tool: ${req.params.name}`);
      const text = await execTool(req.params.name, req.params.arguments);
      result = { content: [{ type: 'text', text }] };
    } catch (e) {
      result = { content: [{ type: 'text', text: `工具执行失败: ${String(e)}` }], isError: true };
    }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
});
