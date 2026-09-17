#!/usr/bin/env python3
"""轨交规章知识库检索脚本（RAG 第二步：retrieve）

只做召回，不做生成——答案由 Agent 结合召回段落生成并标注【出处】。
这是刻意设计：SKILL.md 脚本负责确定性检索，LLM 负责语言组织与引用，
职责分离（面试点：避免让 LLM 编造规章数字）。

用法:
    python3 query.py "钢轨探伤周期是多久" [top_k]
输出:
    JSON: {"query", "kb_chunks", "hits": [{"source", "title", "score", "text"}]}
"""

import json
import os
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
DB_DIR = SKILL_DIR / "chroma_data"
COLLECTION = "rail_regs"


def get_embedding_fn():
    # 与 build_kb.py 保持同一来源：环境变量优先，其次 Skill 目录 .env
    # 注意：建库和查询必须用同一 provider，否则向量维度不匹配会直接报错
    env_file = SKILL_DIR / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
    key = os.environ.get("SILICONFLOW_API_KEY")
    if key:
        from chromadb.utils.embedding_functions import OpenAIEmbeddingFunction
        return OpenAIEmbeddingFunction(
            api_key=key,
            api_base="https://api.siliconflow.cn/v1",
            model_name="BAAI/bge-m3",
        )
    from chromadb.utils.embedding_functions import DefaultEmbeddingFunction
    return DefaultEmbeddingFunction()


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "用法: query.py <问题> [top_k]"}, ensure_ascii=False))
        sys.exit(1)

    query = sys.argv[1]
    top_k = int(sys.argv[2]) if len(sys.argv) > 2 else 4

    import chromadb

    client = chromadb.PersistentClient(path=str(DB_DIR))
    try:
        col = client.get_collection(COLLECTION, embedding_function=get_embedding_fn())
    except Exception:
        print(json.dumps({"error": "知识库不存在，请先运行 build_kb.py 建库"}, ensure_ascii=False))
        sys.exit(1)

    # chroma 返回 distance(越小越近)，转成相似度分数便于理解
    res = col.query(query_texts=[query], n_results=min(top_k, col.count()))
    hits = []
    for doc, meta, dist in zip(res["documents"][0], res["metadatas"][0], res["distances"][0]):
        hits.append({
            "source": meta["source"],
            "title": meta["title"],
            "score": round(1 - dist, 4),  # cosine 相似度 = 1 - cosine distance
            "text": doc,
        })

    print(json.dumps({"query": query, "kb_chunks": len(hits), "hits": hits}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
