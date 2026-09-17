---
name: rail-maintenance
description: "城市轨道交通/铁路设备检修：生成标准化检修工单（含安全措施、资质要求、风险等级），并速查检修规程要点。当用户提到 检修/工单/道岔/接触网/巡检/信号机/轨行区/维修单 时使用。Railway equipment maintenance work-order generation and regulation lookup."
metadata:
  { "openclaw": { "emoji": "🛠️", "requires": { "bins": ["node"] } } }
---

# 轨交检修工单生成（Rail Maintenance Work Order）

面向城市轨道交通/铁路设备检修场景：根据检修描述生成**标准化工单 JSON**（可直接对接工单系统），并内置检修规程速查要点。

## 何时使用

- 用户报修/描述一次检修作业（如"3 号线道岔检修完成，帮我生成工单"）
- 用户查询检修安全要求、资质要求、规程要点

## 快速开始

```bash
# 生成工单：传入 JSON 参数
node {baseDir}/scripts/generate_workorder.ts '{"line":"3号线","location":"烈士湾站-左线K12+300","equipmentType":"道岔","equipmentId":"DC-0312","maintenanceType":"故障修","description":"转辙机动作电流超标，道岔转换不到位","priority":"高"}'

# 参数可省略至最少字段，其余自动补全：
node {baseDir}/scripts/generate_workorder.ts '{"line":"2号线","equipmentType":"接触网","description":"定位器坡度超标需调整"}'
```

## 输入字段（全部可选，自动补全）

| 字段 | 说明 | 默认 |
|---|---|---|
| line | 线路 | 未知线路 |
| location | 作业位置（车站/区间/里程） | - |
| equipmentType | 设备类型：道岔/接触网/信号机/轨道/车辆/供电 | 轨道 |
| equipmentId | 设备编号 | 自动生成 |
| maintenanceType | 日常检修/故障修/专项修/巡检 | 日常检修 |
| description | 作业内容描述 | - |
| priority | 紧急/高/中/低 | 中 |
| assignee | 作业负责人 | 待指派 |

## 输出工单字段

workOrderId、line、location、equipment（type+id）、maintenanceType、priority、riskLevel（由设备类型+检修类型推导）、safetyMeasures（按设备类型自动匹配）、requiredCertifications、assignee、status（待派发）、createdAt、planWindow（建议作业天窗）。

## 检修规程速查（节选，供回答规程类问题）

**通用安全红线**：进入轨行区必须申请天窗点、设置防护员；接触网停电作业必须验电挂地线；道岔作业必须断开转辙机安全接点。

| 设备 | 关键安全措施 | 资质要求 |
|---|---|---|
| 道岔 | 断开安全接点、加装钩锁器、防止挤岔 | 轨道线路工+信号工配合作业 |
| 接触网 | 停电验电挂地线、高空作业系安全带 | 接触网工（高压电工证） |
| 信号机 | 断开电源、防止误动、加锁登记 | 信号工 |
| 轨道 | 天窗点内作业、防护员到位、绝缘防护 | 轨道线路工 |
| 供电环网 | 双电源确认、验电、挂牌上锁 | 低压/高压电工证 |

**故障修 vs 日常检修**：故障修优先级自动提升一档；紧急故障（影响行车）直接置"紧急"并建议立即申请抢修天窗。

## 注意事项

- 生成的工单是**标准化 JSON**，用户如果需要 Markdown/表格形式，由你（LLM）负责格式化输出，脚本只保证数据结构
- 规程内容为演示用节选，正式环境应替换为企业真实检修规程（RAG 版本见后续 knowledge-base skill）
