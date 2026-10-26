/* SQM Insight 前端：无框架单页应用，图表为手绘 SVG，可离线运行。 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ 工具
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const int = (n) => Number(n || 0).toLocaleString('zh-CN');
  const pct = (x, d) => (x * 100).toFixed(d == null ? 2 : d) + '%';
  const sci = (p) => (p >= 0.001 ? p.toFixed(4) : p.toExponential(1));
  const LEVEL_CLS = { 高: 'crit', 中: 'warn', 低: 'info' };
  const STATUS_CLS = { 待处理: 'crit', 处理中: 'warn', 已关闭: 'ok' };
  const CAPA_STEPS = ['待围堵', '根因分析', '对策实施', '效果验证', '已关闭'];
  const KIND_FULL = { 人: '人员', 机: '设备/模具', 料: '材料', 法: '工艺方法', 环: '环境', 测: '测量' };

  const API = {
    async req(method, path, body) {
      if (window.SQMStatic) return window.SQMStatic.handle(method, path, body);
      const r = await fetch(path, {
        method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || '请求失败（' + r.status + '）');
      return data;
    },
    get(p) { return this.req('GET', p); },
    post(p, b) { return this.req('POST', p, b || {}); },
    put(p, b) { return this.req('PUT', p, b || {}); },
  };

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制到剪贴板');
    } catch (e) {
      toast('浏览器不允许自动复制，请手动选中文本复制');
    }
  }

  // 图表提示框
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.hidden = true;
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t) { tip.textContent = t.getAttribute('data-tip'); tip.hidden = false; }
  });
  document.addEventListener('mousemove', (e) => {
    if (tip.hidden) return;
    const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = (e.clientY + 16) + 'px';
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest && e.target.closest('[data-tip]')) tip.hidden = true;
  });

  // ------------------------------------------------------------------ 图表
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }

  function trendChart(weeks, target) {
    const W = 720, H = 250, L = 52, R = 16, T = 16, B = 30;
    const max = niceMax(Math.max(target * 1.2, ...weeks.map((w) => w.ppm)));
    const xs = (i) => L + (i / (weeks.length - 1)) * (W - L - R);
    const ys = (v) => T + (1 - v / max) * (H - T - B);
    let g = '';
    for (let i = 0; i <= 4; i++) {
      const v = (max * i) / 4, y = ys(v);
      g += `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/><text x="${L - 8}" y="${y + 4}" text-anchor="end">${int(v)}</text>`;
    }
    weeks.forEach((w, i) => {
      if (i % 4 === 1 || i === weeks.length - 1) g += `<text x="${xs(i)}" y="${H - 8}" text-anchor="middle">${w.week.slice(5)}</text>`;
    });
    const line = weeks.map((w, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(w.ppm).toFixed(1)}`).join('');
    const area = `${line}L${xs(weeks.length - 1)},${ys(0)}L${xs(0)},${ys(0)}Z`;
    const ty = ys(target);
    const last = weeks[weeks.length - 1];
    const dots = weeks.map((w, i) => `<circle cx="${xs(i)}" cy="${ys(w.ppm)}" r="${i === weeks.length - 1 ? 5 : 3}" fill="${w.ppm > target ? 'var(--crit)' : 'var(--accent)'}" stroke="var(--surface)" stroke-width="1.5" data-tip="${w.week} 当周\nPPM ${int(w.ppm)}\n检验 ${w.lots} 批，拒收 ${w.rejected} 批"/>`).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="来料抽样 PPM 周趋势">
      ${g}
      <path d="${area}" fill="var(--accent)" fill-opacity="0.08"/>
      <line x1="${L}" x2="${W - R}" y1="${ty}" y2="${ty}" stroke="var(--crit)" stroke-dasharray="5 4" stroke-width="1.2"/>
      <text x="${W - R}" y="${ty - 6}" text-anchor="end" style="fill:var(--crit)">目标 ${int(target)}</text>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"/>
      ${dots}
      <text x="${xs(weeks.length - 1) - 8}" y="${ys(last.ppm) - 10}" text-anchor="end" style="fill:var(--ink);font-weight:700">${int(last.ppm)}</text>
    </svg>`;
  }

  function paretoChart(items) {
    const top = items.slice(0, 9);
    const rest = items.slice(9).reduce((s, x) => s + x.qty, 0);
    if (rest) top.push({ name: '其他', qty: rest, cum_pct: 100 });
    const W = 720, H = 260, L = 44, R = 44, T = 16, B = 34;
    const max = niceMax(Math.max(...top.map((x) => x.qty)));
    const bw = (W - L - R) / top.length;
    const xs = (i) => L + bw * i + bw / 2;
    const ys = (v) => T + (1 - v / max) * (H - T - B);
    const yp = (p) => T + (1 - p / 100) * (H - T - B);
    let g = '';
    for (let i = 0; i <= 4; i++) {
      const v = (max * i) / 4;
      g += `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${ys(v)}" y2="${ys(v)}"/><text x="${L - 8}" y="${ys(v) + 4}" text-anchor="end">${int(v)}</text><text x="${W - R + 8}" y="${yp(i * 25) + 4}">${i * 25}%</text>`;
    }
    const bars = top.map((x, i) => `<rect x="${xs(i) - bw * 0.32}" y="${ys(x.qty)}" width="${bw * 0.64}" height="${ys(0) - ys(x.qty)}" rx="2" fill="${i < 3 ? 'var(--accent)' : 'var(--ink-3)'}" fill-opacity="${i < 3 ? 1 : 0.45}" data-tip="${esc(x.name)}：${x.qty} 件\n累计 ${x.cum_pct}%"/><text x="${xs(i)}" y="${H - 12}" text-anchor="middle">${esc(x.name)}</text>`).join('');
    const line = top.map((x, i) => `${i ? 'L' : 'M'}${xs(i)},${yp(x.cum_pct)}`).join('');
    const dots = top.map((x, i) => `<circle cx="${xs(i)}" cy="${yp(x.cum_pct)}" r="3" fill="var(--surface)" stroke="var(--ink-2)" stroke-width="1.5"/>`).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="缺陷 Pareto 图">
      ${g}${bars}
      <line x1="${L}" x2="${W - R}" y1="${yp(80)}" y2="${yp(80)}" stroke="var(--warn)" stroke-dasharray="4 4"/>
      <path d="${line}" fill="none" stroke="var(--ink-2)" stroke-width="1.6"/>${dots}
    </svg>`;
  }

  function pChart(an, changes) {
    const pts = an.points;
    if (!pts.length) return '<div class="empty">暂无检验数据</div>';
    const W = 760, H = 270, L = 48, R = 18, T = 26, B = 34;
    const maxY = niceMax(Math.max(...pts.map((p) => Math.max(p.p, p.ucl))) * 1.08);
    const step = (W - L - R) / pts.length;
    const xs = (i) => L + step * i + step / 2;
    const ys = (v) => T + (1 - v / maxY) * (H - T - B);
    let g = '';
    for (let i = 0; i <= 4; i++) {
      const v = (maxY * i) / 4;
      g += `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${ys(v)}" y2="${ys(v)}"/><text x="${L - 6}" y="${ys(v) + 4}" text-anchor="end">${Number((v * 100).toFixed(2))}%</text>`;
    }
    const splitIdx = pts.findIndex((p) => p.phase === '评估');
    let zone = '';
    if (splitIdx >= 0) {
      const zx = L + step * splitIdx;
      zone = `<rect x="${zx}" y="${T}" width="${W - R - zx}" height="${H - T - B}" fill="var(--chart-zone)"/>
        <text x="${zx + 6}" y="${T - 8}">评估窗口（近 42 天）</text><text x="${L}" y="${T - 8}">历史基线期</text>`;
    }
    let months = '';
    let lastM = '';
    pts.forEach((p, i) => {
      const m = p.date.slice(0, 7);
      if (m !== lastM) { if (lastM && i > 2) months += `<text x="${xs(i)}" y="${H - 10}" text-anchor="middle">${m.slice(5)}月</text>`; lastM = m; }
    });
    const stepPath = (key) => pts.map((p, i) => `${i ? 'L' : 'M'}${(L + step * i).toFixed(1)},${ys(p[key]).toFixed(1)}H${(L + step * (i + 1)).toFixed(1)}`).join('');
    const cl = ys(an.p_bar);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(p.p).toFixed(1)}`).join('');
    const marks = (changes || []).map((c) => {
      const i = pts.findIndex((p) => p.date >= c.event_date);
      if (i < 0) return '';
      const x = L + step * i;
      return `<line x1="${x}" x2="${x}" y1="${T}" y2="${H - B}" stroke="var(--ink-2)" stroke-dasharray="2 3"/>
        <g data-tip="${c.event_date} 4M 变更（${KIND_FULL[c.kind] || c.kind}）\n${esc(c.description)}"><rect x="${x - 9}" y="${T + 2}" width="18" height="18" rx="3" fill="var(--ink)"/><text x="${x}" y="${T + 15}" text-anchor="middle" style="fill:var(--bg);font-weight:700">${esc(c.kind)}</text></g>`;
    }).join('');
    const dots = pts.map((p, i) => {
      const sig = p.signals.length > 0;
      const color = p.zone === 3 ? 'var(--crit)' : sig ? 'var(--warn)' : 'var(--accent)';
      const defects = Object.entries(p.defects).map(([k, v]) => (DEFECT_NAMES[k] || k) + '×' + v).join('、') || '无';
      const t = `${p.lot_no}  ${p.date}\n不良 ${p.x}/${p.n}（${pct(p.p)}）\n控制上限 ${pct(p.ucl)}\n缺陷：${defects}\n判定：${p.result}${sig ? '\n判异：' + p.signals.join('/') : ''}`;
      return `<circle cx="${xs(i)}" cy="${ys(p.p)}" r="${sig ? 4.5 : 3}" fill="${sig ? color : 'var(--surface)'}" stroke="${color}" stroke-width="1.6" data-tip="${esc(t)}"/>`;
    }).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="批次不良率控制图">
      ${zone}${g}
      <line x1="${L}" x2="${W - R}" y1="${cl}" y2="${cl}" stroke="var(--ink-3)" stroke-dasharray="6 4"/>
      <path d="${stepPath('u2')}" fill="none" stroke="var(--warn)" stroke-width="1" stroke-dasharray="3 3"/>
      <path d="${stepPath('ucl')}" fill="none" stroke="var(--crit)" stroke-width="1.3"/>
      ${marks}
      <path d="${line}" fill="none" stroke="var(--ink-3)" stroke-width="1" stroke-opacity="0.7"/>
      ${dots}${months}
    </svg>
    <div class="legend"><span><i style="background:var(--accent)"></i>批次不良率</span><span><i style="background:var(--ink-3)"></i>基线 p̄ = ${pct(an.p_bar)}</span><span><i style="background:var(--crit)"></i>控制上限（≈3σ，二项精确）</span><span><i style="background:var(--warn)"></i>2σ 警戒线</span><span><i style="background:var(--ink)"></i>4M 变更</span></div>`;
  }

  let DEFECT_NAMES = {};

  // ------------------------------------------------------------------ 组件片段
  const levelPill = (l) => `<span class="pill ${LEVEL_CLS[l]}">${l}风险</span>`;
  const statusPill = (s) => `<span class="pill ${STATUS_CLS[s] || 'neutral'}">${s}</span>`;
  const resultPill = (r) => `<span class="pill ${r === '拒收' ? 'crit' : 'ok'}">${r}</span>`;

  function alertCard(a) {
    return `<button class="alert-card l-${a.level}" data-alert="${esc(a.key)}">
      <span class="stripe"></span>
      <span class="body">
        <span class="row">${levelPill(a.level)}<span class="pill neutral">${a.tier}</span>${a.capa_no ? `<span class="pill info">${esc(a.capa_no)}</span>` : ''}</span>
        <span class="title">${esc(a.supplier_name)} · ${esc(a.material_name)}：${esc(a.title)}</span>
        <span class="small muted">${esc(a.summary)}</span>
        ${a.changes && a.changes.length ? `<span class="small">关联变更：${a.changes.map((c) => `${c.event_date} ${KIND_FULL[c.kind] || c.kind}变更`).join('；')}</span>` : ''}
      </span>
      <span class="side-r"><span class="risk"><b>${a.risk_score}</b><span>风险评分</span></span>${statusPill(a.status)}</span>
    </button>`;
  }

  function bindAlertCards(root) {
    $$('[data-alert]', root).forEach((el) => el.addEventListener('click', () => go('alert', el.dataset.alert)));
  }

  function sourceList(hits) {
    if (!hits.length) return '<div class="empty">没有相似的历史文件</div>';
    return hits.map((h, i) => `<div class="source">
      <span class="n">[${i + 1}]</span>
      <div><div class="t" data-doc="${h.doc_id}">${esc(h.doc_no)} ${esc(h.title)}</div>
      <div class="row small muted"><span class="pill neutral">${esc(h.doc_type)}</span><span>${esc(h.doc_date || '')}</span><span>章节：${esc(h.heading)}</span>${h.source !== '内置知识库' ? `<span class="pill ok">${esc(h.source)}</span>` : ''}</div>
      <div class="snip">${h.snippet.map(([t, hit]) => (hit ? `<mark>${esc(t)}</mark>` : esc(t))).join('')}</div></div>
    </div>`).join('');
  }

  function bindDocs(root) {
    $$('[data-doc]', root).forEach((el) => el.addEventListener('click', () => openDoc(el.dataset.doc)));
  }

  function drawer(html) {
    closeDrawer();
    const o = document.createElement('div');
    o.className = 'overlay';
    o.id = 'overlay';
    o.innerHTML = `<div class="drawer" role="dialog" aria-modal="true">${html}</div>`;
    o.addEventListener('click', (e) => { if (e.target === o || e.target.closest('[data-close]')) closeDrawer(); });
    document.body.appendChild(o);
    return $('.drawer', o);
  }
  function closeDrawer() { const o = $('#overlay'); if (o) o.remove(); }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  async function openDoc(id) {
    const d = await API.get('/api/kb/docs/' + id);
    drawer(`<div class="drawer-h"><div><div class="label">${esc(d.doc_type)} · ${esc(d.doc_no)}</div><h3>${esc(d.title)}</h3>
      <div class="row small muted"><span>${esc(d.doc_date || '')}</span>${d.supplier_code ? `<span>供应商 ${esc(d.supplier_code)}</span>` : ''}${d.defect_code ? `<span>缺陷 ${esc(DEFECT_NAMES[d.defect_code] || d.defect_code)}</span>` : ''}<span>来源：${esc(d.source)}</span></div></div>
      <button class="close-x" data-close aria-label="关闭">×</button></div>
      <div class="doc-view">${d.sections.map(([h, t]) => `<h4>${esc(h)}</h4><div class="sec">${esc(t)}</div>`).join('')}</div>`);
  }

  // ------------------------------------------------------------------ 视图：质量总览
  async function viewOverview(root) {
    const d = await API.get('/api/dashboard');
    const c = d.kpi.current, p = d.kpi.previous;
    const delta = (a, b, lowerBetter, unit) => {
      if (!b) return '<span class="delta muted">上期无数据</span>';
      const diff = a - b;
      const cls = diff === 0 ? 'muted' : (diff > 0) === lowerBetter ? 'up-bad' : 'up-good';
      return `<span class="delta ${cls}">较上期 ${diff > 0 ? '+' : ''}${unit === '%' ? diff.toFixed(2) + ' 个百分点' : int(diff)}</span>`;
    };
    root.innerHTML = `
      <div class="kpis">
        <div class="panel kpi"><span class="label">近 30 天检验批次</span><span class="kpi-value">${int(c.lots)}<small>批</small></span>${delta(c.lots, p.lots, false, '')}</div>
        <div class="panel kpi ${c.reject_rate > 5 ? 'alarm' : ''}"><span class="label">批次拒收率</span><span class="kpi-value">${c.reject_rate.toFixed(1)}<small>%</small></span>${delta(c.reject_rate, p.reject_rate, true, '%')}</div>
        <div class="panel kpi ${c.ppm > d.kpi.ppm_target ? 'alarm' : ''}"><span class="label">抽样 PPM（目标 ${int(d.kpi.ppm_target)}）</span><span class="kpi-value">${int(c.ppm)}</span>${delta(c.ppm, p.ppm, true, '')}</div>
        <div class="panel kpi ${d.alerts.high ? 'alarm' : ''}"><span class="label">待处理预警</span><span class="kpi-value">${d.alerts.total}<small>条</small></span><span class="delta"><span style="color:var(--crit)">高 ${d.alerts.high}</span> · <span style="color:var(--warn)">中 ${d.alerts.medium}</span> · 低 ${d.alerts.low}</span></div>
        <div class="panel kpi ${d.capa.overdue ? 'alarm' : ''}"><span class="label">未关闭 8D</span><span class="kpi-value">${d.capa.open}<small>项</small></span><span class="delta ${d.capa.overdue ? 'up-bad' : 'muted'}">逾期 ${d.capa.overdue} 项</span></div>
      </div>
      <div class="grid g-3-1">
        <section class="panel"><div class="panel-h"><h2>来料抽样 PPM 周趋势</h2><span class="panel-sub">近 26 周 · 全部供应商 · 悬停数据点查看当周批次</span></div>
          <div class="panel-b">${trendChart(d.weekly, d.kpi.ppm_target)}</div></section>
        <section class="panel"><div class="panel-h"><h2>需优先处理</h2><button class="btn sm" id="to-alerts">全部预警</button></div>
          <div class="panel-b stack">${d.alerts.top.map((a) => `<button class="alert-card l-${a.level}" data-alert="${esc(a.key)}" style="grid-template-columns:5px minmax(0,1fr) auto">
            <span class="stripe"></span><span class="body" style="padding:9px 0"><span class="title" style="font-size:13.5px">${esc(a.supplier_name)}：${esc(a.title)}</span><span class="small muted">${esc(a.material_name)} · ${a.tier}</span></span>
            <span class="side-r" style="padding:9px 12px 9px 0"><span class="risk"><b style="font-size:17px">${a.risk_score}</b><span>风险</span></span></span></button>`).join('') || '<div class="empty">没有待处理预警</div>'}</div></section>
      </div>
      <div class="grid g-1-1">
        <section class="panel"><div class="panel-h"><h2>缺陷 Pareto</h2><span class="panel-sub">近 90 天 · 按不良件数 · 虚线为 80%</span></div>
          <div class="panel-b">${paretoChart(d.pareto)}</div></section>
        <section class="panel"><div class="panel-h"><h2>供应商质量排名</h2><span class="panel-sub">近 90 天综合评分</span></div>
          <div class="panel-b table-wrap"><table><thead><tr><th>#</th><th>供应商</th><th>等级</th><th>评分</th><th class="num">PPM</th><th class="num">近30天</th></tr></thead><tbody>
          ${d.ranking.map((s) => `<tr class="click" data-sup="${s.code}"><td class="num muted">${s.rank}</td><td>${esc(s.name)} <span class="muted small">${s.category}</span></td><td><span class="grade ${s.grade}">${s.grade}</span></td>
            <td><div class="row" style="flex-wrap:nowrap"><span class="num" style="width:34px">${s.score.toFixed(1)}</span><span class="scorebar"><i style="width:${s.score}%"></i></span></div></td>
            <td class="num">${int(s.ppm_90d)}</td><td class="num" style="color:${s.ppm_30d > s.ppm_prior * 1.5 && s.ppm_30d > 3000 ? 'var(--crit)' : 'inherit'}">${int(s.ppm_30d)}${s.ppm_30d > s.ppm_prior * 1.5 && s.ppm_30d > 3000 ? ' ↑' : ''}</td></tr>`).join('')}
          </tbody></table></div></section>
      </div>`;
    bindAlertCards(root);
    $('#to-alerts', root).addEventListener('click', () => go('alerts'));
    $$('[data-sup]', root).forEach((el) => el.addEventListener('click', () => go('supplier', el.dataset.sup)));
  }

  // ------------------------------------------------------------------ 视图：供应商
  async function viewSuppliers(root) {
    const list = await API.get('/api/suppliers');
    root.innerHTML = `<section class="panel"><div class="panel-h"><h2>供应商质量画像</h2><span class="panel-sub">点击供应商查看控制图、批次追溯、4M 变更与 8D 履历</span></div>
      <div class="panel-b table-wrap"><table><thead><tr><th>排名</th><th>供应商</th><th>品类</th><th>分级</th><th>SQE</th><th class="num">批次（90天）</th><th class="num">批次合格率</th><th class="num">PPM（90天）</th><th class="num">近30天 PPM</th><th class="num">未关闭/逾期 8D</th><th>评分</th></tr></thead><tbody>
      ${list.map((s) => `<tr class="click" data-sup="${s.code}"><td class="num muted">${s.rank}</td><td><b>${esc(s.name)}</b> <span class="muted small">${s.code}</span></td><td>${esc(s.category)}</td><td>${esc(s.tier)}</td><td>${esc(s.sqe_owner)}</td>
        <td class="num">${s.lots_90d}</td><td class="num">${s.accept_rate.toFixed(1)}%</td><td class="num">${int(s.ppm_90d)}</td><td class="num">${int(s.ppm_30d)}</td>
        <td class="num">${s.open_capa} / <span style="color:${s.overdue_capa ? 'var(--crit)' : 'inherit'}">${s.overdue_capa}</span></td>
        <td><div class="row" style="flex-wrap:nowrap"><span class="grade ${s.grade}">${s.grade}</span><span class="num">${s.score.toFixed(1)}</span><span class="scorebar"><i style="width:${s.score}%"></i></span></div></td></tr>`).join('')}
      </tbody></table>
      <p class="small muted">评分口径：PPM 得分 50 × max(0, 1 − PPM/20000) ＋ 批次合格率 × 30 ＋ 8D 响应 20 − 8×逾期数 − 3×未关闭数。A ≥ 90，B ≥ 80，C ≥ 70，D &lt; 70。</p></div></section>`;
    $$('[data-sup]', root).forEach((el) => el.addEventListener('click', () => go('supplier', el.dataset.sup)));
  }

  async function viewSupplier(root, code) {
    const d = await API.get('/api/suppliers/' + code);
    const s = d.supplier, sc = d.score;
    setTitle(s.name, [['suppliers', '供应商'], [null, s.name]]);
    root.innerHTML = `
      <section class="panel"><div class="panel-b spread" style="padding-top:16px">
        <div class="stack" style="gap:6px"><div class="row"><h2 style="margin:0;font-size:19px">${esc(s.name)}</h2><span class="muted">${s.code}</span></div>
          <div class="row"><span class="pill neutral">${esc(s.category)}</span><span class="pill neutral">${esc(s.tier)}供应商</span><span class="pill neutral">${esc(s.region)}</span><span class="pill info">SQE：${esc(s.sqe_owner)}</span></div></div>
        <div class="row" style="gap:18px">
          <div class="stack" style="gap:2px;align-items:center"><span class="grade ${sc.grade}" style="width:42px;height:42px;font-size:20px">${sc.grade}</span><span class="small muted">第 ${sc.rank} 名</span></div>
          <div class="stack" style="gap:2px"><span class="kpi-value">${sc.score.toFixed(1)}</span><span class="small muted">PPM ${sc.score_parts.ppm}/50 · 合格率 ${sc.score_parts.accept}/30 · 8D ${sc.score_parts.capa}/20</span></div>
        </div></div></section>
      ${d.alerts.length ? `<section class="stack"><h3 style="margin:0;font-size:15px">当前预警</h3>${d.alerts.map(alertCard).join('')}</section>` : ''}
      ${d.charts.map((c) => `<section class="panel"><div class="panel-h"><h2>${esc(c.material.name)} <span class="muted small">${c.material.code}${c.material.critical ? ' · 关键物料' : ''}</span></h2><span class="panel-sub">批次不良率 p 控制图</span></div>
        <div class="panel-b">${pChart(c.analysis, d.changes.filter((x) => x.material_code === c.material.code))}
        ${c.analysis.rules.length ? `<div class="stack" style="gap:4px;margin-top:10px">${c.analysis.rules.map((r) => `<div class="small" style="color:var(--crit)">● ${esc(r)}</div>`).join('')}</div>` : '<div class="small muted" style="margin-top:8px">评估窗口内未发现统计异常。</div>'}</div></section>`).join('')}
      <div class="grid g-2">
        <section class="panel"><div class="panel-h"><h2>4M 变更记录</h2><span class="panel-sub">人 · 机 · 料 · 法 · 环 · 测</span></div><div class="panel-b timeline">
          ${d.changes.map((c) => `<div class="tl-item"><span class="d">${c.event_date}</span><span><span class="kind">${esc(c.kind)}</span>${esc(c.description)} ${c.notified ? '' : '<span class="pill crit">未按 PCN 通知</span>'}</span></div>`).join('') || '<div class="empty">无变更记录</div>'}</div></section>
        <section class="panel"><div class="panel-h"><h2>8D / CAPA 履历</h2></div><div class="panel-b">
          ${d.capa.map((c) => `<div class="check"><span><b>${esc(c.capa_no)}</b> ${esc(c.title)}</span>${statusPill(c.status === '已关闭' ? '已关闭' : '处理中')}</div>`).join('') || '<div class="empty">无 8D 记录</div>'}
          ${d.docs.length ? `<div class="label" style="margin-top:12px">知识库相关文件</div>${d.docs.map((x) => `<div class="check"><a href="javascript:void 0" data-doc="${x.id}">${esc(x.doc_no)} ${esc(x.title)}</a><span class="muted small">${esc(x.doc_type)}</span></div>`).join('')}` : ''}</div></section>
      </div>
      <section class="panel"><div class="panel-h"><h2>批次追溯</h2><span class="panel-sub">最近 40 批 IQC 记录</span></div><div class="panel-b table-wrap"><table>
        <thead><tr><th>批次号</th><th>检验日期</th><th>物料</th><th class="num">批量</th><th class="num">抽样</th><th class="num">不良</th><th>缺陷明细</th><th>判定</th><th>检验员</th></tr></thead><tbody>
        ${d.lots.map((l) => `<tr><td class="mono">${esc(l.lot_no)}</td><td class="num">${l.inspect_date}</td><td>${esc(l.material_code)}</td><td class="num">${int(l.lot_qty)}</td><td class="num">${l.sample_size}</td><td class="num">${l.defect_qty}</td><td>${esc(l.defects)}</td><td>${resultPill(l.result)}</td><td>${esc(l.inspector)}</td></tr>`).join('')}
      </tbody></table></div></section>`;
    bindAlertCards(root);
    bindDocs(root);
  }

  // ------------------------------------------------------------------ 视图：智能预警
  const alertFilter = { level: '全部', open: true };
  async function viewAlerts(root) {
    const all = await API.get('/api/alerts');
    const tierCount = (t) => all.filter((a) => a.tier === t && a.status !== '已关闭').length;
    const draw = () => {
      const list = all.filter((a) => (alertFilter.level === '全部' || a.level === alertFilter.level) && (!alertFilter.open || a.status !== '已关闭'));
      $('#alert-list', root).innerHTML = list.map(alertCard).join('') || '<div class="panel empty">没有符合条件的预警</div>';
      bindAlertCards(root);
      $$('[data-lv]', root).forEach((b) => b.classList.toggle('on', b.dataset.lv === alertFilter.level));
      $('#only-open', root).classList.toggle('on', alertFilter.open);
    };
    root.innerHTML = `
      <div class="tiers">
        <div class="panel tier"><span class="tier-n">第一层 · 规则预警</span><strong>${tierCount('规则预警')} 条待处理</strong><p>质量红线与业务规则：安全关键缺陷出现即预警、8D 逾期未关闭。</p></div>
        <div class="panel tier"><span class="tier-n">第二层 · 统计预警</span><strong>${tierCount('统计预警')} 条待处理</strong><p>以历史批次为基线，按二项分布精确计算控制限，识别单点超限、连续偏高和整体趋势上升。</p></div>
        <div class="panel tier"><span class="tier-n">第三层 · AI 关联分析</span><strong>风险评分 + 历史案例</strong><p>自动关联异常前的 4M 变更、检索相似 8D，按可解释的加权规则给出风险评分并生成简报。</p></div>
      </div>
      <div class="spread"><div class="row">${['全部', '高', '中', '低'].map((l) => `<button class="chip" data-lv="${l}">${l === '全部' ? '全部等级' : l + '风险'}</button>`).join('')}</div>
        <button class="chip" id="only-open">只看未关闭</button></div>
      <div class="stack" id="alert-list"></div>`;
    $$('[data-lv]', root).forEach((b) => b.addEventListener('click', () => { alertFilter.level = b.dataset.lv; draw(); }));
    $('#only-open', root).addEventListener('click', () => { alertFilter.open = !alertFilter.open; draw(); });
    draw();
  }

  async function viewAlert(root, key) {
    const a = await API.get('/api/alerts/' + key);
    setTitle(a.title, [['alerts', '智能预警'], [null, a.supplier_name + ' · ' + a.material_name]]);
    const an = a.analysis;
    const signalPts = a.tier === '统计预警' ? an.points.filter((p) => p.signals.length) : [];
    const maxF = Math.max(...a.risk_factors.map((f) => f.points), 1);
    root.innerHTML = `
      <section class="panel"><div class="panel-b stack" style="padding-top:16px">
        <div class="spread" style="align-items:flex-start">
          <div class="stack" style="gap:6px"><div class="row">${levelPill(a.level)}<span class="pill neutral">${a.tier}</span>${statusPill(a.status)}${a.capa_no ? `<span class="pill info">已关联 ${esc(a.capa_no)}</span>` : ''}</div>
            <h2 style="margin:0;font-size:19px">${esc(a.title)}</h2>
            <div class="small"><a href="javascript:void 0" id="to-sup">${esc(a.supplier_name)}</a> · ${esc(a.material_name)} <span class="muted">${esc(a.material_code)}</span>${a.defect_name ? ` · 主要缺陷：${esc(a.defect_name)}` : ''}</div></div>
          <div class="risk"><b style="font-size:34px">${a.risk_score}</b><span>风险评分 / 100</span></div>
        </div>
        <div>${esc(a.summary)}</div>
        <div class="row">
          ${a.capa_no ? '<button class="btn" id="to-capa">查看 8D</button>' : '<button class="btn primary" id="new-capa">发起 8D</button>'}
          ${a.status === '待处理' ? '<button class="btn" data-st="处理中">标记为处理中</button>' : ''}
          ${a.status !== '已关闭' ? '<button class="btn" data-st="已关闭">关闭预警</button>' : '<button class="btn" data-st="待处理">重新打开</button>'}
        </div></div></section>
      ${a.tier === '统计预警' ? `<section class="panel"><div class="panel-h"><h2>批次不良率控制图</h2><span class="panel-sub">悬停数据点查看批次详情；黑色方块为 4M 变更</span></div><div class="panel-b">${pChart(an, a.changes)}</div></section>` : ''}
      <div class="grid g-1-1">
        <section class="panel"><div class="panel-h"><h2>判异依据</h2></div><div class="panel-b stack">
          ${a.rules.map((r) => `<div class="small">● ${esc(r)}</div>`).join('')}
          ${signalPts.length ? `<div class="table-wrap"><table><thead><tr><th>批次</th><th>日期</th><th class="num">不良/抽样</th><th class="num">尾概率</th><th>规则</th></tr></thead><tbody>
            ${signalPts.map((p) => `<tr><td class="mono">${esc(p.lot_no)}</td><td class="num">${p.date}</td><td class="num">${p.x}/${p.n}</td><td class="num">${sci(p.p_value)}</td><td>${p.signals.join(' ')}</td></tr>`).join('')}</tbody></table></div>` : ''}
          <div class="label" style="margin-top:6px">异常前 30 天 4M 变更</div>
          ${a.changes.length ? a.changes.map((c) => `<div class="tl-item"><span class="d">${c.event_date}</span><span><span class="kind">${esc(c.kind)}</span>${esc(c.description)}${c.notified ? '' : ' <span class="pill crit">未按 PCN 通知</span>'}<span class="muted small">（异常前 ${c.days_before} 天）</span></span></div>`).join('') : '<div class="small muted">未记录到相关变更。</div>'}
        </div></section>
        <section class="panel"><div class="panel-h"><h2>风险评分构成</h2><span class="panel-sub">每一项都来自数据，可追溯</span></div><div class="panel-b stack">
          ${a.risk_factors.map((f) => `<div class="factor"><span>${esc(f.factor)}</span><span class="bar"><i style="width:${(f.points / maxF) * 100}%"></i></span><b class="num" style="text-align:right">+${f.points}</b></div>`).join('')}
          <div class="small muted">评分用于排序和分派优先级，不替代人工判断。</div></div></section>
      </div>
      <section class="panel"><div class="panel-h"><h2>历史相似案例</h2><span class="panel-sub">知识库检索 · 点击标题查看全文</span></div><div class="panel-b">${sourceList(a.similar || [])}</div></section>
      <section class="panel"><div class="panel-h"><h2>异常分析简报</h2><div class="row"><button class="btn sm" id="copy-brief">复制简报</button><button class="btn sm" id="refine" ${META.llm && META.llm.enabled ? '' : 'disabled data-tip="' + esc((META.llm && META.llm.reason) || '未启用大模型') + '"'}>大模型润色</button></div></div>
        <div class="panel-b stack"><pre class="brief" id="brief">${esc(a.brief)}</pre><div id="refined"></div></div></section>`;
    $('#to-sup', root).addEventListener('click', () => go('supplier', a.supplier_code));
    bindDocs(root);
    $('#copy-brief', root).addEventListener('click', () => copyText(a.brief));
    $$('[data-st]', root).forEach((b) => b.addEventListener('click', async () => {
      await API.post('/api/alerts/' + key + '/status', { status: b.dataset.st });
      toast('预警状态已更新为：' + b.dataset.st);
      refreshCounts();
      viewAlert(root, key);
    }));
    const toCapa = $('#to-capa', root);
    if (toCapa) toCapa.addEventListener('click', () => go('capa'));
    const nc = $('#new-capa', root);
    if (nc) nc.addEventListener('click', () => capaCreateDrawer({
      title: `${a.material_name}${a.defect_name || ''}异常`, supplier_code: a.supplier_code, material_code: a.material_code,
      defect_code: a.defect_code, alert_key: a.key, owner: '',
      problem: a.summary + '\n' + a.rules.join('；'),
      containment: '隔离在库及在途批次，后续来料加严检验；通知供应商 24 小时内回复围堵措施。',
    }, () => viewAlert(root, key)));
    const rf = $('#refine', root);
    if (rf && !rf.disabled) rf.addEventListener('click', async () => {
      rf.disabled = true; rf.textContent = '生成中…';
      const r = await API.post('/api/alerts/' + key + '/refine');
      $('#refined', root).innerHTML = r.text ? `<div class="label">大模型润色版（仅改写表达，不新增事实）</div><pre class="brief">${esc(r.text)}</pre>` : `<div class="caution">${esc(r.error)}</div>`;
      rf.disabled = false; rf.textContent = '大模型润色';
    });
  }

  // ------------------------------------------------------------------ 视图：知识库
  const kbState = { q: '滤网异味的原因和对策', type: '', result: null };
  const EXAMPLES = ['滤网异味的原因和对策', '前壳划伤 模具更换', '回流焊虚焊 锡膏', 'Push Mura 怎么改善', '供应商变更没有通知', '不良率口径'];
  async function viewKnowledge(root) {
    const docs = await API.get('/api/kb/docs');
    const types = Array.from(new Set(docs.map((d) => d.doc_type)));
    const llmOn = META.llm && META.llm.enabled;
    root.innerHTML = `
      <section class="panel"><div class="panel-b stack" style="padding-top:16px">
        <form class="search-box" id="kb-form"><input type="text" id="kb-q" value="${esc(kbState.q)}" placeholder="例如：这个物料以前有没有发生过异味？原因和措施是什么？" aria-label="问题">
          <select id="kb-type" style="width:auto"><option value="">全部类型</option>${types.map((t) => `<option ${t === kbState.type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
          <button class="btn primary" type="submit">检索</button></form>
        <div class="spread"><div class="row"><span class="small muted">试试：</span>${EXAMPLES.map((e) => `<button class="chip" data-ex="${esc(e)}">${esc(e)}</button>`).join('')}</div>
          <label class="row small" ${llmOn ? '' : `data-tip="${esc((META.llm && META.llm.reason) || '')}"`}><input type="checkbox" id="kb-llm" ${llmOn ? '' : 'disabled'}> 用大模型生成回答</label></div>
      </div></section>
      <div class="grid g-1-1" id="kb-result"><div class="panel loading">检索中…</div></div>
      <section class="panel"><div class="panel-h"><h2>文件库</h2><span class="panel-sub">${docs.length} 份文件 · 8D、PFMEA、SOP、审核报告、经验教训；8D 关闭后自动回写</span></div>
        <div class="panel-b table-wrap"><table><thead><tr><th>编号</th><th>标题</th><th>类型</th><th>供应商</th><th>缺陷</th><th>日期</th><th>来源</th></tr></thead><tbody>
        ${docs.map((d) => `<tr class="click" data-doc="${d.id}"><td class="mono">${esc(d.doc_no)}</td><td>${esc(d.title)}</td><td>${esc(d.doc_type)}</td><td>${esc(d.supplier_code || '—')}</td><td>${esc(DEFECT_NAMES[d.defect_code] || '—')}</td><td class="num">${esc(d.doc_date || '')}</td><td class="small">${esc(d.source)}</td></tr>`).join('')}
        </tbody></table></div></section>`;
    bindDocs(root);
    const run = async () => {
      kbState.q = $('#kb-q', root).value.trim();
      kbState.type = $('#kb-type', root).value;
      if (!kbState.q) return;
      $('#kb-result', root).innerHTML = '<div class="panel loading">检索中…</div>';
      const r = await API.post('/api/kb/search', { q: kbState.q, doc_type: kbState.type, use_llm: $('#kb-llm', root).checked });
      renderAnswer($('#kb-result', root), r);
    };
    $('#kb-form', root).addEventListener('submit', (e) => { e.preventDefault(); run(); });
    $$('[data-ex]', root).forEach((b) => b.addEventListener('click', () => { $('#kb-q', root).value = b.dataset.ex; run(); }));
    run();
  }

  function renderAnswer(el, r) {
    const refBtn = (n) => `<button class="ref" data-ref="${n}">${n}</button>`;
    el.innerHTML = `
      <section class="panel"><div class="panel-h"><h2>${r.mode === 'llm' ? '大模型回答（基于检索资料）' : '证据式摘要'}</h2><span class="panel-sub">${r.mode === 'llm' ? '已标注出处，请核对原文' : '要点摘自原文，未经大模型改写'}</span></div>
        <div class="panel-b stack">
          ${r.detected_defects.length ? `<div class="small">识别到缺陷：${r.detected_defects.map((d) => `<span class="pill info">${d.code} ${esc(d.name)}</span>`).join(' ')}（已自动扩展同义词）</div>` : ''}
          <div>${esc(r.intro)}</div>
          ${r.llm_answer ? `<pre class="brief">${esc(r.llm_answer)}</pre>` : ''}
          ${r.llm_error ? `<div class="caution">大模型未返回结果：${esc(r.llm_error)}。以下为本地证据式摘要。</div>` : ''}
          ${r.mode !== 'llm' ? r.groups.map((g) => `<div class="answer-group"><h4>${g.label}</h4><ul>${g.items.map((i) => `<li>${esc(i.text)}${refBtn(i.ref)}</li>`).join('')}</ul></div>`).join('') : ''}
          ${r.hits.length ? `<div class="caution">${esc(r.caution)}</div>` : ''}
        </div></section>
      <section class="panel"><div class="panel-h"><h2>引用来源</h2><span class="panel-sub">按相关度排序</span></div><div class="panel-b">${sourceList(r.hits)}</div></section>`;
    bindDocs(el);
    $$('[data-ref]', el).forEach((b) => b.addEventListener('click', () => { const h = r.hits[b.dataset.ref - 1]; if (h) openDoc(h.doc_id); }));
  }

  // ------------------------------------------------------------------ 视图：数据治理
  const govState = { csv: null, report: null };
  async function viewGovernance(root) {
    const [health, dict] = await Promise.all([API.get('/api/governance/health'), API.get('/api/governance/dictionary')]);
    if (govState.csv == null) govState.csv = (await API.get('/api/governance/sample')).csv;
    const isStatic = !!window.SQMStatic;
    root.innerHTML = `
      <div class="grid g-1-1">
        <section class="panel"><div class="panel-h"><h2>系统数据健康检查</h2><span class="panel-sub">${int(health.totals.lots)} 个批次 · ${health.totals.defect_codes} 个标准缺陷代码 · ${health.totals.aliases} 个同义词</span></div>
          <div class="panel-b">${health.checks.map((c) => `<div class="check"><span>${esc(c.check)}</span>${c.ok ? '<span class="pill ok">通过</span>' : `<span class="pill crit">${c.violations} 项不符合</span>`}</div>`).join('')}</div></section>
        <section class="panel"><div class="panel-h"><h2>指标口径</h2><span class="panel-sub">统一定义，避免各部门算法不一致</span></div>
          <div class="panel-b">${dict.metrics.map((m) => `<div class="check" style="flex-direction:column;gap:2px"><span><b>${esc(m.name)}</b>　<span class="mono">${esc(m.formula)}</span></span><span class="small muted">${esc(m.note)}</span></div>`).join('')}</div></section>
      </div>
      <section class="panel"><div class="panel-h"><h2>IQC 数据导入与校验</h2><span class="panel-sub">粘贴 CSV 或选择文件；系统自动检查缺失、重复、编码、日期、单位与缺陷名称</span></div>
        <div class="panel-b stack">
          <textarea id="csv" rows="7" class="mono" spellcheck="false" aria-label="CSV 数据">${esc(govState.csv)}</textarea>
          <div class="row">
            <button class="btn primary" id="validate">校验数据</button>
            <button class="btn" id="do-import" ${isStatic ? 'disabled data-tip="在线预览不写入数据库；本地运行版本可导入"' : ''}>导入合格数据</button>
            <button class="btn" id="load-sample">载入示例（含典型问题）</button>
            <label class="btn">选择 CSV 文件<input type="file" id="file" accept=".csv,text/csv" hidden></label>
            ${isStatic ? '' : '<a class="btn" href="/api/export/lots.csv">导出全部批次 CSV</a>'}
          </div>
          <div id="report"></div>
        </div></section>
      <section class="panel"><div class="panel-h"><h2>标准缺陷代码库</h2><span class="panel-sub">同一问题在不同系统叫法不同，统一映射后才能汇总分析</span></div>
        <div class="panel-b table-wrap"><table><thead><tr><th>代码</th><th>标准名称</th><th>类别</th><th>严重度</th><th>同义词（自动映射）</th></tr></thead><tbody>
        ${dict.defects.map((d) => `<tr><td class="mono">${d.code}</td><td><b>${esc(d.name)}</b> ${d.safety ? '<span class="pill crit">安全关键</span>' : ''}</td><td>${esc(d.category)}</td><td>${d.severity}</td><td class="small">${d.aliases.map(esc).join('、')}</td></tr>`).join('')}
        </tbody></table><p class="small muted">笼统描述不自动映射，导入时提示人工确认：${dict.ambiguous.map(esc).join('、')}</p></div></section>`;
    const csvEl = $('#csv', root);
    csvEl.addEventListener('input', () => { govState.csv = csvEl.value; });
    const validate = async () => {
      govState.report = await API.post('/api/governance/validate', { csv: csvEl.value });
      renderReport($('#report', root), govState.report);
    };
    $('#validate', root).addEventListener('click', validate);
    $('#load-sample', root).addEventListener('click', async () => { govState.csv = csvEl.value = (await API.get('/api/governance/sample')).csv; validate(); });
    $('#file', root).addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => { govState.csv = csvEl.value = String(rd.result); validate(); };
      rd.readAsText(f, 'utf-8');
    });
    $('#do-import', root).addEventListener('click', async () => {
      const r = await API.post('/api/governance/import', { csv: csvEl.value });
      toast(`已导入 ${r.inserted} 个合格批次，其余 ${r.total - r.inserted} 行需修正`);
      renderReport($('#report', root), r);
    });
    validate();
  }

  function renderReport(el, r) {
    const cls = { 通过: 'ok', 已修正: 'info', 待确认: 'warn', 错误: 'crit' };
    el.innerHTML = `<div class="stack">
      ${r.missing_columns.length ? `<div class="caution">缺少必要的列：${r.missing_columns.join('、')}</div>` : ''}
      <div class="spread"><div class="row"><span class="kpi-value">${r.quality_score}<small>%</small></span><span class="small muted">可直接入库比例<br>${r.importable} / ${r.total} 行</span></div>
        <div class="row">${Object.entries(r.summary).map(([k, v]) => `<span class="pill ${cls[k]}">${k} ${v}</span>`).join('')}</div></div>
      <div class="dims">${Object.entries(r.dimensions).map(([k, v]) => `<div class="dim"><div class="label">${k}</div><b>${v}%</b></div>`).join('')}</div>
      ${r.inserted != null ? `<div class="pill ok" style="align-self:flex-start">本次写入 ${r.inserted} 行</div>` : ''}
      <div class="table-wrap"><table><thead><tr><th>行</th><th>批次号</th><th>供应商</th><th>物料</th><th>日期</th><th class="num">抽样</th><th class="num">不良</th><th>标准缺陷</th><th>状态</th><th>检查结果</th></tr></thead><tbody>
      ${r.rows.map((x) => `<tr><td class="num muted">${x.line}</td><td class="mono">${esc(x.clean.lot_no)}</td><td>${esc(x.clean.supplier_code)}</td><td class="mono">${esc(x.clean.material_code)}</td><td class="num">${esc(x.clean.inspect_date)}</td><td class="num">${esc(x.clean.sample_size)}</td><td class="num">${esc(x.clean.defect_qty)}</td>
        <td>${x.clean.defect_code ? `${x.clean.defect_code} ${esc(DEFECT_NAMES[x.clean.defect_code] || '')}` : '—'}</td><td><span class="pill ${cls[x.status]}">${x.status}</span></td>
        <td>${x.issues.map((i) => `<div class="issue ${i.level}">${i.level === 'error' ? '✕' : i.level === 'fixed' ? '✓' : '!'} <span>${esc(i.field)}：${esc(i.msg)}</span></div>`).join('') || '<span class="muted small">无问题</span>'}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  }

  // ------------------------------------------------------------------ 视图：改善闭环
  async function viewCapa(root) {
    const list = await API.get('/api/capa');
    const count = (s) => list.filter((c) => c.status === s).length;
    root.innerHTML = `
      <div class="pipeline">${CAPA_STEPS.map((s, i) => `<div class="stage"><span class="label">${['D1–D3', 'D4', 'D5–D6', 'D7', 'D8'][i]} · ${s}</span><b>${count(s)}</b></div>`).join('')}</div>
      <section class="panel"><div class="panel-h"><h2>8D / CAPA 清单</h2><button class="btn primary sm" id="new-capa">新建 8D</button></div>
        <div class="panel-b table-wrap"><table><thead><tr><th>编号</th><th>问题</th><th>供应商</th><th>缺陷</th><th>责任人</th><th>完成期限</th><th>进度</th></tr></thead><tbody>
        ${list.map((c) => `<tr class="click" data-capa="${c.id}"><td class="mono">${esc(c.capa_no)}</td><td>${esc(c.title)}${c.alert_key ? ' <span class="pill info">来自预警</span>' : ''}</td><td>${esc(c.supplier_name || '')}</td><td>${esc(c.defect_name || '—')}</td><td>${esc(c.owner || '—')}</td>
          <td class="num" style="color:${c.overdue ? 'var(--crit)' : 'inherit'}">${esc(c.due_date)}${c.overdue ? ' 逾期' : ''}</td>
          <td><div class="steps">${CAPA_STEPS.map((s, i) => { const cur = CAPA_STEPS.indexOf(c.status); return `<span class="${i < cur ? 'done' : i === cur ? 'cur' : ''}">${s}</span>`; }).join('')}</div></td></tr>`).join('') || '<tr><td colspan="7" class="empty">暂无 8D</td></tr>'}
        </tbody></table><p class="small muted">闭环规则：关闭 8D 时须填写根本原因、永久对策和效果验证，关闭后自动生成 8D 报告写入知识库，下次同类预警可被检索到。</p></div></section>`;
    $('#new-capa', root).addEventListener('click', () => capaCreateDrawer({}, () => viewCapa(root)));
    $$('[data-capa]', root).forEach((el) => el.addEventListener('click', () => capaEditDrawer(list.find((c) => String(c.id) === el.dataset.capa), () => viewCapa(root))));
  }

  const opt = (items, val, label) => items.map((x) => `<option value="${esc(x.code)}" ${x.code === val ? 'selected' : ''}>${esc(label(x))}</option>`).join('');

  function capaCreateDrawer(pre, done) {
    const due = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    const d = drawer(`<div class="drawer-h"><div><div class="label">新建 8D</div><h3>${pre.alert_key ? '由预警发起改善' : '手工发起改善'}</h3></div><button class="close-x" data-close aria-label="关闭">×</button></div>
      <form class="form-grid" id="cf">
        <label class="field full"><span>问题标题</span><input type="text" id="cf-title" name="title" value="${esc(pre.title || '')}" required></label>
        <label class="field"><span>供应商</span><select id="cf-sup" name="supplier_code">${opt(META.suppliers, pre.supplier_code, (s) => s.code + ' ' + s.name)}</select></label>
        <label class="field"><span>物料</span><select id="cf-mat" name="material_code"></select></label>
        <label class="field"><span>缺陷</span><select id="cf-def" name="defect_code"><option value="">—</option>${opt(META.defects, pre.defect_code, (x) => x.code + ' ' + x.name)}</select></label>
        <label class="field"><span>责任人（SQE）</span><input type="text" id="cf-owner" name="owner" value="${esc(pre.owner || '')}" placeholder="例如：陈工"></label>
        <label class="field"><span>完成期限</span><input type="date" id="cf-due" name="due_date" value="${due}"></label>
        <label class="field full"><span>D2 问题描述</span><textarea id="cf-problem" name="problem" rows="4">${esc(pre.problem || '')}</textarea></label>
        <label class="field full"><span>D3 围堵措施</span><textarea id="cf-cont" name="containment" rows="3">${esc(pre.containment || '')}</textarea></label>
        <div class="full row"><button class="btn primary" type="submit">创建 8D</button><button class="btn" type="button" data-close>取消</button></div>
      </form>`);
    const fillMat = () => {
      const sup = $('#cf-sup', d).value;
      $('#cf-mat', d).innerHTML = opt(META.materials.filter((m) => m.supplier_code === sup), pre.material_code, (m) => m.code + ' ' + m.name);
    };
    $('#cf-sup', d).addEventListener('change', fillMat);
    fillMat();
    $('#cf', d).addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target).entries());
      body.alert_key = pre.alert_key || null;
      try {
        const c = await API.post('/api/capa', body);
        closeDrawer();
        toast(`已创建 ${c.capa_no}`);
        refreshCounts();
        done && done();
      } catch (err) { toast(err.message); }
    });
  }

  function capaEditDrawer(c, done) {
    const closed = c.status === '已关闭';
    const ro = closed ? 'readonly' : '';
    const d = drawer(`<div class="drawer-h"><div><div class="label">${esc(c.capa_no)} · ${esc(c.supplier_name || '')} ${esc(c.material_name || '')}</div><h3>${esc(c.title)}</h3>
        <div class="steps" style="margin-top:6px">${CAPA_STEPS.map((s, i) => { const cur = CAPA_STEPS.indexOf(c.status); return `<span class="${i < cur ? 'done' : i === cur ? 'cur' : ''}">${s}</span>`; }).join('')}</div></div>
        <button class="close-x" data-close aria-label="关闭">×</button></div>
      <form class="form-grid" id="ef">
        <label class="field"><span>责任人</span><input type="text" id="ef-owner" name="owner" value="${esc(c.owner || '')}" ${ro}></label>
        <label class="field"><span>完成期限</span><input type="date" id="ef-due" name="due_date" value="${esc(c.due_date || '')}" ${ro}></label>
        <label class="field full"><span>当前阶段</span><select id="ef-status" name="status" ${closed ? 'disabled' : ''}>${CAPA_STEPS.map((s) => `<option ${s === c.status ? 'selected' : ''} ${s === '已关闭' && !closed ? 'disabled' : ''}>${s}</option>`).join('')}</select></label>
        <label class="field full"><span>D2 问题描述</span><textarea id="ef-problem" name="problem" rows="3" ${ro}>${esc(c.problem || '')}</textarea></label>
        <label class="field full"><span>D3 围堵措施</span><textarea id="ef-cont" name="containment" rows="2" ${ro}>${esc(c.containment || '')}</textarea></label>
        <label class="field full"><span>D4 根本原因</span><textarea id="ef-root" name="root_cause" rows="3" ${ro} placeholder="发生原因与流出原因">${esc(c.root_cause || '')}</textarea></label>
        <label class="field full"><span>D5–D6 永久对策</span><textarea id="ef-ca" name="corrective_action" rows="3" ${ro}>${esc(c.corrective_action || '')}</textarea></label>
        <label class="field full"><span>D7 效果验证</span><textarea id="ef-ver" name="verification" rows="2" ${ro} placeholder="例如：对策后连续 10 批 IQC 不良率 ≤0.2%">${esc(c.verification || '')}</textarea></label>
        ${closed ? `<div class="full caution" style="color:var(--ok);background:var(--ok-soft)">已于 ${esc(c.closed_at)} 关闭${c.kb_doc_id ? `，报告已写入知识库（<a href="javascript:void 0" data-doc="${c.kb_doc_id}">查看</a>）` : ''}。</div>`
        : `<div class="full row"><button class="btn primary" type="submit">保存</button><button class="btn" type="button" id="ef-close">关闭并回写知识库</button><button class="btn" type="button" data-close>取消</button></div>`}
      </form>`);
    bindDocs(d);
    if (closed) return;
    const body = () => Object.fromEntries(new FormData($('#ef', d)).entries());
    $('#ef', d).addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await API.put('/api/capa/' + c.id, body()); closeDrawer(); toast('已保存'); done && done(); } catch (err) { toast(err.message); }
    });
    $('#ef-close', d).addEventListener('click', async () => {
      try {
        const r = await API.post('/api/capa/' + c.id + '/close', body());
        closeDrawer();
        toast(`${r.capa_no} 已关闭，报告已写入知识库`);
        refreshCounts();
        done && done();
      } catch (err) { toast(err.message); }
    });
  }

  // ------------------------------------------------------------------ 外框与路由
  const VIEWS = {
    overview: ['质量总览', viewOverview],
    suppliers: ['供应商画像', viewSuppliers],
    supplier: ['供应商详情', viewSupplier, 'suppliers'],
    alerts: ['智能预警', viewAlerts],
    alert: ['预警详情', viewAlert, 'alerts'],
    knowledge: ['AI 质量知识库', viewKnowledge],
    governance: ['质量数据治理', viewGovernance],
    capa: ['改善闭环 · 8D', viewCapa],
  };
  const NAV = ['overview', 'suppliers', 'alerts', 'knowledge', 'governance', 'capa'];
  let META = {};

  function shell() {
    document.getElementById('app').innerHTML = `<div class="shell">
      <aside class="side">
        <div class="brand"><span class="brand-mark">SQM</span><span><div class="brand-name">SQM Insight</div><div class="brand-sub">AI 供应商质量管理</div></span></div>
        <nav class="nav">${NAV.map((v) => `<button data-nav="${v}"><span>${VIEWS[v][0]}</span>${v === 'alerts' ? '<span class="count" id="alert-count" hidden></span>' : ''}${v === 'capa' ? '<span class="count" id="capa-count" hidden></span>' : ''}</button>`).join('')}</nav>
        <div class="side-foot"><span>数据截止 <b id="asof"></b></span><span id="counts"></span><span>演示数据为模拟数据，不对应任何真实企业</span></div>
      </aside>
      <main class="main"><div class="topbar"><div><div class="crumbs" id="crumbs"></div><h1 id="title"></h1></div><div class="meta-chips" id="chips"></div></div>
        <div id="banner"></div><div id="view" class="stack" style="gap:16px"></div></main></div>`;
    $$('[data-nav]').forEach((b) => b.addEventListener('click', () => go(b.dataset.nav)));
    document.body.appendChild(tip);
  }

  function setTitle(title, crumbs) {
    $('#title').textContent = title;
    $('#crumbs').innerHTML = (crumbs || []).map(([v, t]) => (v ? `<button data-crumb="${v}">${esc(t)}</button><span>/</span>` : `<span>${esc(t)}</span>`)).join('');
    $$('[data-crumb]').forEach((b) => b.addEventListener('click', () => go(b.dataset.crumb)));
  }

  async function refreshCounts() {
    try {
      const [alerts, capas] = await Promise.all([API.get('/api/alerts'), API.get('/api/capa')]);
      const open = alerts.filter((a) => a.status === '待处理').length;
      const od = capas.filter((c) => c.overdue).length;
      const ac = $('#alert-count'), cc = $('#capa-count');
      ac.textContent = open; ac.hidden = !open;
      cc.textContent = od; cc.hidden = !od;
    } catch (e) { /* 计数失败不影响页面 */ }
  }

  function parseHash() {
    const h = (location.hash || '').replace(/^#/, '');
    const [v, p] = h.split('~');
    return VIEWS[v] ? { view: v, param: p ? decodeURIComponent(p) : null } : { view: 'overview', param: null };
  }

  let current = { view: 'overview', param: null };
  function go(view, param) {
    current = { view, param: param || null };
    const token = '#' + view + (param ? '~' + param : '');
    try { if (location.hash !== token) history.pushState(null, '', token); } catch (e) { /* 受限环境下忽略 */ }
    render();
  }
  window.addEventListener('popstate', () => { current = parseHash(); render(); });

  async function render() {
    closeDrawer();
    tip.hidden = true;
    const [title, fn, navKey] = VIEWS[current.view];
    $$('[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === (navKey || current.view)));
    setTitle(title, []);
    const root = $('#view');
    root.innerHTML = '<div class="loading">加载中…</div>';
    window.scrollTo(0, 0);
    try {
      await fn(root, current.param);
    } catch (e) {
      root.innerHTML = `<div class="panel empty">加载失败：${esc(e.message)}</div>`;
    }
  }

  async function boot() {
    shell();
    try {
      META = await API.get('/api/meta');
    } catch (e) {
      $('#view').innerHTML = `<div class="panel empty">无法连接后端服务：${esc(e.message)}。请先运行 python run.py。</div>`;
      return;
    }
    DEFECT_NAMES = Object.fromEntries(META.defects.map((d) => [d.code, d.name]));
    $('#asof').textContent = META.as_of;
    $('#counts').textContent = `${META.counts.suppliers} 家供应商 · ${META.counts.lots} 批次 · ${META.counts.kb_docs} 份知识文件`;
    $('#chips').innerHTML = `<span class="pill neutral">数据截止 ${META.as_of}</span>
      <span class="pill ${META.llm.enabled ? 'ok' : 'neutral'}" data-tip="${esc(META.llm.enabled ? '模型：' + META.llm.model : META.llm.reason || '')}">大模型：${META.llm.enabled ? '已启用' : '未启用（离线模式）'}</span>`;
    if (META.mode === 'static') {
      $('#banner').innerHTML = '<div class="banner"><b>在线预览版</b><span>数据为生成时的静态快照，检索、校验、8D 流程在浏览器内运行，刷新后复原。完整版（SQLite 数据库、CSV 导入、大模型）请本地运行 python run.py。</span></div>';
    }
    current = parseHash();
    render();
    refreshCounts();
  }

  boot();
})();
