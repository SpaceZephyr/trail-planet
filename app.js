/* 徒步星球：MapLibre 3D 地球 + 路线筛选 / 随机 / 自动巡游 / 沿线拖动 */
(() => {
const $ = s => document.querySelector(s);
const css = getComputedStyle(document.documentElement);
const tok = n => css.getPropertyValue(n).trim();
const CATS = [
  ['all', '全部'], ['snow', '雪山'], ['glacier', '冰川'], ['forest', '森林'], ['coast', '海岸'],
  ['canyon', '峡谷峡湾'], ['volcano', '火山'], ['peak', '奇峰'], ['meadow', '草甸荒原'],
];
const COLOR = Object.fromEntries(CATS.slice(1).map(([k]) => [k, tok('--c-' + k)]));
const CATNAME = Object.fromEntries(CATS);
const DIST = [['all', '全部', 0, 1e9], ['s', '≤10 km', 0, 10.01], ['m', '10–30', 10.01, 30.01], ['l', '30–100', 30.01, 100.01], ['xl', '100+', 100.01, 1e9]];
const KIND = { oneway: '单程', loop: '环线', outback: '往返' };
const LEVEL = ['', '轻松', '适中', '有挑战', '艰难', '极难'];
const BLAZE = tok('--blaze');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const mobile = () => innerWidth < 900;

let T = [], byId = {}, shown = [], cur = null;
const st = { cat: 'all', dist: 'all' };
try { Object.assign(st, JSON.parse(localStorage.getItem('tp-filter') || '{}')); } catch (e) {}

// ---------- 几何
const R = 6371, rad = Math.PI / 180;
const hav = (a, b) => { const dl = (b[1] - a[1]) * rad, dg = (b[0] - a[0]) * rad; const h = Math.sin(dl / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dg / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const brg = (a, b) => { const y = Math.sin((b[0] - a[0]) * rad) * Math.cos(b[1] * rad); const x = Math.cos(a[1] * rad) * Math.sin(b[1] * rad) - Math.sin(a[1] * rad) * Math.cos(b[1] * rad) * Math.cos((b[0] - a[0]) * rad); return (Math.atan2(y, x) / rad + 360) % 360; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerpAng = (a, b, e) => a + (((b - a + 540) % 360) - 180) * e;
function prep(t) {
  t.cum = [0];
  for (let i = 1; i < t.line.length; i++) t.cum.push(t.cum[i - 1] + hav(t.line[i - 1], t.line[i]));
  t.len = t.cum[t.cum.length - 1];
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  for (const [x, y] of t.line) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  t.bbox = [[x0, y0], [x1, y1]];
}
function along(t, d) {
  d = clamp(d, 0, t.len); const c = t.cum; let lo = 0, hi = c.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= d) lo = m; else hi = m; }
  const u = (d - c[lo]) / Math.max(1e-9, c[hi] - c[lo]), a = t.line[lo], b = t.line[hi];
  return { p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], i: lo };
}
const slice = (t, d) => { const r = along(t, d); return t.line.slice(0, r.i + 1).concat([r.p]); };

// ---------- 地图
const map = new maplibregl.Map({
  container: 'map', center: [96, 24], zoom: mobile() ? 1.15 : 1.75, maxPitch: 80, hash: false,
  attributionControl: { compact: true, customAttribution: '路线 © OpenStreetMap 贡献者 · 徒步星球' },
  style: {
    version: 8, projection: { type: 'globe' },
    sources: {
      sat: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 18, attribution: '影像 © Esri, Maxar, Earthstar Geographics' },
      dem: { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], encoding: 'terrarium', tileSize: 256, maxzoom: 13, attribution: '高程 © Mapzen, AWS Terrain Tiles' },
    },
    sky: {
      'sky-color': '#0b1a2e', 'horizon-color': '#9fc7e8', 'fog-color': '#cfe3f2', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.75,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 9, 0.4, 12, 0],
    },
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#04070b' } }, { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-fade-duration': 200 } }],
  },
});
map.touchPitch.enable();
map.on('error', e => console.warn('[map]', e.error && e.error.message));

const fc = f => ({ type: 'FeatureCollection', features: f });
const lineF = (coords, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } });

function addLayers() {
  map.setTerrain({ source: 'dem', exaggeration: 1.45 });
  map.addSource('trails', { type: 'geojson', data: fc(T.map(t => lineF(t.line, { id: t.id, color: COLOR[t.cat] }))) });
  map.addSource('starts', { type: 'geojson', data: fc(T.map(t => ({ type: 'Feature', properties: { id: t.id, color: COLOR[t.cat] }, geometry: { type: 'Point', coordinates: t.line[0] } }))) });
  map.addSource('sel', { type: 'geojson', data: fc([]) });
  map.addSource('done', { type: 'geojson', data: fc([]) });
  const w = (a, b, c) => ['interpolate', ['linear'], ['zoom'], 1, a, 8, b, 14, c];
  map.addLayer({ id: 'tl-case', type: 'line', source: 'trails', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#000', 'line-opacity': 0.4, 'line-width': w(2.5, 5, 8) } });
  map.addLayer({ id: 'tl', type: 'line', source: 'trails', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': w(1.2, 2.6, 4.2) } });
  map.addLayer({ id: 'sel-glow', type: 'line', source: 'sel', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': BLAZE, 'line-opacity': 0.35, 'line-blur': 6, 'line-width': w(8, 12, 16) } });
  map.addLayer({ id: 'sel', type: 'line', source: 'sel', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#fff7d6', 'line-opacity': 0.85, 'line-width': w(2, 3, 4), 'line-dasharray': [1.2, 1.4] } });
  map.addLayer({ id: 'done', type: 'line', source: 'done', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': BLAZE, 'line-width': w(3, 4.5, 6) } });
  map.addLayer({ id: 'pt-halo', type: 'circle', source: 'starts', paint: { 'circle-color': ['get', 'color'], 'circle-opacity': 0.28, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 8, 8, 12], 'circle-pitch-alignment': 'map' } });
  map.addLayer({ id: 'pt', type: 'circle', source: 'starts', paint: { 'circle-color': ['get', 'color'], 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 4, 8, 6], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5, 'circle-pitch-alignment': 'map' } });

  for (const id of ['pt', 'pt-halo', 'tl']) {
    map.on('click', id, e => { const f = e.features[0]; if (f) { stopTour(); select(byId[f.properties.id], { fly: true }); } });
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; tip.hidden = true; });
    map.on('mousemove', id, e => {
      const t = byId[e.features[0].properties.id]; if (!t) return;
      tip.innerHTML = `<b>${t.name}</b>${t.where} · ${fmtKm(t.km)} km`; tip.hidden = false;
      tip.style.left = e.originalEvent.clientX + 14 + 'px'; tip.style.top = e.originalEvent.clientY + 14 + 'px';
    });
  }
  applyFilter();
}
const tip = Object.assign(document.createElement('div'), { className: 'tip', hidden: true }); document.body.append(tip);

// ---------- 筛选 + 列表
const fmtKm = k => (k >= 100 ? Math.round(k) : +(+k).toFixed(1)).toString();
function matches(t, cat = st.cat, dist = st.dist) {
  const d = DIST.find(x => x[0] === dist);
  return (cat === 'all' || t.cat === cat) && t.km > d[2] && t.km <= d[3];
}
function buildFilters() {
  $('#cats').innerHTML = CATS.map(([k, n]) => `<button class="chip" data-cat="${k}" aria-pressed="${st.cat === k}" style="--c:${COLOR[k] || 'var(--fg)'}">${k === 'all' ? '' : '<i></i>'}${n}<b data-n="${k}"></b></button>`).join('');
  $('#dist').innerHTML = DIST.map(([k, n]) => `<button data-dist="${k}" aria-pressed="${st.dist === k}">${n}</button>`).join('');
  $('#cats').onclick = e => { const b = e.target.closest('[data-cat]'); if (b) { st.cat = b.dataset.cat; applyFilter(true); } };
  $('#dist').onclick = e => { const b = e.target.closest('[data-dist]'); if (b) { st.dist = b.dataset.dist; applyFilter(true); } };
}
function applyFilter(user) {
  try { localStorage.setItem('tp-filter', JSON.stringify(st)); } catch (e) {}
  document.querySelectorAll('[data-cat]').forEach(b => b.setAttribute('aria-pressed', b.dataset.cat === st.cat));
  document.querySelectorAll('[data-dist]').forEach(b => b.setAttribute('aria-pressed', b.dataset.dist === st.dist));
  document.querySelectorAll('[data-n]').forEach(b => { b.textContent = T.filter(t => matches(t, b.dataset.n)).length; });
  shown = T.filter(t => matches(t));
  $('#count').textContent = `${shown.length} 条经典徒步路线 · 3D 地形`;
  if (map.getLayer('tl')) {
    const f = ['in', ['get', 'id'], ['literal', shown.map(t => t.id)]];
    for (const id of ['tl', 'tl-case', 'pt', 'pt-halo']) map.setFilter(id, f);
  }
  renderList();
  if (user && cur && !shown.includes(cur)) close();
  if (user && shown.length && !cur) fitAll();
}
function renderList() {
  const L = $('#list');
  if (!shown.length) { L.innerHTML = '<div class="empty glass">这个组合下还没有路线，换个分类或里程试试。</div>'; return; }
  L.innerHTML = shown.map(t => `<button class="card" data-id="${t.id}" style="--c:${COLOR[t.cat]}" aria-current="${cur === t}">
    <i></i><span class="n">${t.name}</span><span class="w">${t.where} · ${CATNAME[t.cat]}</span>
    <span class="k">${fmtKm(t.km)} km<small>${t.days}</small></span></button>`).join('');
}
$('#list').onclick = e => { const b = e.target.closest('[data-id]'); if (b) { stopTour(); select(byId[b.dataset.id], { fly: true }); } };

// ---------- 详情
const pinEl = Object.assign(document.createElement('div'), { className: 'pinlabel' });
const pin = new maplibregl.Marker({ element: pinEl, anchor: 'bottom' });
const hikerEl = Object.assign(document.createElement('div'), { className: 'hiker' });
const hiker = new maplibregl.Marker({ element: hikerEl });
let prog = 0;

function select(t, { fly } = {}) {
  if (!t) return;
  pause(); cur = t; prog = 0;
  history.replaceState(null, '', '#' + t.id);
  $('#d-tag').innerHTML = `<i style="--c:${COLOR[t.cat]}"></i>${CATNAME[t.cat]} · ${t.where}`;
  $('#d-name').textContent = t.name; $('#d-en').textContent = t.en;
  $('#d-stats').innerHTML = [
    ['距离', `${fmtKm(t.km)}<small> km ${KIND[t.kind]}</small>`], ['用时', t.days],
    ['最高海拔', `${t.max.toLocaleString()}<small> m</small>`], ['最佳季节', t.season],
  ].map(([a, b]) => `<div><dt>${a}</dt><dd title="${b.replace(/<[^>]+>/g, '')}">${b}</dd></div>`).join('');
  $('#d-lvl').innerHTML = `难度 <span>${[1, 2, 3, 4, 5].map(i => `<i class="${i <= t.level ? 'on' : ''}"></i>`).join('')}</span> ${LEVEL[t.level]}<em>海拔 ${t.lo.toLocaleString()}–${t.hi.toLocaleString()} m</em>`;
  $('#d-desc').textContent = t.desc;
  $('#d-note').textContent = (t.src === 'line' ? '轨迹为途经点连线示意' : '轨迹沿 OpenStreetMap 步道生成') + (t.kind === 'outback' ? '，图上只画去程' : '') + '；里程、天数为常见走法，出发前请以当地信息为准。';
  $('#detail').hidden = false; $('#detail').classList.toggle('min', mobile());
  if (mobile()) $('#list').hidden = true;
  map.getSource('sel')?.setData(fc([lineF(t.line)]));
  map.getSource('done')?.setData(fc([]));
  pinEl.textContent = t.name; pin.setLngLat(t.line[0]).addTo(map);
  hiker.setLngLat(t.line[0]).addTo(map);
  setProg(0, false);
  document.querySelectorAll('.card').forEach(c => c.setAttribute('aria-current', c.dataset.id === t.id));
  document.querySelector(`.card[data-id="${t.id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  requestAnimationFrame(drawProf);
  if (fly) overview(t);
}
function close() {
  pause(); cur = null; $('#detail').hidden = true; $('#list').hidden = false;
  pin.remove(); hiker.remove();
  map.getSource('sel')?.setData(fc([])); map.getSource('done')?.setData(fc([]));
  history.replaceState(null, '', location.pathname);
  renderList();
}
$('#d-close').onclick = () => { stopTour(); close(); };
const toggleSheet = e => { if (mobile() && !e.target.closest('.x')) { $('#detail').classList.toggle('min'); requestAnimationFrame(drawProf); } };
$('.d-head').addEventListener('click', toggleSheet); $('.grab').addEventListener('click', toggleSheet);
function step(k) {
  if (!shown.length) return;
  const i = shown.indexOf(cur); stopTour();
  select(shown[(i + k + shown.length) % shown.length], { fly: true });
}
$('#prev').onclick = () => step(-1); $('#next').onclick = () => step(1);

// 镜头留白：避开面板
function pad() {
  const W = innerWidth, H = innerHeight, top = $('#top').getBoundingClientRect().bottom + 12;
  if (mobile()) {
    const d = $('#detail'), bot = d.hidden ? 0 : H - d.getBoundingClientRect().top + 8;
    return { top: Math.min(top, H * 0.35), bottom: Math.min(bot, H * 0.6), left: 24, right: 24 };
  }
  return { top: 72, bottom: 40, left: $('#list').hidden ? 40 : Math.min(340, W * 0.3), right: cur ? Math.min(420, W * 0.35) : 40 };
}
const zoomFor = L => clamp(14.4 - Math.log2(Math.max(L, 1)) * 0.6, 10.8, 14.2);
let camTok = 0;
// 镜头飞完再做下一步（被用户打断或被新镜头顶掉就不做）
const after = (tok, fn) => { const go = () => tok === camTok && fn(); reduce ? setTimeout(go, 0) : map.once('moveend', go); };
function overview(t, done) {
  const tok = ++camTok, p = pad();
  let cam = null;
  try { cam = map.cameraForBounds(t.bbox, { padding: p, pitch: 55, bearing: -15 }); } catch (e) {}
  if (!cam) {                                   // 地球视图下飞行中 cameraForBounds 偶尔算不出来：按跨度估一个
    const [[x0, y0], [x1, y1]] = t.bbox, lat = (y0 + y1) / 2;
    const span = Math.max(x1 - x0, (y1 - y0) / Math.cos(lat * rad), 0.01);
    cam = { center: [(x0 + x1) / 2, lat], zoom: Math.log2((innerWidth * 0.45 * 360) / (512 * span)) };
  }
  const z = Math.min(cam.zoom, 14.5);
  map.flyTo({ center: cam.center, zoom: z, pitch: 55, bearing: -15, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: reduce ? 0 : 4200, essential: true, curve: 1.6 });
  if (done) after(tok, done);
}
function fitAll() {
  if (!shown.length) return; ++camTok;
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  for (const t of shown) { x0 = Math.min(x0, t.bbox[0][0]); y0 = Math.min(y0, t.bbox[0][1]); x1 = Math.max(x1, t.bbox[1][0]); y1 = Math.max(y1, t.bbox[1][1]); }
  if (x1 - x0 > 120 || shown.length > 6) map.flyTo({ center: [(x0 + x1) / 2, clamp((y0 + y1) / 2, -30, 45)], zoom: mobile() ? 1.15 : 1.75, pitch: 0, bearing: 0, duration: reduce ? 0 : 2500 });
  else map.fitBounds([[x0, y0], [x1, y1]], { padding: pad(), pitch: 0, bearing: 0, maxZoom: 6, duration: reduce ? 0 : 2500 });
}

// ---------- 沿线：进度、镜头跟随
let camB = 0;
function setProg(p, follow, snap, k = 0.05) {
  prog = clamp(p, 0, 1); const t = cur; if (!t) return;
  const d = prog * t.len, r = along(t, d);
  hiker.setLngLat(r.p);
  map.getSource('done')?.setData(fc(prog > 0 ? [lineF(slice(t, d))] : []));
  $('#scrub').value = Math.round(prog * 1000);
  drawProf();
  if (follow) {
    const look = clamp(t.len * 0.05, 0.3, 6);
    const a = along(t, Math.max(0, d - look * 0.3)).p, b = along(t, Math.min(t.len, d + look)).p;
    const want = brg(a, b);
    camB = snap ? want : lerpAng(camB, want, k);
    map.jumpTo({ center: r.p, zoom: zoomFor(t.len), pitch: 62, bearing: camB, padding: pad() });
  }
}
const play = { on: false, raf: 0, last: 0, dur: 20 };
function startPlay() {
  const t = cur; if (!t) return;
  if (prog >= 0.999) prog = 0;
  play.on = true; setPlayBtn(); if (mobile()) $('#detail').classList.add('min');
  play.dur = reduce ? 8 : clamp(14 + t.len * 0.11, 16, 42);
  const r = along(t, prog * t.len), look = clamp(t.len * 0.05, 0.3, 6);
  camB = brg(r.p, along(t, prog * t.len + look).p);
  const tok = ++camTok;
  map.flyTo({ center: r.p, zoom: zoomFor(t.len), pitch: 62, bearing: camB, padding: pad(), duration: reduce ? 0 : 2600, essential: true });
  after(tok, () => { if (!play.on) return; play.last = performance.now(); play.raf = requestAnimationFrame(tick); });
}
function tick(now) {
  if (!play.on) return;
  const dt = Math.min(0.1, (now - play.last) / 1000); play.last = now;
  const p = prog + dt / play.dur;
  setProg(p, true);
  if (p >= 1) { pause(); ended(); return; }
  play.raf = requestAnimationFrame(tick);
}
function pause() { play.on = false; cancelAnimationFrame(play.raf); setPlayBtn(); }
function setPlayBtn() {
  $('#play').innerHTML = play.on ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg><span>暂停</span>'
    : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg><span>${prog > 0.001 && prog < 0.999 ? '继续' : '沿线飞行'}</span>`;
}
$('#play').onclick = () => { stopTour(); play.on ? pause() : startPlay(); };
$('#scrub').addEventListener('input', e => { stopTour(); pause(); setProg(e.target.value / 1000, true, !drag.moved, 0.35); drag.moved = true; });
$('#scrub').addEventListener('change', () => { drag.moved = false; });
function ended() {
  if (!cur) return;
  overview(cur, () => { if (tour.on) tour.timer = setTimeout(tourNext, 2200); });
}

// ---------- 海拔剖面
const drag = { on: false, moved: false };
function drawProf() {
  const c = $('#prof'), t = cur; if (!t || !c.offsetWidth) return;
  const dpr = devicePixelRatio || 1, W = c.offsetWidth, H = c.offsetHeight;
  if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; }
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const P = t.prof, L = P[P.length - 1][0] || 1, l = 40, r = 6, tp = 18, b = 16;
  let lo = t.lo, hi = t.hi; if (hi - lo < 60) { hi += 30; lo -= 30; }
  const X = d => l + (d / L) * (W - l - r), Y = e => tp + (1 - (e - lo) / (hi - lo)) * (H - tp - b);
  const col = COLOR[t.cat];
  g.font = `10px ${tok('--mono')}`; g.fillStyle = tok('--muted'); g.strokeStyle = 'rgba(220,235,228,.12)'; g.lineWidth = 1;
  for (const e of [hi, lo]) { g.beginPath(); g.moveTo(l, Y(e) + .5); g.lineTo(W - r, Y(e) + .5); g.stroke(); g.textAlign = 'right'; g.fillText(`${Math.round(e).toLocaleString()}m`, l - 4, Y(e) + 3); }
  g.textAlign = 'left'; g.fillText('0', l, H - 3); g.textAlign = 'right'; g.fillText(`${fmtKm(L)} km`, W - r, H - 3);
  const grad = g.createLinearGradient(0, tp, 0, H - b); grad.addColorStop(0, col + 'aa'); grad.addColorStop(1, col + '08');
  g.beginPath(); g.moveTo(X(0), H - b); P.forEach(([d, e]) => g.lineTo(X(d), Y(e))); g.lineTo(X(L), H - b); g.closePath(); g.fillStyle = grad; g.fill();
  g.beginPath(); P.forEach(([d, e], i) => (i ? g.lineTo : g.moveTo).call(g, X(d), Y(e))); g.strokeStyle = col; g.lineWidth = 1.6; g.stroke();
  // 已走
  const d = prog * L, k = Math.min(P.length - 1, Math.round(prog * (P.length - 1))), e = P[k][1];
  g.save(); g.beginPath(); g.rect(l, 0, X(d) - l, H); g.clip();
  g.beginPath(); P.forEach(([dd, ee], i) => (i ? g.lineTo : g.moveTo).call(g, X(dd), Y(ee))); g.strokeStyle = BLAZE; g.lineWidth = 2.4; g.stroke(); g.restore();
  g.strokeStyle = BLAZE; g.lineWidth = 1; g.beginPath(); g.moveTo(X(d) + .5, tp - 4); g.lineTo(X(d) + .5, H - b); g.stroke();
  g.fillStyle = BLAZE; g.beginPath(); g.arc(X(d), Y(e), 4, 0, 7); g.fill();
  const lab = `${fmtKm(d)} km · ${e.toLocaleString()} m`; g.font = `600 11px ${tok('--mono')}`;
  const tw = g.measureText(lab).width; g.textAlign = 'left';
  g.fillStyle = tok('--fg'); g.fillText(lab, clamp(X(d) - tw / 2, l, W - r - tw), 11);
}
const profAt = ev => { const c = $('#prof'), rc = c.getBoundingClientRect(); return clamp((ev.clientX - rc.left - 40) / (rc.width - 46), 0, 1); };
$('#prof').addEventListener('pointerdown', ev => { if (!cur) return; stopTour(); pause(); drag.on = true; $('#prof').setPointerCapture(ev.pointerId); setProg(profAt(ev), true, true); });
$('#prof').addEventListener('pointermove', ev => { if (drag.on) setProg(profAt(ev), true, false, 0.35); });
$('#prof').addEventListener('pointerup', () => { drag.on = false; });
const layout = () => document.documentElement.style.setProperty('--top', $('#top').getBoundingClientRect().bottom + 'px');
addEventListener('resize', () => { layout(); requestAnimationFrame(drawProf); });

// ---------- 随机、巡游、地球视图
let lastPick = null;
function pick() {
  const pool = shown.filter(t => t !== cur && t !== lastPick);
  const t = (pool.length ? pool : shown)[Math.floor(Math.random() * (pool.length || shown.length))]; lastPick = cur; return t;
}
function toast(s) { const el = $('#toast'); el.textContent = s; el.hidden = false; el.style.opacity = 1; clearTimeout(toast.t); toast.t = setTimeout(() => { el.style.opacity = 0; setTimeout(() => (el.hidden = true), 300); }, 1600); }
$('#dice').onclick = () => { if (!shown.length) return toast('当前筛选下没有路线'); stopTour(); select(pick(), { fly: true }); };
const tour = { on: false, timer: 0 };
function tourNext() {
  if (!tour.on || !shown.length) return;
  const t = pick(); select(t, { fly: false });
  overview(t, () => { tour.timer = setTimeout(() => tour.on && startPlay(), 1400); });
}
function startTour() { if (!shown.length) return toast('当前筛选下没有路线'); tour.on = true; $('#tour').setAttribute('aria-pressed', true); idle.on = false; tourNext(); }
function stopTour(msg) {
  if (!tour.on) return; tour.on = false; clearTimeout(tour.timer); $('#tour').setAttribute('aria-pressed', false);
  if (msg) toast(msg);
}
$('#tour').onclick = () => (tour.on ? (stopTour(), pause()) : startTour());
$('#globe').onclick = () => { stopTour(); close(); fitAll(); idle.at = performance.now() - 5000; };
// 用户动手：暂停巡游和飞行
map.on('movestart', e => { if (e.originalEvent) { idle.at = performance.now(); if (play.on) pause(); stopTour('已暂停自动巡游'); ++camTok; } });

// 地球空闲时慢慢转
const idle = { at: performance.now(), on: !reduce };
function spin(now) {
  requestAnimationFrame(spin);
  if (!idle.on || cur || tour.on || map.isMoving() || now - idle.at < 3500 || map.getZoom() > 3) return;
  const c = map.getCenter(); map.jumpTo({ center: [c.lng + 0.035, c.lat] });
}

// ---------- 启动
fetch('data/trails.json').then(r => r.json()).then(d => {
  T = d; T.forEach(prep); byId = Object.fromEntries(T.map(t => [t.id, t]));
  buildFilters(); applyFilter(); layout();
  const go = () => {
    addLayers(); requestAnimationFrame(spin);
    const h = location.hash.slice(1);
    if (byId[h]) { if (!shown.includes(byId[h])) { st.cat = 'all'; st.dist = 'all'; applyFilter(); } select(byId[h], { fly: true }); }
  };
  map.loaded() ? go() : map.once('load', go);
}).catch(e => { $('#list').innerHTML = `<div class="empty glass">路线数据没加载出来（${e.message}），刷新试试。</div>`; });
})();
