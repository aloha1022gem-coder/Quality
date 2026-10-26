/* 在线预览用的浏览器端后端：读取构建时导出的数据快照（window.SQM_BUNDLE），
   在浏览器内实现知识库检索、导入校验、预警状态与 8D 流程。逻辑与 sqm/*.py 保持一致。
   刷新页面后恢复为快照状态。 */
(function () {
  'use strict';
  const B = window.SQM_BUNDLE;
  const clone = (x) => JSON.parse(JSON.stringify(x));

  // ---------------------------------------------------------------- 知识库（对应 knowledge.py）
  const TOKEN_RE = /[一-鿿]+|[a-z0-9][a-z0-9\-.]*/g;
  const QUERY_STOP = /有没有|是什么|怎么办|怎么|如何|什么|为什么|以前|之前|发生过|原因|对策|措施|改善|处理|解决|问题|的|和|及|吗|呢|？|\?/g;
  const SECTION_KEYS = {
    cause: ['根本原因', '根因', '原因分析', '失效原因', '主要发现', '问题点'],
    action: ['永久对策', '纠正措施', '改善措施', '预防措施', '控制措施', '建议措施', '对策', '要求', '建议'],
    verify: ['效果验证', '验证结果', '验证'],
  };
  const SECTION_LABELS = { cause: '历史原因', action: '采取过的措施', verify: '效果验证' };
  const isCJK = (c) => c >= '一' && c <= '鿿';

  function tokenize(text) {
    const out = [];
    for (const seg of String(text).toLowerCase().match(TOKEN_RE) || []) {
      if (isCJK(seg[0])) {
        if (seg.length === 1) out.push(seg);
        else for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
      } else out.push(seg);
    }
    return out;
  }

  function splitSections(body) {
    const sections = [];
    let head = '概述', buf = [];
    for (const line of String(body || '').split('\n')) {
      if (line.startsWith('## ')) {
        if (buf.join('').trim()) sections.push([head, buf.join('\n').trim()]);
        head = line.slice(3).trim(); buf = [];
      } else if (!line.startsWith('# ')) buf.push(line);
    }
    if (buf.join('').trim()) sections.push([head, buf.join('\n').trim()]);
    return sections;
  }

  function points(text, limit, width) {
    limit = limit || 2; width = width || 110;
    let lines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ') || l.startsWith('* ')).map((l) => l.slice(2).trim());
    if (!lines.length) lines = text.replace(/\n/g, '').split(/(?<=[。；;])/).map((s) => s.trim()).filter(Boolean);
    return lines.slice(0, limit).map((l) => (l.length <= width ? l : l.slice(0, width) + '…'));
  }

  const KB = {
    reindex() {
      this.docs = {};
      B.docs.forEach((d) => { this.docs[d.id] = d; });
      this.chunks = [];
      for (const d of B.docs) {
        for (const [head, text] of splitSections(d.content)) {
          const toks = tokenize(d.title).concat(tokenize(head), tokenize(text));
          const tf = {};
          toks.forEach((t) => { tf[t] = (tf[t] || 0) + 1; });
          this.chunks.push({ doc_id: d.id, heading: head, text, tf, len: toks.length });
        }
      }
      const n = this.chunks.length || 1, df = {};
      this.chunks.forEach((c) => Object.keys(c.tf).forEach((t) => { df[t] = (df[t] || 0) + 1; }));
      this.idf = {};
      Object.entries(df).forEach(([t, v]) => { this.idf[t] = Math.log(1 + (n - v + 0.5) / (v + 0.5)); });
      this.avgdl = this.chunks.reduce((s, c) => s + c.len, 0) / n;
    },
    analyze(q) {
      const ql = q.toLowerCase();
      const defects = [];
      Object.entries(B.alias_map).sort((a, b) => b[0].length - a[0].length).forEach(([alias, code]) => {
        if (alias.length >= 2 && ql.includes(alias) && !defects.includes(code)) defects.push(code);
      });
      const suppliers = B.suppliers_ref.filter((s) => q.includes(s.name) || ql.includes(s.code.toLowerCase())).map((s) => s.code);
      let core = q.replace(QUERY_STOP, ' ');
      if (!tokenize(core).length) core = q;
      return { defects, suppliers, expanded: core + ' ' + defects.map((c) => B.defect_names[c]).join(' ') };
    },
    snippet(text, qtoks, width) {
      width = width || 150;
      const flat = text.replace(/- /g, '').replace(/\s+/g, ' ').trim();
      const low = flat.toLowerCase();
      const marks = new Array(flat.length).fill(false);
      let first = null;
      qtoks.forEach((t) => {
        if (t.length < 2) return;
        let s = low.indexOf(t);
        while (s >= 0) {
          first = first === null ? s : Math.min(first, s);
          for (let i = s; i < s + t.length; i++) marks[i] = true;
          s = low.indexOf(t, s + 1);
        }
      });
      const lo = Math.max(0, (first || 0) - 30), hi = Math.min(flat.length, lo + width);
      const segs = [];
      let cur = '', curHit = null;
      for (let i = lo; i < hi; i++) {
        if (curHit === null || marks[i] === curHit) cur += flat[i];
        else { segs.push([cur, curHit]); cur = flat[i]; }
        curHit = marks[i];
      }
      if (cur) segs.push([cur, !!curHit]);
      if (lo > 0) segs.unshift(['…', false]);
      if (hi < flat.length) segs.push(['…', false]);
      return segs;
    },
    search(q, docType, supplier) {
      const info = this.analyze(q);
      const qtoks = Array.from(new Set(tokenize(info.expanded)));
      if (!qtoks.length) return [[], info];
      const k1 = 1.4, b = 0.6, perDoc = {};
      for (const c of this.chunks) {
        const d = this.docs[c.doc_id];
        if (docType && d.doc_type !== docType) continue;
        if (supplier && d.supplier_code !== supplier) continue;
        let s = 0;
        qtoks.forEach((t) => {
          const f = c.tf[t];
          if (f) s += (this.idf[t] || 0) * f * (k1 + 1) / (f + k1 * (1 - b + b * c.len / this.avgdl));
        });
        if (s > 0) (perDoc[c.doc_id] = perDoc[c.doc_id] || []).push([s, c]);
      }
      let hits = Object.entries(perDoc).map(([id, lst]) => {
        lst.sort((x, y) => y[0] - x[0]);
        const d = this.docs[id];
        let score = lst[0][0] + 0.3 * lst.slice(1, 3).reduce((s, x) => s + x[0], 0);
        if (d.defect_code && info.defects.includes(d.defect_code)) score *= 1.25;
        if (d.supplier_code && info.suppliers.includes(d.supplier_code)) score *= 1.15;
        const best = lst[0][1];
        return {
          doc_id: d.id, doc_no: d.doc_no, title: d.title, doc_type: d.doc_type, supplier_code: d.supplier_code,
          defect_code: d.defect_code, doc_date: d.doc_date, source: d.source, score: Math.round(score * 100) / 100,
          heading: best.heading, snippet: this.snippet(best.text, qtoks),
        };
      });
      hits.sort((x, y) => y.score - x.score);
      if (hits.length) { const top = hits[0].score; hits = hits.filter((h) => h.score >= top * 0.18); }
      return [hits.slice(0, 6), info];
    },
    evidence(hits) {
      const groups = { cause: [], action: [], verify: [] };
      hits.slice(0, 4).forEach((h, idx) => {
        const d = this.docs[h.doc_id];
        for (const [head, text] of splitSections(d.content)) {
          for (const key of Object.keys(SECTION_KEYS)) {
            if (SECTION_KEYS[key].some((w) => (w.length >= 4 ? head.includes(w) : head === w))) {
              points(text).forEach((p) => groups[key].push({ text: p, ref: idx + 1, doc_no: d.doc_no }));
              break;
            }
          }
        }
      });
      return Object.keys(groups).filter((k) => groups[k].length).map((k) => ({ key: k, label: SECTION_LABELS[k], items: groups[k].slice(0, 5) }));
    },
    answer(q, docType, supplier) {
      const [hits, info] = this.search(q, docType, supplier);
      return {
        query: q, mode: 'evidence', hits,
        detected_defects: info.defects.map((c) => ({ code: c, name: B.defect_names[c] })),
        groups: this.evidence(hits),
        caution: '历史案例仅作排查参考，不能据此直接判定当前异常的根本原因，须以实物分析、过程数据和验证实验确认。',
        intro: hits.length ? `检索到 ${hits.length} 份相关文件，以下要点直接摘自原文，方括号内为出处编号。` : '知识库中没有找到相关文件。可以换用缺陷名称、物料或供应商名称再试。',
      };
    },
    listDocs() {
      return B.docs.map((d) => ({ id: d.id, doc_no: d.doc_no, title: d.title, doc_type: d.doc_type, supplier_code: d.supplier_code, defect_code: d.defect_code, doc_date: d.doc_date, source: d.source }))
        .sort((a, b) => String(b.doc_date || '').localeCompare(String(a.doc_date || '')));
    },
  };
  KB.reindex();

  // ---------------------------------------------------------------- 数据治理（对应 governance.py）
  const FIELDS = [['lot_no', '批次号'], ['supplier_code', '供应商编码'], ['material_code', '物料编码'], ['inspect_date', '检验日期'],
    ['lot_qty', '批量'], ['sample_size', '抽样数'], ['defect_qty', '不良数'], ['defect_desc', '缺陷描述'], ['inspector', '检验员']];
  const FIELD_CN = Object.fromEntries(FIELDS);
  const HEADER = {};
  FIELDS.forEach(([k, cn]) => { HEADER[k] = k; HEADER[cn] = k; });
  const REQUIRED = ['lot_no', 'supplier_code', 'material_code', 'inspect_date', 'sample_size', 'defect_qty'];

  function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', q = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim()));
  }

  function sampling(qty) {
    for (const [lo, hi, n, ac] of B.sampling_plan) if (qty >= lo && qty <= hi) return [n, ac];
    return qty < 501 ? [Math.min(qty, 50), 0] : [500, 7];
  }

  function normDate(s) {
    s = s.trim();
    const pats = [[/^(\d{4})-(\d{1,2})-(\d{1,2})$/, false], [/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/, true], [/^(\d{4})(\d{2})(\d{2})$/, true]];
    for (const [re, fixed] of pats) {
      const m = s.match(re);
      if (m) {
        const y = +m[1], mo = +m[2], d = +m[3];
        const dt = new Date(Date.UTC(y, mo - 1, d));
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return [null, false];
        const iso = dt.toISOString().slice(0, 10);
        return [iso, fixed || s.length !== 10];
      }
    }
    return [null, false];
  }

  function normInt(s) {
    const raw = s.trim();
    if (raw.includes('%')) return [null, false, '单位混用：应填写件数，不能填写百分比'];
    const cleaned = raw.replace(/(pcs|PCS|件|个|,|，|\s)/g, '');
    if (!/^-?\d+(\.0+)?$/.test(cleaned)) return [null, false, '不是有效数字：' + raw];
    const v = Math.trunc(parseFloat(cleaned));
    if (v < 0) return [null, false, '不能为负数'];
    return [v, cleaned !== raw, null];
  }

  function validate(text) {
    const all = parseCsv(text);
    const header = (all[0] || []).map((h) => HEADER[h.trim()] || h.trim());
    const rows = all.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
    const missingCols = FIELDS.filter(([k]) => REQUIRED.includes(k) && !header.includes(k)).map(([, cn]) => cn);
    const supCodes = Object.fromEntries(B.suppliers_ref.map((s) => [s.code, s]));
    const supNames = Object.fromEntries(B.suppliers_ref.map((s) => [s.name, s.code]));
    const mats = Object.fromEntries(B.materials.map((m) => [m.code, m]));
    const existing = new Set(B.existing_lots);
    const today = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    const seen = new Set();
    const dims = { 完整性: 0, 唯一性: 0, 一致性: 0, 有效性: 0 };
    const results = rows.map((row, idx) => {
      const issues = [], bad = new Set();
      const clean = {};
      FIELDS.forEach(([k]) => { clean[k] = row[k] || ''; });
      const add = (level, field, msg, dim) => { issues.push({ level, field: FIELD_CN[field] || field, msg }); if (level === 'error') bad.add(dim); };
      REQUIRED.forEach((f) => { if (!clean[f]) add('error', f, '必填项缺失', '完整性'); });
      const lot = clean.lot_no;
      if (lot) {
        if (seen.has(lot)) add('error', 'lot_no', '文件内重复批次', '唯一性');
        else if (existing.has(lot)) add('error', 'lot_no', '系统中已存在该批次', '唯一性');
        seen.add(lot);
      }
      let sc = clean.supplier_code;
      if (sc) {
        if (supCodes[sc.toUpperCase()] && sc !== sc.toUpperCase()) { add('fixed', 'supplier_code', `编码大小写统一：${sc} → ${sc.toUpperCase()}`, '一致性'); sc = sc.toUpperCase(); }
        else if (supNames[sc]) { add('fixed', 'supplier_code', `名称转编码：${sc} → ${supNames[sc]}`, '一致性'); sc = supNames[sc]; }
        else if (!supCodes[sc]) add('error', 'supplier_code', '供应商编码不存在：' + sc, '一致性');
        clean.supplier_code = sc;
      }
      const mc = clean.material_code.toUpperCase();
      if (mc) {
        if (!mats[mc]) add('error', 'material_code', '物料编码不存在：' + clean.material_code, '一致性');
        else if (supCodes[sc] && mats[mc].supplier_code !== sc) add('error', 'material_code', `物料 ${mc} 不属于供应商 ${sc}`, '一致性');
        clean.material_code = mc;
      }
      if (clean.inspect_date) {
        const [d, fixed] = normDate(clean.inspect_date);
        if (!d) add('error', 'inspect_date', '日期无法识别：' + clean.inspect_date, '有效性');
        else if (d > today) add('error', 'inspect_date', '检验日期晚于今天：' + d, '有效性');
        else { if (fixed) add('fixed', 'inspect_date', `日期格式统一：${clean.inspect_date} → ${d}`, '有效性'); clean.inspect_date = d; }
      }
      const nums = {};
      ['lot_qty', 'sample_size', 'defect_qty'].forEach((f) => {
        if (!clean[f]) return;
        const [v, fixed, err] = normInt(String(clean[f]));
        if (err) add('error', f, err, '有效性');
        else { if (fixed) add('fixed', f, `去除单位/分隔符：${clean[f]} → ${v}`, '有效性'); nums[f] = v; clean[f] = v; }
      });
      if ('sample_size' in nums && 'defect_qty' in nums && nums.defect_qty > nums.sample_size) add('error', 'defect_qty', '不良数大于抽样数（可能把缺陷个数当成了不良品数）', '有效性');
      if ('lot_qty' in nums && 'sample_size' in nums) {
        if (nums.sample_size > nums.lot_qty) add('error', 'sample_size', '抽样数大于批量', '有效性');
        else { const [n] = sampling(nums.lot_qty); if (n !== nums.sample_size) add('warn', 'sample_size', `与抽样方案不一致：批量 ${nums.lot_qty} 应抽 ${n}`, '有效性'); }
      }
      const desc = clean.defect_desc;
      clean.defect_code = null;
      if (nums.defect_qty) {
        if (!desc) add('error', 'defect_desc', '有不良但缺少缺陷描述', '完整性');
        else {
          const code = B.alias_map[desc.toLowerCase()];
          if (code) { if (desc !== B.defect_names[code]) add('fixed', 'defect_desc', `缺陷名称标准化：${desc} → ${code} ${B.defect_names[code]}`, '一致性'); clean.defect_code = code; }
          else if (B.ambiguous.includes(desc)) add('confirm', 'defect_desc', `“${desc}”过于笼统，需人工确认具体缺陷类别`, '一致性');
          else add('confirm', 'defect_desc', `未收录的缺陷描述“${desc}”，需维护到缺陷代码库`, '一致性');
        }
      }
      const lv = new Set(issues.map((i) => i.level));
      const status = lv.has('error') ? '错误' : lv.has('confirm') ? '待确认' : lv.has('fixed') ? '已修正' : '通过';
      Object.keys(dims).forEach((k) => { if (!bad.has(k)) dims[k]++; });
      return { line: idx + 2, status, issues, clean, importable: status === '通过' || status === '已修正' };
    });
    const total = results.length;
    const summary = {};
    ['通过', '已修正', '待确认', '错误'].forEach((s) => { summary[s] = results.filter((r) => r.status === s).length; });
    const importable = results.filter((r) => r.importable).length;
    const r1 = (x) => Math.round(x * 10) / 10;
    return {
      total, summary, missing_columns: missingCols, importable,
      quality_score: total ? r1(importable / total * 100) : 0,
      dimensions: Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, total ? r1(v / total * 100) : 0])),
      rows: results,
    };
  }

  // ---------------------------------------------------------------- 预警状态与 8D（对应 capa.py）
  const alerts = clone(B.alerts);
  const details = clone(B.alert_details);
  const capas = clone(B.capa);
  const STEPS = ['待围堵', '根因分析', '对策实施', '效果验证', '已关闭'];

  function setAlert(key, patch) {
    alerts.filter((a) => a.key === key).forEach((a) => Object.assign(a, patch));
    if (details[key]) Object.assign(details[key], patch);
  }
  function decorate(c) {
    c.supplier_name = (B.suppliers_ref.find((s) => s.code === c.supplier_code) || {}).name || '';
    c.material_name = (B.materials.find((m) => m.code === c.material_code) || {}).name || '';
    c.defect_name = c.defect_code ? B.defect_names[c.defect_code] : null;
    c.overdue = c.status !== '已关闭' && !!c.due_date && c.due_date < B.meta.as_of;
    return c;
  }
  function capaList() {
    return capas.map(decorate).sort((a, b) => ((a.status === '已关闭') - (b.status === '已关闭')) || String(a.due_date).localeCompare(String(b.due_date)));
  }
  function capaCreate(data) {
    if (!data.title) throw new Error('请填写问题标题');
    if (data.alert_key && capas.some((c) => c.alert_key === data.alert_key)) throw new Error('该预警已关联 8D');
    const year = new Date().getFullYear();
    const n = Math.max(0, ...capas.filter((c) => c.capa_no.startsWith(`8D-${year}-`)).map((c) => parseInt(c.capa_no.split('-')[2], 10) || 0));
    const no = `8D-${year}-${String(n + 1).padStart(3, '0')}`;
    const c = {
      id: Math.max(0, ...capas.map((x) => x.id)) + 1, capa_no: no, title: data.title, supplier_code: data.supplier_code,
      material_code: data.material_code, defect_code: data.defect_code || null, alert_key: data.alert_key || null,
      owner: data.owner || '', due_date: data.due_date, status: '待围堵', problem: data.problem || '', containment: data.containment || '',
      root_cause: '', corrective_action: '', verification: '', created_at: new Date().toISOString().slice(0, 10), closed_at: null, kb_doc_id: null,
    };
    capas.push(c);
    if (c.alert_key) setAlert(c.alert_key, { status: '处理中', capa_no: no });
    return decorate(c);
  }
  function capaUpdate(id, data) {
    const c = capas.find((x) => x.id === id);
    if (!c) throw new Error('未找到');
    if (c.status === '已关闭') throw new Error('已关闭的 8D 不能再修改');
    if (data.status === '已关闭') throw new Error('请使用“关闭并回写知识库”完成关闭');
    ['title', 'owner', 'due_date', 'status', 'problem', 'containment', 'root_cause', 'corrective_action', 'verification'].forEach((k) => { if (k in data) c[k] = data[k]; });
    return decorate(c);
  }
  function capaClose(id, data) {
    const patch = Object.assign({}, data);
    delete patch.status;
    const c = capaUpdate(id, patch);
    const missing = [['root_cause', '根本原因'], ['corrective_action', '永久对策'], ['verification', '效果验证']].filter(([k]) => !String(c[k] || '').trim()).map(([, n]) => n);
    if (missing.length) throw new Error('关闭前请补充：' + missing.join('、'));
    const today = new Date().toISOString().slice(0, 10);
    const doc = {
      id: Math.max(0, ...B.docs.map((d) => d.id)) + 1, doc_no: c.capa_no, title: `${c.supplier_name} ${c.title} 8D 报告`.trim(), doc_type: '8D',
      supplier_code: c.supplier_code, material_code: c.material_code, defect_code: c.defect_code, doc_date: today, source: '8D 关闭回写',
      content: ['## D2 问题描述', c.problem || c.title, '', '## D3 围堵措施', c.containment || '（未记录）', '', '## D4 根本原因', c.root_cause, '',
        '## D5-D6 永久对策', c.corrective_action, '', '## D7 效果验证', c.verification, '', '## 经验教训', `本案例由 ${c.capa_no} 关闭时自动回写知识库，责任人：${c.owner || '未指定'}。`].join('\n'),
    };
    B.docs = B.docs.filter((d) => d.doc_no !== doc.doc_no).concat([doc]);
    KB.reindex();
    c.status = '已关闭'; c.closed_at = today; c.kb_doc_id = doc.id;
    if (c.alert_key) setAlert(c.alert_key, { status: '已关闭' });
    return decorate(c);
  }

  // ---------------------------------------------------------------- 路由
  const ROUTES = [
    ['GET', /^\/api\/meta$/, () => B.meta],
    ['GET', /^\/api\/dashboard$/, () => B.dashboard],
    ['GET', /^\/api\/suppliers$/, () => B.suppliers],
    ['GET', /^\/api\/suppliers\/(\w+)$/, (b, code) => {
      const d = clone(B.supplier_details[code]);
      d.alerts = alerts.filter((a) => a.supplier_code === code);
      d.capa = capaList().filter((c) => c.supplier_code === code);
      d.docs = KB.listDocs().filter((x) => x.supplier_code === code);
      return d;
    }],
    ['GET', /^\/api\/alerts$/, () => alerts.slice().sort((a, b) => ((a.status === '已关闭') - (b.status === '已关闭')))],
    ['GET', /^\/api\/alerts\/([\w-]+)$/, (b, key) => details[key]],
    ['POST', /^\/api\/alerts\/([\w-]+)\/status$/, (b, key) => { setAlert(key, { status: b.status }); return { key, status: b.status }; }],
    ['POST', /^\/api\/alerts\/([\w-]+)\/refine$/, () => ({ text: null, error: '在线预览不调用大模型' })],
    ['GET', /^\/api\/kb\/docs$/, () => KB.listDocs()],
    ['GET', /^\/api\/kb\/docs\/(\d+)$/, (b, id) => { const d = KB.docs[id]; return d ? Object.assign({}, d, { sections: splitSections(d.content) }) : null; }],
    ['POST', /^\/api\/kb\/search$/, (b) => KB.answer(b.q || '', b.doc_type || null, b.supplier || null)],
    ['GET', /^\/api\/governance\/dictionary$/, () => B.dictionary],
    ['GET', /^\/api\/governance\/health$/, () => B.health],
    ['GET', /^\/api\/governance\/sample$/, () => ({ csv: B.sample_csv })],
    ['POST', /^\/api\/governance\/validate$/, (b) => validate(b.csv || '')],
    ['POST', /^\/api\/governance\/import$/, () => { throw new Error('在线预览不写入数据库，请在本地运行版本中导入'); }],
    ['GET', /^\/api\/capa$/, () => capaList()],
    ['POST', /^\/api\/capa$/, (b) => capaCreate(b)],
    ['PUT', /^\/api\/capa\/(\d+)$/, (b, id) => capaUpdate(+id, b)],
    ['POST', /^\/api\/capa\/(\d+)\/close$/, (b, id) => capaClose(+id, b)],
  ];

  window.SQMStatic = {
    async handle(method, path, body) {
      for (const [m, re, fn] of ROUTES) {
        const match = m === method && path.match(re);
        if (match) {
          const r = fn(body || {}, ...match.slice(1));
          if (r == null) throw new Error('未找到');
          return clone(r);
        }
      }
      throw new Error('未找到：' + path);
    },
    steps: STEPS,
  };
})();
