"""质量知识库：本地检索 + 证据式摘要（RAG 的“检索”与“带出处回答”部分）。

- 检索：中文按字二元组（bigram）、英文按单词切分，BM25 打分；不依赖任何第三方库。
- 同义词扩展：查询中出现缺陷同义词（如“刮伤”“Scratch”）时自动补充标准名称（“划伤”）。
- 证据式摘要：从命中文件的“根本原因 / 对策 / 效果验证”等章节抽取原文要点，并标注出处编号。
  这一步不是大模型生成；配置大模型后可在此基础上生成带引用的回答（见 llm.py）。
"""
import math
import re

from . import reference as ref

TOKEN_RE = re.compile(r"[一-鿿]+|[a-z0-9][a-z0-9\-\.]*")

# 提问中的意图词（“原因”“怎么改善”等）几乎每份 8D 都有，参与打分会稀释相关性，检索前去掉
QUERY_STOP = re.compile(r"有没有|是什么|怎么办|怎么|如何|什么|为什么|以前|之前|发生过|原因|对策|措施|改善|处理|解决|问题|的|和|及|吗|呢|？|\?")

SECTION_KEYS = {
    "cause": ("根本原因", "根因", "原因分析", "失效原因", "主要发现", "问题点"),
    "action": ("永久对策", "纠正措施", "改善措施", "预防措施", "控制措施", "建议措施", "对策", "要求", "建议"),
    "verify": ("效果验证", "验证结果", "验证"),
}
SECTION_LABELS = {"cause": "历史原因", "action": "采取过的措施", "verify": "效果验证"}


def tokenize(text):
    toks = []
    for seg in TOKEN_RE.findall(text.lower()):
        if "一" <= seg[0] <= "鿿":
            if len(seg) == 1:
                toks.append(seg)
            else:
                toks.extend(seg[i:i + 2] for i in range(len(seg) - 1))
        else:
            toks.append(seg)
    return toks


def split_sections(body):
    """按二级标题切分 -> [(标题, 正文)]"""
    sections, head, buf = [], "概述", []
    for line in body.splitlines():
        if line.startswith("## "):
            if "".join(buf).strip():
                sections.append((head, "\n".join(buf).strip()))
            head, buf = line[3:].strip(), []
        elif line.startswith("# "):
            continue
        else:
            buf.append(line)
    if "".join(buf).strip():
        sections.append((head, "\n".join(buf).strip()))
    return sections


def _points(text, limit=2, width=110):
    """从章节正文提取要点：优先列表项，否则按句切分。"""
    lines = [l.strip()[2:].strip() for l in text.splitlines() if l.strip().startswith(("- ", "* "))]
    if not lines:
        lines = [s.strip() for s in re.split(r"(?<=[。；;])", text.replace("\n", "")) if s.strip()]
    out = []
    for l in lines[:limit]:
        out.append(l if len(l) <= width else l[:width] + "…")
    return out


class KnowledgeBase:
    def __init__(self, db):
        self.db = db
        self.alias_map = ref.build_alias_map()
        self.reindex()

    def reindex(self):
        self.docs = {d["id"]: d for d in self.db.all("SELECT * FROM kb_docs")}
        self.chunks = []
        for d in self.docs.values():
            for head, text in split_sections(d["content"] or ""):
                toks = tokenize(d["title"]) + tokenize(head) + tokenize(text)
                tf = {}
                for t in toks:
                    tf[t] = tf.get(t, 0) + 1
                self.chunks.append({"doc_id": d["id"], "heading": head, "text": text, "tf": tf, "len": len(toks)})
        n = len(self.chunks) or 1
        df = {}
        for c in self.chunks:
            for t in c["tf"]:
                df[t] = df.get(t, 0) + 1
        self.idf = {t: math.log(1 + (n - v + 0.5) / (v + 0.5)) for t, v in df.items()}
        self.avgdl = sum(c["len"] for c in self.chunks) / n

    # ---------- 查询理解 ----------
    def analyze_query(self, q):
        ql = q.lower()
        defects = []
        for alias, code in sorted(self.alias_map.items(), key=lambda x: -len(x[0])):
            if len(alias) >= 2 and alias in ql and code not in defects:
                defects.append(code)
        suppliers = [s[0] for s in ref.SUPPLIERS if s[1] in q or s[0].lower() in ql]
        core = QUERY_STOP.sub(" ", q)
        if not tokenize(core):
            core = q
        expanded = core + " " + " ".join(ref.defect_name(c) for c in defects)
        return {"defects": defects, "suppliers": suppliers, "expanded": expanded}

    # ---------- 检索 ----------
    def search(self, q, top_k=6, doc_type=None, supplier=None):
        info = self.analyze_query(q)
        qtoks = set(tokenize(info["expanded"]))
        if not qtoks:
            return [], info
        k1, b = 1.4, 0.6
        per_doc = {}
        for c in self.chunks:
            d = self.docs[c["doc_id"]]
            if doc_type and d["doc_type"] != doc_type:
                continue
            if supplier and d["supplier_code"] != supplier:
                continue
            s = 0.0
            for t in qtoks:
                f = c["tf"].get(t)
                if f:
                    s += self.idf.get(t, 0) * f * (k1 + 1) / (f + k1 * (1 - b + b * c["len"] / self.avgdl))
            if s <= 0:
                continue
            per_doc.setdefault(c["doc_id"], []).append((s, c))
        hits = []
        for doc_id, lst in per_doc.items():
            lst.sort(key=lambda x: -x[0])
            d = self.docs[doc_id]
            score = lst[0][0] + 0.3 * sum(x[0] for x in lst[1:3])
            if d["defect_code"] and d["defect_code"] in info["defects"]:
                score *= 1.25
            if d["supplier_code"] and d["supplier_code"] in info["suppliers"]:
                score *= 1.15
            best = lst[0][1]
            hits.append({
                "doc_id": doc_id, "doc_no": d["doc_no"], "title": d["title"], "doc_type": d["doc_type"],
                "supplier_code": d["supplier_code"], "defect_code": d["defect_code"], "doc_date": d["doc_date"],
                "source": d["source"], "score": round(score, 2), "heading": best["heading"],
                "snippet": self.snippet(best["text"], qtoks),
            })
        hits.sort(key=lambda h: -h["score"])
        if hits:  # 去掉相关度明显偏低的尾部结果
            top = hits[0]["score"]
            hits = [h for h in hits if h["score"] >= top * 0.18]
        return hits[:top_k], info

    @staticmethod
    def snippet(text, qtoks, width=150):
        flat = re.sub(r"\s+", " ", text.replace("- ", "")).strip()
        low = flat.lower()
        marks = [False] * len(flat)
        first = None
        for t in qtoks:
            if len(t) < 2:
                continue
            start = low.find(t)
            while start >= 0:
                first = start if first is None else min(first, start)
                for i in range(start, start + len(t)):
                    marks[i] = True
                start = low.find(t, start + 1)
        lo = max(0, (first or 0) - 30)
        hi = min(len(flat), lo + width)
        segs, cur, cur_hit = [], "", None
        for i in range(lo, hi):
            if cur_hit is None or marks[i] == cur_hit:
                cur += flat[i]
            else:
                segs.append([cur, cur_hit])
                cur = flat[i]
            cur_hit = marks[i]
        if cur:
            segs.append([cur, bool(cur_hit)])
        if lo > 0:
            segs.insert(0, ["…", False])
        if hi < len(flat):
            segs.append(["…", False])
        return segs

    # ---------- 证据式摘要 ----------
    def evidence(self, hits, max_docs=4):
        groups = {k: [] for k in SECTION_KEYS}
        for n, h in enumerate(hits[:max_docs], 1):
            d = self.docs[h["doc_id"]]
            for head, text in split_sections(d["content"]):
                for key, words in SECTION_KEYS.items():
                    if any((w in head) if len(w) >= 4 else head == w for w in words):
                        for p in _points(text):
                            groups[key].append({"text": p, "ref": n, "doc_no": d["doc_no"]})
                        break
        return [{"key": k, "label": SECTION_LABELS[k], "items": v[:5]} for k, v in groups.items() if v]

    def answer(self, q, doc_type=None, supplier=None, llm=None, use_llm=False):
        hits, info = self.search(q, doc_type=doc_type, supplier=supplier)
        result = {
            "query": q, "mode": "evidence", "hits": hits,
            "detected_defects": [{"code": c, "name": ref.defect_name(c)} for c in info["defects"]],
            "groups": self.evidence(hits),
            "caution": "历史案例仅作排查参考，不能据此直接判定当前异常的根本原因，须以实物分析、过程数据和验证实验确认。",
        }
        if not hits:
            result["intro"] = "知识库中没有找到相关文件。可以换用缺陷名称、物料或供应商名称再试。"
            return result
        result["intro"] = f"检索到 {len(hits)} 份相关文件，以下要点直接摘自原文，方括号内为出处编号。"
        if use_llm and llm and llm.enabled():
            sources = []
            for n, h in enumerate(hits[:5], 1):
                d = self.docs[h["doc_id"]]
                sources.append(f"[{n}] {d['doc_no']} {d['title']}\n{d['content'][:1800]}")
            text, err = llm.answer(q, sources)
            if text:
                result["mode"] = "llm"
                result["llm_answer"] = text
            else:
                result["llm_error"] = err
        return result

    def doc(self, doc_id):
        d = self.docs.get(int(doc_id))
        if not d:
            return None
        return dict(d, sections=split_sections(d["content"] or ""))

    def list_docs(self):
        return sorted(
            [{k: d[k] for k in ("id", "doc_no", "title", "doc_type", "supplier_code", "defect_code", "doc_date", "source")}
             for d in self.docs.values()],
            key=lambda d: (d["doc_date"] or ""), reverse=True)
