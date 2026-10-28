/* 售后故障追踪在线预览用的浏览器端后端：读取构建时导出的数据快照（window.FIELD_BUNDLE），
   在浏览器内实现追溯查询和报修录入校验。逻辑与 sqm/field/records.py 保持一致。
   新增记录只保存在当前页面，统计结果不重算，刷新后恢复为快照状态。 */
(function () {
  'use strict';
  const B = window.FIELD_BUNDLE;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const M = B.get.meta;
  const MODELS = Object.fromEntries(M.models.map((m) => [m.code, m]));
  const FAULTS = Object.fromEntries(M.faults.map((f) => [f.code, f]));
  const PARTS = Object.fromEntries(M.parts.map((p) => [p.code, p]));
  const LINE_NAMES = Object.fromEntries(M.lines.map((l) => [l.code, l.name]));
  const SN_RE = /^([A-Z]{2})-?(\d{3})-?(\d{4})-?(\d{1,5})$/;
  const BATCH_RE = /^([A-Z]{2})-?(\d{3})-?(\d{4})$/;
  const records = B.records;

  function parseSn(sn) {
    const m = String(sn || '').trim().toUpperCase().match(SN_RE);
    if (!m) return null;
    const batch = `${m[1]}${m[2]}-${m[3]}`;
    return [`${m[1]}-${m[2]}`, batch, `${batch}-${String(+m[4]).padStart(5, '0')}`];
  }
  function parseBatch(t) {
    const m = String(t || '').trim().toUpperCase().match(BATCH_RE);
    return m ? `${m[1]}${m[2]}-${m[3]}` : null;
  }
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(s));

  function validate(body) {
    const errors = [], warnings = [];
    const rec = {};
    ['report_date', 'channel', 'model_code', 'sn', 'batch_no', 'install_date', 'fault_code', 'part_code', 'resp', 'handling', 'note']
      .forEach((k) => { const v = body[k]; rec[k] = v == null || v === '' ? null : String(v).trim(); });
    const model = MODELS[rec.model_code];
    if (!model) errors.push('请选择型号');
    if (!isDate(rec.report_date)) errors.push('报修日期格式应为 YYYY-MM-DD');
    if (rec.sn) {
      const p = parseSn(rec.sn);
      if (!p) errors.push('SN 格式不正确，应为 型号-生产年月-流水号，例如 SF101-2507-00123');
      else {
        if (model && p[0] !== rec.model_code) errors.push(`SN 对应型号 ${p[0]}，与所选型号 ${rec.model_code} 不一致`);
        if (rec.batch_no && parseBatch(rec.batch_no) !== p[1]) errors.push('SN 与批次号不一致');
        rec.batch_no = p[1]; rec.sn = p[2];
      }
    } else if (rec.batch_no) rec.batch_no = parseBatch(rec.batch_no) || rec.batch_no.toUpperCase();
    if (rec.batch_no) {
      const b = B.trace[rec.batch_no];
      if (!b) errors.push(`系统中没有批次 ${rec.batch_no}`);
      else if (model && b.batch.model_code !== rec.model_code) errors.push(`批次 ${rec.batch_no} 属于 ${b.batch.model_code}`);
    } else warnings.push('缺少 SN / 批次号：这条记录只计入报修总量，不能进入批次故障率和寿命分析');
    if (rec.install_date) {
      if (!isDate(rec.install_date)) errors.push('安装日期格式应为 YYYY-MM-DD');
      else if (isDate(rec.report_date) && rec.install_date > rec.report_date) errors.push('安装日期晚于报修日期');
    } else warnings.push(`缺少安装日期：使用月数按批次首次出货 + ${B.install_lag} 天估算`);
    const fault = FAULTS[rec.fault_code];
    if (!fault) errors.push('请选择故障现象代码');
    else if (model && fault.line !== model.line) errors.push(`${rec.fault_code} 不是${LINE_NAMES[model.line]}的故障代码`);
    if (rec.part_code) {
      const part = PARTS[rec.part_code];
      if (!part || (model && part.line !== model.line)) errors.push('故障部位代码与产品线不符');
      else if (!rec.resp) rec.resp = part.resp;
    } else { warnings.push('故障部位待拆解确认：请安排回收故障件'); rec.resp = null; }
    rec.returned = [true, 1, '1', 'on', 'true'].includes(body.returned) ? 1 : 0;
    rec.cost = model && rec.handling ? Math.round(model.unit_cost * B.handling[rec.handling] + (rec.handling === '远程指导' ? 0 : B.service_fee)) : 0;
    return { record: rec, errors, warnings };
  }

  function decorate(rec) {
    const m = MODELS[rec.model_code] || {};
    let age = null;
    const b = rec.batch_no && B.trace[rec.batch_no];
    if (b && b.shipments.length) {
      const inst = rec.install_date ? Date.parse(rec.install_date) : Date.parse(b.shipments[0].ship_date) + B.install_lag * 864e5;
      age = Math.round(Math.max(0.05, (Date.parse(rec.report_date) - inst) / 864e5 / 30.44) * 10) / 10;
    }
    return Object.assign({}, rec, { model_name: m.name, line: m.line, fault_name: (FAULTS[rec.fault_code] || {}).name,
      part_name: rec.part_code ? PARTS[rec.part_code].name : null, age });
  }

  function addRecord(body) {
    const r = validate(body);
    if (r.errors.length) throw new Error(r.errors.join('；'));
    const prefix = 'FR' + r.record.report_date.slice(2, 4) + r.record.report_date.slice(5, 7);
    const nums = records.filter((x) => x.rec_no.startsWith(prefix)).map((x) => +x.rec_no.slice(prefix.length));
    const rec = Object.assign(r.record, { rec_no: prefix + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, '0'), source: '手工录入' });
    records.unshift(decorate(rec));
    return { record: rec, warnings: r.warnings };
  }

  function trace(q) {
    q = decodeURIComponent(q).trim().toUpperCase();
    let record = null, bno = null;
    if (q.startsWith('FR')) {
      record = records.find((r) => r.rec_no === q) || null;
      bno = record ? record.batch_no : null;
    } else {
      const sn = parseSn(q);
      bno = sn ? sn[1] : parseBatch(q);
      if (sn) record = records.find((r) => r.sn === sn[2]) || null;
    }
    if (record && !bno) return { query: q, record, batch: null, message: '该记录没有批次码，无法向上追溯' };
    const d = bno && B.trace[bno];
    if (!d) return null;
    return Object.assign(clone(d), { record });
  }

  const ROUTES = [
    ['GET', /^\/api\/field\/records$/, () => records],
    ['POST', /^\/api\/field\/records$/, (b) => addRecord(b)],
    ['POST', /^\/api\/field\/records\/check$/, (b) => validate(b)],
    ['GET', /^\/api\/field\/trace\/([^/]+)$/, (b, q) => trace(q)],
    ['GET', /^\/api\/field\/(\w+)$/, (b, name) => B.get[name]],
  ];

  window.FieldStatic = {
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
  };
})();
