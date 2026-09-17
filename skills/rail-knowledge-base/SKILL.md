---
name: rail-knowledge-base
description: 轨交检修规章知识库检索（RAG）。当用户询问轨道交通检修规程、规章条款、技术参数、周期标准时使用，例如：钢轨探伤周期、接触网安全距离、天窗修时间、检修安全红线、车辆检修等级、应急抢修时限、工单填报要求等查询类问题。
metadata:
  openclaw:
    requires:
      bins: ["python3"]
---

# 轨交规章知识库（RAG 检索问答）

基于 Chroma 向量库的规章检索。**你只负责组织答案，事实必须来自检索结果**，禁止凭记忆编造规章数字。

## 何时使用

- 询问检修周期、参数、时限、安全距离等具体数值（"钢轨探伤多久一次？"）
- 询问规章条款含义（"天窗修外作业有什么红线？"）
- 询问流程规范（"一级故障抢修怎么组织？""工单填错怎么改？"）

不适用于：生成检修工单（用 rail-maintenance skill）、闲聊、与轨交规章无关的问题。

## 工作流程

1. 调用检索脚本召回相关段落：

```bash
/opt/homebrew/opt/python@3.11/bin/python3.11 {baseDir}/scripts/query.py "用户问题" 4
```

2. 基于 hits 中的 text 生成答案，**每条事实后标注出处**，格式：`【出处：道岔检修规程】`
3. 若 top-1 score < 0.5 或命中内容与问题无关，明确告知"知识库未覆盖该问题"，不要硬答
4. 若脚本报"知识库不存在"，提示先运行建库：`/opt/homebrew/opt/python@3.11/bin/python3.11 {baseDir}/scripts/build_kb.py`

## 知识库构成

10 篇规章：道岔/接触网/信号机/轨道/供电/车辆检修规程、天窗修管理、检修安全红线、应急抢修、工单管理规范。
语料在 `{baseDir}/docs/`，向量库在 `{baseDir}/chroma_data/`（首次检索会自动触发本地 embedding 模型下载，属正常）。

## 维护（一般不需要）

- 语料更新后重建：`/opt/homebrew/opt/python@3.11/bin/python3.11 {baseDir}/scripts/build_kb.py`（幂等全量重建）
- 查看/修改 embedding 配置：`{baseDir}/.env`（含 SILICONFLOW_API_KEY 时用 BGE-M3，中文效果好）
- ⚠️ 建库与查询必须使用同一 embedding provider，混用会因向量维度不同报错
