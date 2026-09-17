# railway-knowledge-agent

轨交运维智能体工具服务：把规章知识库（RAG）与检修工单生成以标准 **MCP 协议**暴露给 Agent，带调用审计与 RBAC 鉴权。

**一个 execTool，三个暴露面**：stdio（Agent 网关）/ POST /mcp（MCP 客户端）/ GET /api（普通业务系统）——鉴权与审计同一套，`audit.log` 的 `via` 字段区分入口。

## 架构

```
                        ┌─────────────────────────────────────────┐
  OpenClaw Gateway ──── stdio (JSON-RPC) ──┐                      │
                                            │                      │
  MCP Client ──── POST /mcp (Bearer) ──────┤  mcp-server           │
                                            │  ├─ auth: token→身份→角色→工具白名单 (RBAC)
  业务系统 ──── GET /api/<tool>?q= (Bearer) ┤  ├─ audit: 五要素 JSONL（失败也记）
                                            │  └─ execTool          │
                                            │     ├─ rail_query ──→ skills/rail-knowledge-base
                                            │     │    (Chroma + BGE-M3, 答案带出处)
                                            │     └─ rail_workorder → skills/rail-maintenance
                                            │          (结构化工单 JSON)             │
                                            └─────────────────────────────────────────┘
```

## 三级演进

每个 tag 对应一个可独立验收的里程碑：

| 版本 | 能力 | 验证方式 |
|---|---|---|
| [v0.1.0](../../tree/v0.1.0) | stdio + JSON-RPC 协议转换（initialize / tools/list / tools/call） | `openclaw mcp add` + probe |
| [v0.2.0](../../tree/v0.2.0) | 调用审计：ts / caller / tool+args / duration_ms / status 五要素 JSONL，**失败也记** | [samples/audit.sample.log](samples/audit.sample.log) |
| [v0.3.0](../../tree/v0.3.0) | HTTP + RBAC 鉴权（token→身份→角色→工具白名单）+ REST 双协议 | 401 / 权限过滤 / 403 / 命中 四分支 curl 实测 |

设计取舍（面试可展开）：

- **两层校验缺一不可**：tools/list 按权限过滤（最小暴露面）+ tools/call 二次校验（防绕过 list 直调——服务端不信客户端）
- **审计为什么写文件**：网关实测不转发子进程 stderr（stdio transport 规范允许客户端丢弃），stderr 审计不可靠——失败驱动的架构修正
- **duration_ms / status 先埋后用**：审计字段同时是未来限流（令牌桶）与熔断（半开探测）的决策数据源，监控不是后补的

## 快速开始

```bash
# 1. 环境要求：Node 22+（原生跑 .ts），Python 3.11+，chromadb
pip install chromadb

# 2. 配置 embedding API（BGE-M3，SiliconFlow）
cp skills/rail-knowledge-base/.env.example skills/rail-knowledge-base/.env
#   填入 SILICONFLOW_API_KEY

# 3. 建库（一次性）：规章 markdown → 向量库
python3 skills/rail-knowledge-base/scripts/build_kb.py

# 4a. stdio 模式（供 Agent 网关接入，以 OpenClaw 为例）
openclaw mcp add rail-tools --command $(which node) --arg /path/to/mcp-server/index.ts

# 4b. HTTP 模式（MCP + REST 双协议，监听 18790）
node mcp-server/main.ts

# 5. 测试（token 为 permissions.json 中的演示数据）
curl --noproxy '*' -H 'Authorization: Bearer tok-zhang-9f3a' \
  -G 'http://127.0.0.1:18790/api/rail_query' --data-urlencode 'q=钢轨探伤周期'
```

> 注：服务环境（launchd 等）PATH 可能残缺，`python3` 解析失败时用 `RAIL_PY=/绝对路径/python3.11` 指定。

## API

### MCP（stdio：`index.ts`；HTTP：`main.ts` 的 `POST /mcp`）

| method | 说明 |
|---|---|
| `initialize` | 协议握手，返回 serverInfo |
| `tools/list` | 按 caller 角色过滤后的工具清单（HTTP 版） |
| `tools/call` | 执行工具；`rail_query(query)` / `rail_workorder(item)` |

### REST（`GET /api/<tool>?q=...`）

给不走 JSON-RPC 的普通业务系统。鉴权同 MCP（`Authorization: Bearer`，别放 query——会进访问日志）。

### 鉴权（RBAC）

`permissions.json`（演示数据）：token → 用户 → 角色 → 工具白名单。
`viewer`（lisi）只有 rail_query；`operator`（zhangsan）两个工具可用。

## 实测样例

`samples/audit.sample.log` 覆盖三种入口（stdio / mcp / rest）× 三种身份（unknown / lisi / zhangsan）× 三种结果（ok / error / denied）：

```json
{"tool":"(auth)","caller":"unknown","via":"mcp","status":"denied"}
{"tool":"rail_workorder","caller":"lisi","via":"mcp","status":"denied"}
{"tool":"rail_query","args":{"query":"钢轨探伤周期"},"caller":"zhangsan","via":"mcp","duration_ms":2892,"status":"ok","result_bytes":827}
```

## 目录结构

```
mcp-server/          MCP 网关（index.ts=stdio 版，main.ts=HTTP 版，共用 execTool）
skills/
  rail-knowledge-base/   规章 RAG：docs/(10 部规程) + scripts/(build_kb.py, query.py)
  rail-maintenance/      工单生成：scripts/generate_workorder.ts
samples/             audit.sample.log（实测审计样例）
```

## 说明

- 规程文档为演示用途的简化示例，非真实规章原文
- `permissions.json` 中 token 均为虚构演示数据
- HTTP 版为简化的一问一答实现；官方 MCP HTTP 规范是 Streamable HTTP（SSE 流式），生产应使用官方 SDK
