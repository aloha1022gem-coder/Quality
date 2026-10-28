/* 售后故障追踪前端：无框架单页应用，图表为手绘 SVG，可离线运行。 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ 工具
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const int = (n) => Number(n || 0).toLocaleString('zh-CN');
  const pct = (x, d) => (x == null ? '—' : (x * 100).toFixed(d == null ? 2 : d) + '%');
  const money = (n) => '¥' + int(Math.round(n || 0));
  const LINE_COLOR = { FAU: 'var(--s-fau)', GD: 'var(--s-gd)', SINK: 'var(--s-sink)' };
  const VERDICT_CLS = { 有效: 'ok', 未见改善: 'crit', '趋势改善，待更多数据': 'warn', 数据不足: 'neutral', 待实施: 'neutral' };
  const STATUS_CLS = { 根因分析: 'warn', 实施中: 'warn', 验证中: 'info', 已关闭: 'ok' };

  const API = {
    async req(method, path, body) {
      if (window.FieldStatic) return window.FieldStatic.handle(method, path, body);
      const r = await fetch(path, {
        method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || '请求失败（' + r.status + '）');
      return data;
    },
    get(p) { return this.req('GET', p); },
    post(p, b) { return this.req('POST', p, b || {}); },
  };

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

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

  // ------------------------------------------------------------------ 主数据
  let META = {};
  const N = { model: {}, sup: {}, fault: {}, part: {}, resp: {}, line: {} };
  const modelName = (c) => (N.model[c] ? N.model[c].name : c);
  const supName = (c) => (N.sup[c] ? N.sup[c].name : c);
  const lineName = (c) => (N.line[c] ? N.line[c].name : c);
  const partName = (c) => (c ? (N.part[c] ? N.part[c].name : c) : '待拆解');
  const faultName = (c) => (N.fault[c] ? N.fault[c].name : c);

  // ------------------------------------------------------------------ 图表
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((x) => n <= x) * p;
  }

  // series: [{label, color, pts: [[x, y, tip?]], dash, dots, width}]
  function lineChart(o) {
    const W = o.W || 720, H = o.H || 260, L = o.L || 52, R = o.R || 18, T = 18, B = 30;
    const all = o.series.flatMap((s) => s.pts.map((p) => p[1])).concat((o.refs || []).map((r) => r.y));
    const yMax = o.yMax || niceMax(Math.max(...all, 0) * 1.1);
    const xMin = o.xMin || 0, xMax = o.xMax;
    const xs = (x) => L + ((x - xMin) / (xMax - xMin)) * (W - L - R);
    const ys = (y) => T + (1 - Math.min(y, yMax) / yMax) * (H - T - B);
    let g = '';
    for (let i = 0; i <= 4; i++) {
      const v = (yMax * i) / 4, y = ys(v);
      g += `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/><text x="${L - 8}" y="${y + 4}" text-anchor="end">${o.yFmt(v)}</text>`;
    }
    (o.xTicks || []).forEach(([x, label]) => { g += `<text x="${xs(x)}" y="${H - 8}" text-anchor="middle">${esc(label)}</text>`; });
    (o.vrefs || []).forEach((r) => {
      g += `<line x1="${xs(r.x)}" x2="${xs(r.x)}" y1="${T}" y2="${H - B}" stroke="var(--ink-3)" stroke-dasharray="3 3"/><text x="${xs(r.x) + 4}" y="${H - B - 6}">${esc(r.label)}</text>`;
    });
    (o.refs || []).forEach((r) => {
      g += `<line x1="${L}" x2="${W - R}" y1="${ys(r.y)}" y2="${ys(r.y)}" stroke="${r.color || 'var(--crit)'}" stroke-dasharray="5 4" stroke-width="1.2"/><text x="${W - R}" y="${ys(r.y) - 6}" text-anchor="end" style="fill:${r.color || 'var(--crit)'}">${esc(r.label)}</text>`;
    });
    const paths = o.series.map((s) => {
      if (!s.pts.length) return '';
      const d = s.pts.map((p, i) => `${i ? 'L' : 'M'}${xs(p[0]).toFixed(1)},${ys(p[1]).toFixed(1)}`).join('');
      const line = s.noLine ? '' : `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''}/>`;
      const dots = s.dots ? s.pts.map((p) => `<circle cx="${xs(p[0])}" cy="${ys(p[1])}" r="${s.r || 3}" fill="${s.hollow ? 'var(--surface)' : s.color}" stroke="${s.color}" stroke-width="1.4" ${p[2] ? `data-tip="${esc(p[2])}"` : ''}/>`).join('') : '';
      return line + dots;
    }).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria || '')}">${g}${paths}</svg>
      <div class="legend">${o.series.filter((s) => s.label).map((s) => `<span><i style="background:${s.color}${s.dash ? ';opacity:.6' : ''}"></i>${esc(s.label)}</span>`).join('')}</div>`;
  }

  function paretoChart(items, color) {
    const total = items.reduce((s, x) => s + x.qty, 0) || 1;
    const top = items.slice(0, 8);
    const rest = items.slice(8).reduce((s, x) => s + x.qty, 0);
    if (rest) top.push({ name: '其他', qty: rest });
    let cum = 0;
    top.forEach((x) => { cum += x.qty; x.cum = (cum / total) * 100; });
    const W = 720, H = 270, L = 44, R = 44, T = 16, B = 44;
    const max = niceMax(Math.max(...top.map((x) => x.qty), 1));
    const bw = (W - L - R) / Math.max(top.length, 1);
    const xs = (i) => L + bw * i + bw / 2;
    const ys = (v) => T + (1 - v / max) * (H - T - B);
    const yp = (p) => T + (1 - p / 100) * (H - T - B);
    let g = '';
    for (let i = 0; i <= 4; i++) {
      const v = (max * i) / 4;
      g += `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${ys(v)}" y2="${ys(v)}"/><text x="${L - 8}" y="${ys(v) + 4}" text-anchor="end">${int(v)}</text><text x="${W - R + 8}" y="${yp(i * 25) + 4}">${i * 25}%</text>`;
    }
    const short = (s) => (s.length > 5 ? s.slice(0, 5) + '…' : s);
    const bars = top.map((x, i) => `<rect x="${xs(i) - bw * 0.32}" y="${ys(x.qty)}" width="${bw * 0.64}" height="${ys(0) - ys(x.qty)}" rx="2" fill="${i < 3 ? color || 'var(--accent)' : 'var(--ink-3)'}" fill-opacity="${i < 3 ? 1 : 0.45}" data-tip="${esc(x.full || x.name)}：${x.qty} 件（${((x.qty / total) * 100).toFixed(1)}%）\n累计 ${x.cum.toFixed(1)}%"/>
      <text x="${xs(i)}" y="${H - 26}" text-anchor="middle">${esc(x.code || '')}</text><text x="${xs(i)}" y="${H - 10}" text-anchor="middle">${esc(short(x.name))}</text>`).join('');
    const line = top.map((x, i) => `${i ? 'L' : 'M'}${xs(i)},${yp(x.cum)}`).join('');
    const dots = top.map((x, i) => `<circle cx="${xs(i)}" cy="${yp(x.cum)}" r="3" fill="var(--surface)" stroke="var(--ink-2)" stroke-width="1.5"/>`).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Pareto 图">${g}${bars}
      <line x1="${L}" x2="${W - R}" y1="${yp(80)}" y2="${yp(80)}" stroke="var(--warn)" stroke-dasharray="4 4"/>
      <path d="${line}" fill="none" stroke="var(--ink-2)" stroke-width="1.6"/>${dots}</svg>`;
  }

  function barList(items, cls) {
    const max = Math.max(...items.map((x) => x.value), 1e-9);
    return `<div class="bars">${items.map((x) => `<div class="bar-row"><span>${esc(x.label)}</span><span class="track"><i class="${x.cls || cls || ''}" style="width:${(x.value / max) * 100}%"></i></span><b>${esc(x.text != null ? x.text : int(x.value))}</b></div>`).join('')}</div>`;
  }

  function heatCls(rate, target, k) {
    if (rate == null) return 'na';
    const r = rate / (target * k / 12);
    return r <= 0.5 ? 'h0' : r <= 1 ? 'h1' : r <= 1.5 ? 'h2' : r <= 2.5 ? 'h3' : 'h4';
  }

  const pill = (text, cls) => `<span class="pill ${cls || 'neutral'}">${esc(text)}</span>`;

  // ------------------------------------------------------------------ 视图：总览
  async function viewOverview(root) {
    const d = await API.get('/api/field/overview');
    const fau = d.lines.find((l) => l.code === 'FAU');
    const s = d.sensor;
    const months = d.trend.months;
    const series = Object.keys(d.trend.series).map((c) => ({
      label: lineName(c), color: LINE_COLOR[c], dots: true, r: 2.5,
      pts: d.trend.series[c].map(([m, v, n], i) => [i, v, `${lineName(c)} ${m}\n报修 ${n} 条\n每千台在用 ${v.toFixed(2)} 条`]),
    }));
    root.innerHTML = `
      <div class="kpis">
        <div class="panel kpi"><span class="label">近 12 个月出货</span><span class="kpi-value">${int(d.kpi.shipped_12m)}<small>台</small></span><span class="sub">三条产品线合计</span></div>
        <div class="panel kpi"><span class="label">近 12 个月报修</span><span class="kpi-value">${int(d.kpi.reports_12m)}<small>条</small></span><span class="sub">待拆解确认 ${d.kpi.pending_parts} 条（近 90 天）</span></div>
        <div class="panel kpi ${fau.mis12 > fau.target ? 'alarm' : ''}"><span class="label">龙头 12 个月故障率</span><span class="kpi-value">${pct(fau.mis12)}</span><span class="delta ${fau.mis12 > fau.target ? 'up-bad' : 'up-good'}">目标 ≤ ${pct(fau.target, 1)}</span></div>
        <div class="panel kpi ${s.after && s.after.r5 < s.after.target_r5 ? 'alarm' : ''}"><span class="label">SF-101 感应龙头 5 年可靠度</span>
          <span class="vs"><span class="kpi-value">${pct(s.after ? s.after.r5 : s.all.r5, 0)}</span>${s.before ? `<span class="small muted">改善前 ${pct(s.before.r5, 0)}</span>` : ''}</span>
          <span class="delta up-bad">目标 ≥ ${pct(s.all.target_r5, 0)}${s.after ? ' · 预测值' : ''}</span></div>
        <div class="panel kpi ${d.kpi.traceable_90d < 0.95 ? 'alarm' : ''}"><span class="label">可追溯率（近 90 天）</span><span class="kpi-value">${pct(d.kpi.traceable_90d, 1)}</span><span class="sub">有批次码的报修记录占比</span></div>
      </div>
      <div class="grid g-3-1">
        <section class="panel"><div class="panel-h"><h2>每千台在用产品的月报修数</h2><span class="panel-sub">近 24 个月 · 按在用量归一，出货增长不会造成假上升</span></div>
          <div class="panel-b">${lineChart({ series, xMax: months.length - 1, yFmt: (v) => v.toFixed(1), aria: '每千台在用产品月报修数趋势',
            xTicks: months.map((m, i) => [i, m.slice(2)]).filter((x, i) => i % 3 === 2 || i === months.length - 1) })}</div></section>
        <section class="panel"><div class="panel-h"><h2>异常批次</h2><button class="btn sm" id="to-batches">批次矩阵</button></div>
          <div class="panel-b stack">${d.abnormal.map((a) => `<button class="alert-card l-${a.level}" data-batch="${esc(a.batch_no)}" style="grid-template-columns:5px minmax(0,1fr) auto">
            <span class="stripe"></span><span class="body" style="padding:9px 0"><span class="title" style="font-size:13.5px">${esc(a.batch_no)} ${esc(a.model_name)}</span>
            <span class="small muted">${a.mis} 个月故障率 ${pct(a.rate)}，基线 ${pct(a.baseline)}，主要：${esc(a.top_parts.map(([p, c]) => partName(p === '待拆解' ? null : p) + '×' + c).join('、'))}</span></span>
            <span class="side-r" style="padding:9px 12px 9px 0"><span class="risk"><b style="font-size:17px">${a.ratio}×</b><span>基线</span></span></span></button>`).join('') || '<div class="empty">没有异常批次</div>'}</div></section>
      </div>
      <div class="grid g-1-1">
        <section class="panel"><div class="panel-h"><h2>近 6 个月报修最多的问题</h2><span class="panel-sub">型号 × 故障部位 · 括号内为前 6 个月</span></div>
          <div class="panel-b table-wrap"><table><thead><tr><th>型号</th><th>故障部位</th><th class="num">近 6 个月</th><th class="num">前 6 个月</th><th class="num">变化</th></tr></thead><tbody>
          ${d.issues.map((x) => { const ch = x.prev ? x.count / x.prev - 1 : null; return `<tr><td style="white-space:nowrap" data-tip="${esc(x.model_name)}">${esc(x.model_code)}</td><td>${esc(x.part_name)}</td><td class="num">${x.count}</td><td class="num muted">${x.prev}</td>
            <td class="num" style="color:${ch > 0.2 ? 'var(--crit)' : 'inherit'}">${ch == null ? '新增' : (ch > 0 ? '+' : '') + Math.round(ch * 100) + '%'}</td></tr>`; }).join('')}
          </tbody></table><p class="small muted">感应元件衰减在旧批次里持续进入耗损期，所以即使新批次已改善，报修数仍在上升；改善效果要看“改善验证”里按批次的对比。</p></div></section>
        <section class="panel"><div class="panel-h"><h2>产品线 12 个月故障率</h2><span class="panel-sub">各型号最近 12 个已满 12 个月的批次合并计算</span></div>
          <div class="panel-b stack">${barList(d.lines.map((l) => ({ label: l.name, value: l.mis12 || 0, text: `${pct(l.mis12)} / 目标 ${pct(l.target, 1)}`, cls: l.mis12 > l.target ? 's' : '' })))}
          <div class="label" style="margin-top:6px">改善措施</div>
          ${d.actions.map((a) => `<div class="check"><span><b class="mono">${esc(a.action_no)}</b> ${esc(a.title)}</span><span class="row" style="flex-wrap:nowrap">${pill(a.status, STATUS_CLS[a.status])}${pill(a.verdict, VERDICT_CLS[a.verdict])}</span></div>`).join('')}
          <button class="btn sm" id="to-actions" style="align-self:flex-start">查看改善验证</button></div></section>
      </div>`;
    $('#to-batches', root).addEventListener('click', () => go('batches'));
    $('#to-actions', root).addEventListener('click', () => go('actions'));
    $$('[data-batch]', root).forEach((el) => el.addEventListener('click', () => openTrace(el.dataset.batch)));
  }

  // ------------------------------------------------------------------ 视图：批次故障率
  const batchFilter = { line: 'FAU', model: 'SF-101', supplier: '', onlyFlag: false };
  async function viewBatches(root) {
    const d = await API.get('/api/field/batches');
    const ks = d.mis_points;
    root.innerHTML = `
      <section class="panel"><div class="panel-b stack" style="padding-top:14px">
        <div class="filters" id="bf">
          ${Object.keys(N.line).map((c) => `<button class="chip" data-line="${c}">${esc(lineName(c))}</button>`).join('')}
          <span class="sep"></span>
          <select id="bf-model" aria-label="型号"></select>
          <select id="bf-sup" aria-label="代工厂"><option value="">全部代工厂</option>${META.suppliers.map((s) => `<option value="${s.code}">${esc(s.name)}</option>`).join('')}</select>
          <button class="chip" id="bf-flag">只看有标记的批次</button>
        </div>
        <div class="heat-legend"><span>颜色＝相对目标（12 个月目标按使用月数线性折算）</span><span style="background:var(--ok-soft)">≤ 0.5 倍</span><span style="border:1px solid var(--line)">≤ 1 倍</span><span style="background:color-mix(in srgb, var(--crit) 12%, var(--surface))">≤ 1.5 倍</span><span style="background:color-mix(in srgb, var(--crit) 24%, var(--surface))">≤ 2.5 倍</span><span style="background:color-mix(in srgb, var(--crit) 40%, var(--surface))">&gt; 2.5 倍</span><span>“—”＝批次还没用满这么久</span></div>
      </div></section>
      <section class="panel"><div class="panel-h"><h2>批次 × 使用月数故障率</h2><span class="panel-sub" id="bf-count"></span></div>
        <div class="panel-b table-wrap" id="bf-table"></div></section>`;
    const fillModels = () => {
      const ms = META.models.filter((m) => m.line === batchFilter.line);
      if (batchFilter.model && !ms.some((m) => m.code === batchFilter.model)) batchFilter.model = '';
      $('#bf-model', root).innerHTML = `<option value="">全部型号</option>${ms.map((m) => `<option value="${m.code}" ${m.code === batchFilter.model ? 'selected' : ''}>${m.code} ${esc(m.name)}</option>`).join('')}`;
    };
    const draw = () => {
      $$('[data-line]', root).forEach((b) => b.classList.toggle('on', b.dataset.line === batchFilter.line));
      $('#bf-flag', root).classList.toggle('on', batchFilter.onlyFlag);
      $('#bf-sup', root).value = batchFilter.supplier;
      const target = META.targets[batchFilter.line].mis12;
      const rows = d.rows.filter((r) => r.line === batchFilter.line && (!batchFilter.model || r.model_code === batchFilter.model)
        && (!batchFilter.supplier || r.supplier_code === batchFilter.supplier) && (!batchFilter.onlyFlag || r.abnormal || r.changes.length))
        .sort((a, b) => (a.model_code === b.model_code ? b.prod_month.localeCompare(a.prod_month) : a.model_code.localeCompare(b.model_code)));
      $('#bf-count', root).textContent = `${rows.length} 个批次 · 数据截止 ${d.as_of} · 点击批次查看追溯`;
      $('#bf-table', root).innerHTML = `<table><thead><tr><th>批次号</th><th>型号</th><th>代工厂</th><th class="num">出货</th>${ks.map((k) => `<th class="num">${k} 个月</th>`).join('')}<th class="num">累计报修</th><th>标记</th></tr></thead><tbody>
        ${rows.map((r) => `<tr class="click ${r.changes.length ? 'bp' : ''}" data-batch="${esc(r.batch_no)}"><td class="mono">${esc(r.batch_no)}</td><td>${esc(r.model_code)}</td><td>${esc(supName(r.supplier_code))}</td><td class="num">${int(r.shipped)}</td>
          ${ks.map((k) => { const c = r.mis[k]; return `<td class="heat ${heatCls(c && c.rate, target, k)}" ${c ? `data-tip="${esc(r.batch_no)} 使用 ${k} 个月内报修 ${c.x} 台 / 出货 ${r.shipped} 台"` : ''}>${c ? pct(c.rate) : '—'}</td>`; }).join('')}
          <td class="num">${r.fails}</td>
          <td>${r.abnormal ? pill('异常批次 ' + r.abnormal, r.abnormal === '高' ? 'crit' : 'warn') : ''}${r.changes.map((c) => `<span class="pill info" data-tip="${esc(c)}">关键件变更</span>`).join(' ')}</td></tr>`).join('') || '<tr><td colspan="10" class="empty">没有符合条件的批次</td></tr>'}
        </tbody></table>
        <p class="small muted">蓝色上边框＝关键元器件在这一批发生变更（改善断点或二供切换）。同一型号内按生产月从新到旧排列，比较时请看同一列。</p>`;
      $$('[data-batch]', root).forEach((el) => el.addEventListener('click', () => openTrace(el.dataset.batch)));
    };
    $$('[data-line]', root).forEach((b) => b.addEventListener('click', () => { batchFilter.line = b.dataset.line; batchFilter.supplier = ''; fillModels(); draw(); }));
    $('#bf-model', root).addEventListener('change', (e) => { batchFilter.model = e.target.value; draw(); });
    $('#bf-sup', root).addEventListener('change', (e) => { batchFilter.supplier = e.target.value; draw(); });
    $('#bf-flag', root).addEventListener('click', () => { batchFilter.onlyFlag = !batchFilter.onlyFlag; draw(); });
    fillModels();
    draw();
  }

  // ------------------------------------------------------------------ 视图：寿命分析
  const relState = { model: 'SF-101', part: '' };
  function betaText(beta) {
    if (beta >= 1.5) return `<b>β = ${beta} &gt; 1.5，耗损型失效。</b>故障率随使用时间上升，属于元器件钝化、磨损、老化一类问题，靠加严出厂检验挡不住，要从设计选型和来料寿命验证解决。`;
    if (beta <= 0.9) return `<b>β = ${beta} &lt; 1，早期失效。</b>故障集中在使用初期，多为制造或安装缺陷，要从制程控制、出厂检验和安装规范解决。`;
    return `<b>β = ${beta} ≈ 1，随机失效。</b>故障率大致不随时间变化，多为偶发应力或使用环境，需要结合故障模式逐项分析。`;
  }
  async function viewReliability(root) {
    const d = await API.get('/api/field/reliability');
    root.innerHTML = `
      <section class="panel"><div class="panel-b stack" style="padding-top:14px">
        <div class="filters">${d.models.map((m) => `<button class="chip" data-m="${m.model_code}">${m.model_code}</button>`).join('')}</div>
        <div class="filters" id="rel-parts"></div>
      </div></section>
      <div id="rel-body" class="stack" style="gap:16px"></div>`;
    const draw = () => {
      const m = d.models.find((x) => x.model_code === relState.model) || d.models[0];
      relState.model = m.model_code;
      const parts = Array.from(new Set(m.fits.map((f) => f.part_code || '')));
      if (!parts.includes(relState.part)) relState.part = '';
      $$('[data-m]', root).forEach((b) => b.classList.toggle('on', b.dataset.m === m.model_code));
      $('#rel-parts', root).innerHTML = `<span class="small muted">失效模式：</span>${parts.map((p) => `<button class="chip ${p === relState.part ? 'on' : ''}" data-p="${p}">${esc(p ? p + ' ' + partName(p) : '全部故障')}</button>`).join('')}`;
      $$('[data-p]', root).forEach((b) => b.addEventListener('click', () => { relState.part = b.dataset.p; draw(); }));
      const fits = m.fits.filter((f) => (f.part_code || '') === relState.part);
      const split = fits.some((f) => f.group === 'after');
      const shown = split ? fits.filter((f) => f.group !== 'all') : fits;
      const color = { all: 'var(--accent)', before: 'var(--before)', after: 'var(--accent)' };
      const target = fits[0] ? fits[0].target_r5 : 0.95;
      const series = [];
      shown.forEach((f) => {
        series.push({ label: `${f.group_label} · Weibull 拟合${f.method === 'Weibayes' ? '（Weibayes 预测）' : ''}`, color: color[f.group], pts: f.curve, dash: f.method === 'Weibayes' ? '6 4' : null });
        series.push({ label: `${f.group_label} · 实际累计故障率`, color: color[f.group], noLine: true, dots: true, hollow: true, r: 2.5,
          pts: f.empirical.map(([t, v]) => [t, v, `${f.group_label}\n使用 ${t} 个月累计故障 ${pct(v)}`]) });
      });
      const yMax = niceMax(Math.max(...shown.flatMap((f) => f.curve.filter((p) => p[0] <= 72).map((p) => p[1])), 1 - target) * 1.05);
      $('#rel-body', root).innerHTML = `
        <section class="panel"><div class="panel-h"><h2>${esc(m.model_code)} ${esc(m.model_name)} · ${esc(relState.part ? partName(relState.part) : '全部故障')}</h2><span class="panel-sub">累计故障率 F(t)，横轴为使用月数 · 圆点是实际数据，曲线是 Weibull 拟合</span></div>
          <div class="panel-b">${lineChart({ series, xMax: 72, yMax, yFmt: (v) => (v * 100).toFixed(yMax < 0.05 ? 1 : 0) + '%', aria: '累计故障率曲线',
            xTicks: [0, 12, 24, 36, 48, 60, 72].map((t) => [t, t ? t / 12 + ' 年' : '0']),
            refs: [{ y: 1 - target, label: `5 年目标：累计故障 ≤ ${pct(1 - target, 0)}` }], vrefs: [{ x: 60, label: '5 年' }] })}</div></section>
        <section class="panel"><div class="panel-h"><h2>寿命指标</h2><span class="panel-sub">右删失 Weibull 最大似然估计 · 时间单位：月</span></div>
          <div class="panel-b table-wrap"><table><thead><tr><th>批次范围</th><th>方法</th><th class="num">出货</th><th class="num">故障</th><th class="num">β</th><th class="num">η</th><th class="num">B10 寿命</th><th class="num">5 年可靠度</th><th class="num">平均寿命 MTTF</th><th class="num">已坏产品平均使用</th></tr></thead><tbody>
          ${shown.map((f) => `<tr><td>${esc(f.group_label)}</td><td>${f.method === 'Weibayes' ? pill('Weibayes', 'info') : 'MLE'}</td><td class="num">${int(f.units)}</td><td class="num">${f.r}</td><td class="num">${f.beta}</td><td class="num">${int(f.eta)}</td>
            <td class="num">${f.b10.toFixed(1)} 月</td><td class="num" style="color:${f.r5 < f.target_r5 ? 'var(--crit)' : 'var(--ok)'};font-weight:600">${pct(f.r5, 1)}</td><td class="num">${f.mttf > 1200 ? '&gt; 100 年' : (f.mttf / 12).toFixed(1) + ' 年'}</td><td class="num muted">${f.naive_mean == null ? '—' : f.naive_mean + ' 月'}</td></tr>`).join('')}
          </tbody></table>
          <div class="stack" style="margin-top:12px;gap:8px">
            ${shown[0] ? `<div class="explain">${betaText(shown.find((f) => f.method === 'MLE') ? shown.find((f) => f.method === 'MLE').beta : shown[0].beta)}</div>` : ''}
            <div class="explain"><b>为什么不能直接平均已坏产品的使用时间？</b>已坏的产品只是早坏的那一部分，大多数产品还在正常使用（右删失）。直接平均会得到“${shown[0] && shown[0].naive_mean != null ? shown[0].naive_mean + ' 个月' : '很短'}”这种严重偏低的数字；Weibull 把仍在使用的产品也算进去，才能回答“平均多久坏”和“5 年内会坏多少”。</div>
            ${split ? '<div class="explain"><b>Weibayes：</b>断点后批次用的时间还短，耗损型故障还没出现，直接拟合会高估寿命。这里沿用断点前的 β（失效机理相同），只用新批次数据估计 η，提前预测改善后的 5 年可靠度。</div>' : ''}
            ${shown.filter((f) => f.warning).map((f) => `<div class="caution">${esc(f.group_label)}：${esc(f.warning)}</div>`).join('')}
          </div></div></section>`;
    };
    $$('[data-m]', root).forEach((b) => b.addEventListener('click', () => { relState.model = b.dataset.m; relState.part = ''; draw(); }));
    draw();
  }

  // ------------------------------------------------------------------ 视图：故障模式
  const modeFilter = { line: 'FAU', model: '' };
  async function viewModes(root) {
    const d = await API.get('/api/field/pareto');
    root.innerHTML = `
      <section class="panel"><div class="panel-b filters" style="padding-top:14px">
        ${Object.keys(N.line).map((c) => `<button class="chip" data-line="${c}">${esc(lineName(c))}</button>`).join('')}
        <span class="sep"></span><select id="mf-model" aria-label="型号"></select>
        <span class="small muted">近 12 个月报修，含无批次码记录</span></div></section>
      <div id="mf-body" class="stack" style="gap:16px"></div>`;
    const draw = () => {
      $$('[data-line]', root).forEach((b) => b.classList.toggle('on', b.dataset.line === modeFilter.line));
      const ms = META.models.filter((m) => m.line === modeFilter.line);
      if (modeFilter.model && !ms.some((m) => m.code === modeFilter.model)) modeFilter.model = '';
      $('#mf-model', root).innerHTML = `<option value="">全部型号</option>${ms.map((m) => `<option value="${m.code}" ${m.code === modeFilter.model ? 'selected' : ''}>${m.code} ${esc(m.name)}</option>`).join('')}`;
      // rows: [line, model, supplier, fault, part, resp, count, cost]
      const rows = d.rows.filter((r) => r[0] === modeFilter.line && (!modeFilter.model || r[1] === modeFilter.model));
      const sum = (keyIdx) => {
        const m = {};
        rows.forEach((r) => { const k = r[keyIdx]; m[k] = m[k] || [0, 0]; m[k][0] += r[6]; m[k][1] += r[7]; });
        return Object.entries(m).sort((a, b) => b[1][0] - a[1][0]);
      };
      const total = rows.reduce((s, r) => s + r[6], 0);
      const faults = sum(3).map(([k, v]) => ({ code: k, name: faultName(k), full: k + ' ' + faultName(k), qty: v[0] }));
      const parts = sum(4).map(([k, v]) => ({ code: k || '—', name: partName(k || null), full: (k || '') + ' ' + partName(k || null), qty: v[0] }));
      const resp = sum(5);
      const models = Array.from(new Set(rows.map((r) => r[1]))).sort();
      const topParts = parts.slice(0, 6).map((p) => (p.code === '—' ? '' : p.code));
      const short = (t) => (t.length > 6 ? t.slice(0, 6) + '…' : t);
      const cross = (m, p) => rows.filter((r) => r[1] === m && r[4] === p).reduce((s, r) => s + r[6], 0);
      $('#mf-body', root).innerHTML = `
        <div class="grid g-2">
          <section class="panel"><div class="panel-h"><h2>故障现象 Pareto</h2><span class="panel-sub">用户看到的 · ${int(total)} 条 · 虚线为 80%</span></div><div class="panel-b">${paretoChart(faults, LINE_COLOR[modeFilter.line])}</div></section>
          <section class="panel"><div class="panel-h"><h2>故障部位 / 根因 Pareto</h2><span class="panel-sub">拆解确认后的 · “—”为待拆解</span></div><div class="panel-b">${paretoChart(parts, LINE_COLOR[modeFilter.line])}</div></section>
        </div>
        <div class="grid g-1-1">
          <section class="panel"><div class="panel-h"><h2>型号 × 故障部位</h2><span class="panel-sub">报修条数</span></div>
            <div class="panel-b table-wrap"><table><thead><tr><th>型号</th>${topParts.map((p) => `<th class="num" data-tip="${esc(partName(p || null))}">${esc(p || '待拆解')}<div class="small" style="font-weight:400">${esc(short(partName(p || null)))}</div></th>`).join('')}</tr></thead><tbody>
            ${models.map((m) => `<tr><td style="white-space:nowrap" data-tip="${esc(modelName(m))}">${esc(m)}</td>${topParts.map((p) => `<td class="num">${cross(m, p) || '<span class="muted">·</span>'}</td>`).join('')}</tr>`).join('')}
            </tbody></table></div></section>
          <section class="panel"><div class="panel-h"><h2>责任方</h2><span class="panel-sub">决定能不能向代工厂索赔</span></div>
            <div class="panel-b stack">${barList(resp.map(([k, v]) => ({ label: k ? N.resp[k].name : '待判定（待拆解）', value: v[0], text: `${v[0]} 条 · ${money(v[1])}`, cls: { S: 's', D: 'd', U: 'u', '': 'n' }[k] || '' })))}
            <p class="small muted">“代工厂制造 / 来料”的处理成本可按质量协议索赔；“设计”类问题（如感应元件选型）由我司研发负责，不能直接向代工厂索赔。</p></div></section>
        </div>`;
    };
    $$('[data-line]', root).forEach((b) => b.addEventListener('click', () => { modeFilter.line = b.dataset.line; draw(); }));
    $('#mf-model', root).addEventListener('change', (e) => { modeFilter.model = e.target.value; draw(); });
    draw();
  }

  // ------------------------------------------------------------------ 视图：代工厂
  async function viewSuppliers(root) {
    const list = await API.get('/api/field/suppliers');
    const RESP_ORDER = ['S', 'D', 'I', 'U', '待判定'];
    root.innerHTML = `
      <section class="panel"><div class="panel-h"><h2>代工厂售后质量</h2><span class="panel-sub">按 12 个月故障率相对目标排序 · 点击查看该厂批次</span></div>
        <div class="panel-b table-wrap"><table><thead><tr><th>代工厂</th><th>等级</th><th class="num">12 个月故障率</th><th class="num">近期 3 个月故障率</th><th class="num">近 12 个月报修</th><th class="num">可追溯率</th><th>责任方构成</th><th class="num">可索赔估算</th><th class="num">异常批次</th><th class="num">未关闭措施</th></tr></thead><tbody>
        ${list.map((s) => { const tot = Object.values(s.resp).reduce((a, v) => a + v.count, 0) || 1; return `<tr class="click" data-sup="${s.code}" data-line="${s.line}">
          <td><b>${esc(s.name)}</b><div class="small muted">${esc(s.line_name)} · ${esc(s.models.join('、'))}</div></td><td><span class="grade ${s.grade}">${s.grade}</span></td>
          <td class="num" style="color:${s.ratio > 1 ? 'var(--crit)' : 'inherit'}">${pct(s.mis12)}<div class="small muted">目标 ${pct(s.target, 1)} · ${s.ratio} 倍</div></td>
          <td class="num">${pct(s.mis3)}</td><td class="num">${int(s.reports_12m)}</td><td class="num">${pct(s.traceable, 1)}</td>
          <td><span class="stackbar" data-tip="${esc(RESP_ORDER.filter((k) => s.resp[k]).map((k) => (k === '待判定' ? '待判定' : N.resp[k].name) + '：' + s.resp[k].count + ' 条').join('\n'))}">${RESP_ORDER.filter((k) => s.resp[k]).map((k) => `<i class="${k === '待判定' ? 'N' : k}" style="width:${(s.resp[k].count / tot) * 100}%"></i>`).join('')}</span></td>
          <td class="num">${money(s.claim)}</td><td class="num" style="color:${s.abnormal ? 'var(--crit)' : 'inherit'}">${s.abnormal}</td><td class="num">${s.open_actions}</td></tr>`; }).join('')}
        </tbody></table>
        <div class="legend" style="margin-top:10px"><span><i style="background:var(--crit)"></i>代工厂制造 / 来料</span><span><i style="background:var(--warn)"></i>设计</span><span><i style="background:var(--accent)"></i>安装</span><span><i style="background:var(--ink-3)"></i>用户使用 / 环境</span><span><i style="background:var(--line)"></i>待判定</span></div>
        <p class="small muted">等级口径：12 个月故障率 ÷ 产品线目标，≤1 倍 A，≤1.5 倍 B，≤2.5 倍 C，其余 D。可索赔估算＝近 12 个月责任方为“代工厂”的处理成本合计，实际按质量协议执行。</p></div></section>
      <div class="grid g-2">${list.map((s) => `<section class="panel"><div class="panel-h"><h2>${esc(s.name)}</h2><span class="panel-sub">${esc(s.mode)} · ${esc(s.region)}</span></div>
        <div class="panel-b stack"><div class="label">近 12 个月主要故障部位</div>${barList(s.top_parts.map(([p, n, c]) => ({ label: p + ' ' + n, value: c })))}</div></section>`).join('')}</div>`;
    $$('[data-sup]', root).forEach((el) => el.addEventListener('click', () => { batchFilter.line = el.dataset.line; batchFilter.model = ''; batchFilter.supplier = el.dataset.sup; go('batches'); }));
  }

  // ------------------------------------------------------------------ 视图：改善验证
  async function viewActions(root) {
    const list = await API.get('/api/field/actions');
    const statuses = ['根因分析', '实施中', '验证中', '已关闭'];
    root.innerHTML = `
      <div class="pipeline" style="grid-template-columns:repeat(4,minmax(0,1fr))">${statuses.map((s) => `<div class="stage"><span class="label">${s}</span><b>${list.filter((a) => a.status === s).length}</b></div>`).join('')}</div>
      <div class="explain">闭环规则：每项整改都要记下<b>断点批次</b>（从哪个生产月开始用新方案）。系统自动拿断点后的批次和断点前 12 批，在<b>相同使用月数</b>下比较同一失效模式的故障率，并用 Weibull 预测改善后的 5 年可靠度。</div>
      ${list.map((a) => { const v = a.verification; return `<section class="panel"><div class="panel-b action-card" style="padding-top:16px">
        <div class="spread" style="align-items:flex-start"><div class="stack" style="gap:6px">
          <div class="row"><span class="mono"><b>${esc(a.action_no)}</b></span>${pill(a.status, STATUS_CLS[a.status])}${pill(v ? v.verdict : '待实施', VERDICT_CLS[v ? v.verdict : '待实施'])}</div>
          <h2 style="margin:0;font-size:17px">${esc(a.title)}</h2>
          <div class="small muted">${esc(a.models)} · ${esc(a.supplier_name)} · ${esc(a.part_code || '')} ${esc(a.part_name || '')} · 责任人 ${esc(a.owner)}</div></div>
          ${a.breakpoint_month ? `<div class="risk"><b style="font-size:20px">${esc(a.breakpoint_month)}</b><span>断点批次（生产月）</span></div>` : ''}</div>
        <div class="action-meta"><div><span class="label">根本原因</span>${esc(a.root_cause)}</div><div><span class="label">永久对策</span>${esc(a.action || '待确定')}</div></div>
        ${v ? `<div class="grid g-1-1">
          <div class="stack" style="gap:10px">
            <div class="label">${esc(v.note)}</div>
            ${v.before ? `<div class="compare"><span class="muted small">断点前 ${v.before.batches} 批</span><span></span><span class="muted small">断点后 ${v.after.batches} 批</span>
              <b style="color:var(--before)">${pct(v.before.rate)}</b><span class="arrow muted">→</span><b style="color:var(--accent)">${pct(v.after.rate)}</b>
              <span class="small muted">${v.before.x} / ${int(v.before.n)} 台</span><span></span><span class="small muted">${v.after.x} / ${int(v.after.n)} 台</span></div>
              <div class="small">下降 <b>${Math.round(v.drop * 100)}%</b> · 单侧二项检验 p ${v.p_value < 1e-10 ? '< 10⁻¹⁰' : '= ' + (v.p_value < 0.0001 ? v.p_value.toExponential(1) : v.p_value.toFixed(4))}</div>` : `<div class="small muted">断点后已有 ${v.after_batches} 个批次，用满 3 个月的还不够，下个月起陆续可判断。</div>`}
            ${v.projection && v.projection.before && v.verdict !== '数据不足' ? `<div class="stat-grid"><div class="stat"><span class="small">改善前 5 年可靠度</span><b>${pct(v.projection.before.r5, 1)}</b></div>
              ${v.projection.after ? `<div class="stat"><span class="small">改善后预测（${esc(v.projection.after.method)}）</span><b style="color:${v.projection.after.r5 < v.projection.after.target_r5 ? 'var(--crit)' : 'var(--ok)'}">${pct(v.projection.after.r5, 1)}</b></div>` : ''}
              <div class="stat"><span class="small">目标</span><b>${pct(v.projection.before.target_r5, 0)}</b></div></div>
              <div class="small muted">按型号 ${esc(a.models.split(',')[0])} 的全部故障计算${v.verdict === '有效' && v.projection.after && v.projection.after.r5 < v.projection.after.target_r5 ? '；改善有效但仍未达到 5 年目标，需要继续处理其他失效模式' : ''}。</div>` : ''}
          </div>
          <div>${v.curves.before.length || v.curves.after.length ? lineChart({ W: 520, H: 230, xMax: v.mis || 18, yFmt: (y) => (y * 100).toFixed(2) + '%', aria: '断点前后累计故障率对比',
            xTicks: (v.mis ? Array.from({ length: v.mis + 1 }, (x, i) => i) : [0, 3, 6, 9, 12, 15, 18]).map((t) => [t, t + ' 月']),
            series: [{ label: '断点前 12 批', color: 'var(--before)', pts: v.curves.before, dots: true, r: 2.5 }, { label: '断点后批次', color: 'var(--accent)', pts: v.curves.after, dots: true, r: 2.5 }] })
            + `<div class="small muted">纵轴：只统计该失效模式的累计故障率；${v.mis ? '两条曲线都只用已用满对比月数的批次，与左侧结论同一口径。' : '每条曲线固定用同一组已用满最长月数的批次。'}</div>` : ''}</div>
        </div>` : '<div class="small muted">根因确认、确定断点批次后开始自动验证。</div>'}
      </div></section>`; }).join('')}`;
  }

  // ------------------------------------------------------------------ 视图：故障记录
  const recFilter = { line: '', flag: '' };
  async function viewRecords(root) {
    const list = await API.get('/api/field/records');
    root.innerHTML = `
      <section class="panel"><div class="panel-b stack" style="padding-top:14px">
        <form class="trace-box" id="tr-form"><input type="text" id="tr-q" placeholder="输入 SN、批次号或记录号，例如 SF101-2507-00123 / SF201-2511" aria-label="追溯查询"><button class="btn primary" type="submit">追溯</button><button class="btn" type="button" id="new-rec">新增报修</button>
          ${META.mode === 'static' ? '' : '<a class="btn" href="/api/field/export/failures.csv">导出 CSV</a>'}</form>
        <div class="filters"><button class="chip" data-rl="">全部</button>${Object.keys(N.line).map((c) => `<button class="chip" data-rl="${c}">${esc(lineName(c))}</button>`).join('')}
          <span class="sep"></span><button class="chip" data-rf="pending">只看待拆解</button><button class="chip" data-rf="untraced">只看无批次码</button></div>
      </div></section>
      <section class="panel"><div class="panel-h"><h2>最近报修记录</h2><span class="panel-sub" id="rec-count"></span></div><div class="panel-b table-wrap" id="rec-table"></div></section>`;
    const draw = () => {
      $$('[data-rl]', root).forEach((b) => b.classList.toggle('on', b.dataset.rl === recFilter.line));
      $$('[data-rf]', root).forEach((b) => b.classList.toggle('on', b.dataset.rf === recFilter.flag));
      const rows = list.filter((r) => (!recFilter.line || r.line === recFilter.line) && (recFilter.flag !== 'pending' || !r.part_code) && (recFilter.flag !== 'untraced' || !r.batch_no));
      $('#rec-count', root).textContent = `显示 ${rows.length} 条（最近 ${list.length} 条记录）`;
      $('#rec-table', root).innerHTML = `<table class="nowrap-table"><thead><tr><th>记录号</th><th>报修日期</th><th>渠道</th><th>型号</th><th>批次号</th><th class="num">使用月数</th><th>故障现象</th><th>故障部位</th><th>责任方</th><th>处理</th><th class="num">成本</th></tr></thead><tbody>
        ${rows.slice(0, 200).map((r) => `<tr class="click" data-rec="${esc(r.rec_no)}"><td class="mono">${esc(r.rec_no)}${r.source === '手工录入' ? ' ' + pill('新录入', 'info') : ''}</td><td class="num">${esc(r.report_date)}</td><td>${esc(r.channel)}</td><td>${esc(r.model_code)}</td>
          <td class="mono">${r.batch_no ? esc(r.batch_no) : '<span class="pill warn">无批次码</span>'}</td><td class="num">${r.age == null ? '—' : r.age}${r.batch_no && !r.install_date ? '<span class="muted" data-tip="安装日期缺失，按批次首次出货 + 25 天估算">*</span>' : ''}</td>
          <td>${esc(r.fault_code)} ${esc(r.fault_name)}</td><td>${r.part_code ? esc(r.part_code + ' ' + r.part_name) : '<span class="pill neutral">待拆解</span>'}</td><td>${r.resp ? esc(N.resp[r.resp].name) : '—'}</td><td>${esc(r.handling || '')}${r.returned ? ' <span class="muted small">已回收</span>' : ''}</td><td class="num">${int(r.cost)}</td></tr>`).join('')}
        </tbody></table>`;
      $$('[data-rec]', root).forEach((el) => el.addEventListener('click', () => openTrace(el.dataset.rec)));
    };
    $$('[data-rl]', root).forEach((b) => b.addEventListener('click', () => { recFilter.line = b.dataset.rl; draw(); }));
    $$('[data-rf]', root).forEach((b) => b.addEventListener('click', () => { recFilter.flag = recFilter.flag === b.dataset.rf ? '' : b.dataset.rf; draw(); }));
    $('#tr-form', root).addEventListener('submit', (e) => { e.preventDefault(); const q = $('#tr-q', root).value.trim(); if (q) openTrace(q); });
    $('#new-rec', root).addEventListener('click', () => recordDrawer(() => viewRecords(root)));
    draw();
  }

  async function openTrace(q) {
    let d;
    try { d = await API.get('/api/field/trace/' + encodeURIComponent(q)); } catch (e) { toast('没有找到：' + q + '。请检查 SN / 批次号 / 记录号'); return; }
    if (!d.batch) {
      drawer(`<div class="drawer-h"><div><div class="label">追溯</div><h3>${esc(d.record.rec_no)}</h3></div><button class="close-x" data-close aria-label="关闭">×</button></div>
        <div class="caution">${esc(d.message)}。这类记录只计入报修总量，不能进入批次故障率和寿命分析，这正是要推行统一批次编码的原因。</div>${recordFacts(d.record)}`);
      return;
    }
    const b = d.batch;
    const target = META.targets[b.line].mis12;
    drawer(`<div class="drawer-h"><div><div class="label">追溯 · ${esc(lineName(b.line))}</div><h3>${esc(b.batch_no)} ${esc(b.model_name)}</h3></div><button class="close-x" data-close aria-label="关闭">×</button></div>
      ${d.record ? `<div class="stack" style="gap:6px"><div class="label">报修记录</div>${recordFacts(d.record)}</div>` : ''}
      <div class="chain">
        <div class="node key"><span class="label">生产批次</span><b class="mono">${esc(b.batch_no)}</b><span>${esc(b.supplier_name)} · ${esc(b.prod_month)} 生产 ${int(b.prod_qty)} 台</span></div>
        <div class="node"><span class="label">出货</span>${d.shipments.map((s) => `<span>${esc(s.ship_date)} · ${int(s.qty)} 台</span>`).join('') || '<span class="muted">尚未出货</span>'}</div>
        <div class="node"><span class="label">报修</span><b>${d.fails} 台</b><span>占出货 ${pct(b.shipped ? d.fails / b.shipped : null)}</span></div>
      </div>
      <div class="stack" style="gap:6px"><div class="label">关键元器件批次</div><div class="table-wrap"><table><tbody>${d.components.map((c) => `<tr><td>${esc(c.component)}</td><td>${esc(c.part_no)}</td><td class="mono">${esc(c.lot_no)}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="stack" style="gap:6px"><div class="label">使用月数故障率</div><div class="table-wrap"><table><thead><tr>${Object.keys(d.mis).map((k) => `<th class="num">${k} 个月</th>`).join('')}</tr></thead><tbody><tr>
        ${Object.entries(d.mis).map(([k, c]) => `<td class="heat ${heatCls(c && c.rate, target, +k)}">${c ? pct(c.rate) + ` <span class="small muted">(${c.x})</span>` : '—'}</td>`).join('')}</tr></tbody></table></div></div>
      <div class="grid g-2"><div class="stack" style="gap:6px"><div class="label">故障现象</div>${barList(d.by_fault.map(([c, n, v]) => ({ label: c + ' ' + n, value: v })))}</div>
        <div class="stack" style="gap:6px"><div class="label">故障部位</div>${barList(d.by_part.map(([c, n, v]) => ({ label: (c === '待拆解' ? '' : c + ' ') + n, value: v })))}</div></div>
      <div class="stack" style="gap:6px"><div class="label">最近报修</div><div class="table-wrap"><table class="nowrap-table"><tbody>${d.recent.map((r) => `<tr><td class="mono">${esc(r.rec_no)}</td><td class="num">${esc(r.report_date)}</td><td>${esc(r.fault_name)}</td><td>${esc(r.part_name || '待拆解')}</td><td class="num">${r.age} 月</td></tr>`).join('') || '<tr><td class="empty">暂无报修</td></tr>'}</tbody></table></div></div>`);
  }

  function recordFacts(r) {
    const f = [['报修日期', r.report_date], ['渠道', r.channel], ['型号', r.model_code + ' ' + (r.model_name || '')], ['SN', r.sn || '—'], ['安装日期', r.install_date || '缺失'],
      ['使用月数', r.age == null ? '—' : r.age + ' 月'], ['故障现象', r.fault_code + ' ' + r.fault_name], ['故障部位', r.part_code ? r.part_code + ' ' + r.part_name : '待拆解'],
      ['责任方', r.resp ? N.resp[r.resp].name : '待判定'], ['处理', (r.handling || '') + (r.returned ? '，故障件已回收' : '')]];
    return `<div class="dims" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">${f.map(([k, v]) => `<div class="dim"><div class="label">${k}</div><div>${esc(v)}</div></div>`).join('')}</div>`;
  }

  function recordDrawer(done) {
    const today = META.as_of;
    const opt = (items, label) => items.map((x) => `<option value="${esc(x.code)}">${esc(label(x))}</option>`).join('');
    const d = drawer(`<div class="drawer-h"><div><div class="label">新增报修</div><h3>按故障代码录入</h3></div><button class="close-x" data-close aria-label="关闭">×</button></div>
      <form class="form-grid" id="rf">
        <label class="field"><span>报修日期</span><input type="date" id="rf-date" name="report_date" value="${today}" required></label>
        <label class="field"><span>报修渠道</span><select id="rf-ch" name="channel">${META.channels.map((c) => `<option>${esc(c)}</option>`).join('')}</select></label>
        <label class="field"><span>型号</span><select id="rf-model" name="model_code">${opt(META.models, (m) => m.code + ' ' + m.name)}</select></label>
        <label class="field"><span>SN（扫码或手输）</span><input type="text" id="rf-sn" name="sn" placeholder="例如 SF101-2507-00123"></label>
        <label class="field"><span>批次号（无 SN 时填写）</span><input type="text" id="rf-batch" name="batch_no" placeholder="例如 SF101-2507"></label>
        <label class="field"><span>安装日期</span><input type="date" id="rf-inst" name="install_date"></label>
        <label class="field full"><span>故障现象</span><select id="rf-fault" name="fault_code"></select></label>
        <label class="field full"><span>故障部位 / 根因（拆解后确认）</span><select id="rf-part" name="part_code"></select></label>
        <label class="field"><span>处理方式</span><select id="rf-hand" name="handling">${META.handling.map((h) => `<option>${esc(h)}</option>`).join('')}</select></label>
        <label class="field"><span>故障件</span><span class="row" style="min-height:34px"><input type="checkbox" id="rf-ret" name="returned" value="1"> <label for="rf-ret">已回收，待拆解分析</label></span></label>
        <label class="field full"><span>备注</span><input type="text" id="rf-note" name="note" placeholder="用户描述、现场照片编号等"></label>
        <div class="full msg-list" id="rf-msg"></div>
        <div class="full row"><button class="btn primary" type="submit">保存记录</button><button class="btn" type="button" data-close>取消</button></div>
      </form>`);
    const form = $('#rf', d);
    const fillCodes = () => {
      const line = N.model[$('#rf-model', d).value].line;
      $('#rf-fault', d).innerHTML = opt(META.faults.filter((f) => f.line === line), (f) => f.code + ' ' + f.name);
      $('#rf-part', d).innerHTML = '<option value="">待拆解确认</option>' + opt(META.parts.filter((p) => p.line === line), (p) => `${p.code} ${p.name}（默认责任：${N.resp[p.resp].name}）`);
    };
    const body = () => { const b = Object.fromEntries(new FormData(form).entries()); b.returned = $('#rf-ret', d).checked; return b; };
    let timer;
    const check = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const r = await API.post('/api/field/records/check', body());
          $('#rf-msg', d).innerHTML = r.errors.map((m) => `<div class="issue error">✕ <span>${esc(m)}</span></div>`).join('')
            + r.warnings.map((m) => `<div class="issue confirm">! <span>${esc(m)}</span></div>`).join('')
            + (r.errors.length ? '' : `<div class="issue fixed">✓ <span>${r.record.batch_no ? '可追溯到批次 ' + esc(r.record.batch_no) : '可以保存'}${r.record.cost ? '，处理成本约 ' + money(r.record.cost) : ''}</span></div>`);
        } catch (e) { /* 校验失败不影响录入 */ }
      }, 250);
    };
    $('#rf-model', d).addEventListener('change', () => { fillCodes(); check(); });
    form.addEventListener('input', check);
    form.addEventListener('change', check);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await API.post('/api/field/records', body());
        closeDrawer();
        toast(`已保存 ${r.record.rec_no}${r.warnings.length ? '（' + r.warnings[0].split('：')[0] + '）' : ''}`);
        done && done();
      } catch (err) { toast(err.message); }
    });
    fillCodes();
    check();
  }

  // ------------------------------------------------------------------ 视图：数据规则
  async function viewRules(root) {
    const d = await API.get('/api/field/rules');
    const q = d.quality;
    const ms = q.months;
    const idx = ms.findIndex((m) => m.month === q.coding_rule_month);
    const series = [['traceable', '可追溯率（有批次码）', 'var(--accent)'], ['install', '有安装日期', 'var(--s-sink)'], ['part', '已确认故障部位', 'var(--s-gd)'], ['returned', '故障件回收率', 'var(--before)']]
      .map(([k, label, color]) => ({ label, color, dots: true, r: 2.5, pts: ms.map((m, i) => [i, m[k], `${m.month} ${label}：${pct(m[k], 1)}（${m.records} 条）`]) }));
    root.innerHTML = `
      <section class="panel"><div class="panel-h"><h2>数据完整性</h2><span class="panel-sub">近 24 个月 · ${int(q.totals.records)} 条报修 · ${q.totals.batches} 个批次 · ${int(q.totals.units)} 台出货</span></div>
        <div class="panel-b">${lineChart({ series, xMax: ms.length - 1, yMax: 1, yFmt: (v) => Math.round(v * 100) + '%', aria: '数据完整性趋势',
          xTicks: ms.map((m, i) => [i, m.month.slice(2)]).filter((x, i) => i % 3 === 2 || i === ms.length - 1),
          vrefs: idx >= 0 ? [{ x: idx, label: '推行统一批次编码' }] : [] })}
        <p class="small muted">推行统一批次编码后，可追溯率从约 80% 提升到 95% 以上。最近两个月“已确认故障部位”偏低，是因为回收件还在拆解中。</p></div></section>
      <section class="panel"><div class="panel-h"><h2>指标口径</h2><span class="panel-sub">统一定义，避免各部门算法不一致</span></div>
        <div class="panel-b">${d.metrics.map((m) => `<div class="check" style="flex-direction:column;gap:2px"><span><b>${esc(m.name)}</b>　<span class="mono">${esc(m.formula)}</span></span><span class="small muted">${esc(m.note)}</span></div>`).join('')}</div></section>
      <div class="grid g-2">${d.lines.map((l) => `<section class="panel"><div class="panel-h"><h2>${esc(l.name)}故障代码</h2><span class="panel-sub">12 个月故障率目标 ${pct(l.mis12_target, 1)} · 5 年可靠度目标 ${pct(l.r5_target, 0)}</span></div>
        <div class="panel-b table-wrap"><table><thead><tr><th>现象代码</th><th>故障现象（用户看到的）</th></tr></thead><tbody>
          ${d.faults.filter((f) => f.line === l.code).map((f) => `<tr><td class="mono">${f.code}</td><td>${esc(f.name)}</td></tr>`).join('')}</tbody></table>
          <table style="margin-top:10px"><thead><tr><th>部位代码</th><th>故障部位 / 根因（拆解后确认）</th><th>默认责任方</th></tr></thead><tbody>
          ${d.parts.filter((p) => p.line === l.code).map((p) => `<tr><td class="mono">${p.code}</td><td>${esc(p.name)}</td><td>${esc(N.resp[p.resp].name)}</td></tr>`).join('')}</tbody></table></div></section>`).join('')}
        <section class="panel"><div class="panel-h"><h2>责任方</h2><span class="panel-sub">与质量协议的索赔条款对应</span></div><div class="panel-b">
          ${d.resp.map((r) => `<div class="check"><span><b class="mono">${r.code}</b> ${esc(r.name)}</span></div>`).join('')}
          <p class="small muted">SN 规则：型号-生产年月-流水号，例如 SF101-2507-00123；前两段即批次号 SF101-2507。</p></div></section>
      </div>`;
  }

  // ------------------------------------------------------------------ 外框与路由
  const VIEWS = {
    overview: ['总览', viewOverview],
    batches: ['批次故障率', viewBatches],
    reliability: ['寿命分析', viewReliability],
    modes: ['故障模式', viewModes],
    suppliers: ['代工厂', viewSuppliers],
    actions: ['改善验证', viewActions],
    records: ['故障记录', viewRecords],
    rules: ['数据规则', viewRules],
  };
  const NAV = Object.keys(VIEWS);

  function shell() {
    document.getElementById('app').innerHTML = `<div class="shell">
      <aside class="side">
        <div class="brand"><span class="brand-mark">售后</span><span><div class="brand-name">售后故障追踪</div><div class="brand-sub">批次 · 寿命 · 闭环</div></span></div>
        <nav class="nav">${NAV.map((v) => `<button data-nav="${v}"><span>${VIEWS[v][0]}</span></button>`).join('')}</nav>
        <div class="side-foot"><span>数据截止 <b id="asof"></b></span><span id="counts"></span><span>演示数据为模拟数据，不对应任何真实企业</span><span id="sqm-link"></span></div>
      </aside>
      <main class="main"><div class="topbar"><div><h1 id="title"></h1></div><div class="meta-chips" id="chips"></div></div>
        <div id="banner"></div><div id="view" class="stack" style="gap:16px"></div></main></div>`;
    $$('[data-nav]').forEach((b) => b.addEventListener('click', () => go(b.dataset.nav)));
    document.body.appendChild(tip);
  }

  function parseHash() {
    const v = (location.hash || '').replace(/^#/, '').split('~')[0];
    return VIEWS[v] ? v : 'overview';
  }

  let current = 'overview';
  function go(view) {
    current = view;
    try { if (location.hash !== '#' + view) history.pushState(null, '', '#' + view); } catch (e) { /* 受限环境下忽略 */ }
    render();
  }
  window.addEventListener('popstate', () => { current = parseHash(); render(); });

  async function render() {
    closeDrawer();
    tip.hidden = true;
    const [title, fn] = VIEWS[current];
    $$('[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === current));
    $('#title').textContent = title;
    const root = $('#view');
    root.innerHTML = '<div class="loading">加载中…</div>';
    window.scrollTo(0, 0);
    try {
      await fn(root);
    } catch (e) {
      root.innerHTML = `<div class="panel empty">加载失败：${esc(e.message)}</div>`;
    }
  }

  async function boot() {
    shell();
    try {
      META = await API.get('/api/field/meta');
    } catch (e) {
      $('#view').innerHTML = `<div class="panel empty">无法连接后端服务：${esc(e.message)}。请先运行 python run.py。</div>`;
      return;
    }
    META.models.forEach((m) => { N.model[m.code] = m; });
    META.suppliers.forEach((s) => { N.sup[s.code] = s; });
    META.faults.forEach((f) => { N.fault[f.code] = f; });
    META.parts.forEach((p) => { N.part[p.code] = p; });
    META.resp.forEach((r) => { N.resp[r.code] = r; });
    META.lines.forEach((l) => { N.line[l.code] = l; });
    $('#asof').textContent = META.as_of;
    $('#counts').textContent = `${META.models.length} 个型号 · ${META.counts.batches} 个批次 · ${int(META.counts.records)} 条报修`;
    $('#chips').innerHTML = `<span class="pill neutral">数据截止 ${META.as_of}</span><span class="pill neutral">${int(META.counts.units)} 台在用</span>`;
    if (META.mode === 'static') {
      $('#banner').innerHTML = '<div class="banner"><b>在线预览版</b><span>数据为模拟数据的静态快照。新增报修只保存在当前页面，统计结果不随之重算，刷新后复原。完整版（SQLite 数据库、实时重算、导出 CSV）请本地运行 python run.py。</span></div>';
    } else {
      $('#sqm-link').innerHTML = '<a href="/">来料质量 SQM Insight →</a>';
    }
    current = parseHash();
    render();
  }

  boot();
})();
