#!/usr/bin/env python3
"""轨交规章知识库构建脚本（RAG 第一步：ingest）

流程: docs/*.md -> 按段落分块(带标题前缀) -> 向量化 -> Chroma 持久化
向量化: 优先 SiliconFlow BGE-M3（需环境变量 SILICONFLOW_API_KEY，免费），
        未设置时回退 Chroma 默认 ONNX MiniLM（中文质量一般，仅作管线兜底）。

用法:
    python3 build_kb.py                 # 重建知识库（幂等）
    python3 build_kb.py --stats         # 仅查看当前库统计
"""

import json
import os
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
DOCS_DIR = SKILL_DIR / "docs"
DB_DIR = SKILL_DIR / "chroma_data"
COLLECTION = "rail_regs"

CHUNK_SIZE = 300   # 单块最大字符数
OVERLAP = 50       # 滑窗重叠


def chunk_text(text: str, size: int = CHUNK_SIZE, overlap: int = OVERLAP):
    """段落优先分块：短段整块保留，长段滑窗切块。面试点：分块策略影响召回质量。"""
    chunks = []
    for para in (p.strip() for p in text.split("\n") if p.strip()):
        if len(para) <= size:
            chunks.append(para)
        else:
            step = size - overlap
            for i in range(0, len(para), step):
                piece = para[i:i + size]
                if piece:
                    chunks.append(piece)
    return chunks


def _load_env():
    """从 Skill 目录的 .env 读取 SILICONFLOW_API_KEY 等配置。

    为什么不用环境变量：Agent exec 继承的是 launchd 网关进程的环境，
    读不到用户 shell 的 export。.env 文件对任何启动方式都生效。
    """
    env_file = SKILL_DIR / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


def get_embedding_fn():
    """Embedding 提供商选择：BGE-M3(推荐) / MiniLM(兜底)。两套维度不同，混用会导致检索错乱。"""
    _load_env()
    key = os.environ.get("SILICONFLOW_API_KEY")
    if key:
        from chromadb.utils.embedding_functions import OpenAIEmbeddingFunction
        return OpenAIEmbeddingFunction(
            api_key=key,
            api_base="https://api.siliconflow.cn/v1",
            model_name="BAAI/bge-m3",
        ), "bge-m3 (SiliconFlow)"
    from chromadb.utils.embedding_functions import DefaultEmbeddingFunction
    return DefaultEmbeddingFunction(), "all-MiniLM-L6-v2 (本地兜底,中文质量差)"


def main():
    import chromadb

    if "--stats" in sys.argv:
        client = chromadb.PersistentClient(path=str(DB_DIR))
        try:
            col = client.get_collection(COLLECTION)
            print(json.dumps({"chunks": col.count(), "db": str(DB_DIR)}, ensure_ascii=False))
        except Exception:
            print(json.dumps({"chunks": 0, "db": str(DB_DIR), "note": "库不存在，请先构建"}, ensure_ascii=False))
        return

    emb_fn, emb_name = get_embedding_fn()
    client = chromadb.PersistentClient(path=str(DB_DIR))
    try:
        client.delete_collection(COLLECTION)  # 幂等：每次全量重建
    except Exception:
        pass
    col = client.get_or_create_collection(
        COLLECTION, embedding_function=emb_fn, metadata={"hnsw:space": "cosine"}
    )

    ids, docs, metas = [], [], []
    doc_files = sorted(DOCS_DIR.glob("*.md"))
    for f in doc_files:
        title = f.stem.split("-", 1)[-1]  # "01-道岔检修规程" -> "道岔检修规程"
        text = f.read_text(encoding="utf-8")
        for i, chunk in enumerate(chunk_text(text)):
            # 面试点：给每个块加"上下文标题前缀"(contextual chunk header)，提升无上下文检索的召回
            contextual = f"【{title}】{chunk}"
            ids.append(f"{f.stem}#{i}")
            docs.append(contextual)
            metas.append({"source": f.name, "title": title, "chunk": i})

    col.upsert(ids=ids, documents=docs, metadatas=metas)
    print(json.dumps({
        "ok": True,
        "files": len(doc_files),
        "chunks": len(ids),
        "chunk_size": CHUNK_SIZE,
        "overlap": OVERLAP,
        "embedding": emb_name,
        "db_path": str(DB_DIR),
        "note": "" if "bge-m3" in emb_name else "警告: 当前使用兜底MiniLM(英文模型),中文召回质量差;设置 SILICONFLOW_API_KEY 后重建",
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
