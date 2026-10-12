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
  (t.stops || []).forEach((s, i) => { s.i = i; s.dj = clamp(s.d / t.line_km * t.len, 0, t.len); });
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
  container: 'map', center: [96, 24], zoom: mobile() ? 1.15 : 1.75, maxPitch: 85, hash: false,
  attributionControl: { compact: true, customAttribution: '路线 © OpenStreetMap 贡献者 · 徒步星球' },
  style: {
    version: 8, projection: { type: 'globe' },
    sources: {
      sat: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 18, attribution: '影像 © Esri, Maxar, Earthstar Geographics' },
      dem: { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], encoding: 'terrarium', tileSize: 256, maxzoom: 13, attribution: '高程 © Mapzen, AWS Terrain Tiles' },
    },
    sky: {
      'sky-color': ['interpolate', ['linear'], ['zoom'], 6, '#0b1a2e', 11, '#3f7fc0'], 'horizon-color': '#b9d8ee', 'fog-color': '#d6e6f0',
      'sky-horizon-blend': 0.55, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.88,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 9, 0.4, 12, 0],
    },
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#04070b' } }, { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-fade-duration': 200 } }],
  },
});
map.touchPitch.enable();
map.on('error', e => console.warn('[map]', e.error && e.error.message));

let EXAG = 1.45;            // 远看夸张一点地形更立体；贴地跟拍时改回 1（真实比例）
const fc = f => ({ type: 'FeatureCollection', features: f });
const lineF = (coords, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } });

function addLayers() {
  map.setTerrain({ source: 'dem', exaggeration: EXAG });
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
// 跟拍时把当前路线的底色线、光晕藏起来（近处会被透视放大成色块）
let chasing = false;
function chaseMode(on) {
  on = !!on; if (on === chasing || !map.getLayer('tl')) return; chasing = on;
  map.setLayoutProperty('sel-glow', 'visibility', on ? 'none' : 'visible');
  map.setCenterClampedToGround(!on);
  EXAG = on ? 1 : 1.45; map.setTerrain({ source: 'dem', exaggeration: EXAG });      // 跟拍时中心点可以悬空（对准山腰），不让地图把它按回地面
  setTrailFilter();
}
function setTrailFilter() {
  if (!map.getLayer('tl')) return;
  const ids = shown.filter(t => !(chasing && t === cur)).map(t => t.id), f = ['in', ['get', 'id'], ['literal', ids]];
  for (const id of ['tl', 'tl-case', 'pt', 'pt-halo']) map.setFilter(id, f);
}
function applyFilter(user) {
  try { localStorage.setItem('tp-filter', JSON.stringify(st)); } catch (e) {}
  document.querySelectorAll('[data-cat]').forEach(b => b.setAttribute('aria-pressed', b.dataset.cat === st.cat));
  document.querySelectorAll('[data-dist]').forEach(b => b.setAttribute('aria-pressed', b.dataset.dist === st.dist));
  document.querySelectorAll('[data-n]').forEach(b => { b.textContent = T.filter(t => matches(t, b.dataset.n)).length; });
  shown = T.filter(t => matches(t));
  $('#count').textContent = `${shown.length} 条经典徒步路线 · 3D 地形`;
  setTrailFilter();
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
  $('#d-stops').hidden = !t.stops;
  $('#d-stops').innerHTML = t.stops ? `<h3>沿途看点 <small>沿线飞行会在每一站停下来</small></h3><ol>${t.stops.map(s =>
    `<li><button data-stop="${s.i}" style="--k:${KC[s.kind]}">${ICON[s.kind]}<span>${s.name}</span><em>${fmtKm(s.d)} km</em></button></li>`).join('')}</ol>` : '';
  showStory(t);
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
  pause(); cur = null; showStory(null); chaseMode(false); $('#detail').hidden = true; $('#list').hidden = false;
  pin.remove(); hiker.remove();
  map.getSource('sel')?.setData(fc([])); map.getSource('done')?.setData(fc([]));
  history.replaceState(null, '', location.pathname);
  renderList();
}
$('#d-close').onclick = () => { stopTour(); close(); };
const toggleSheet = e => { if (mobile() && !e.target.closest('.x')) { $('#detail').classList.toggle('min'); requestAnimationFrame(() => { drawProf(); placeCap(); }); } };
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
  if (cur === t && t.stops) { setProg(prog, false); markShow(); }
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
// 有看点的路线（story）用跟拍镜头：相机放在人身后几百米、离地几百米，朝前看；停在看点时转向要看的东西
const cam = { b: 0, p: 62, z: 12, back: 0.8, clear: 520 };
const ZERO = { top: 0, bottom: 0, left: 0, right: 0 };
if (/[?&]debug/.test(location.search)) window.__tp = { map, cam };
const offset = (p, b, km) => [p[0] + km * Math.sin(b * rad) / (111.32 * Math.cos(p[1] * rad)), p[1] + km * Math.cos(b * rad) / 110.57];
function eleAt(t, d) { const P = t.prof; return P[clamp(Math.round(d / t.len * (P.length - 1)), 0, P.length - 1)][1]; }
function camFor(t, d, stop) {
  const here = along(t, d).p, look = clamp(t.len * 0.05, 0.3, 6);
  const want = brg(along(t, Math.max(0, d - look * 0.3)).p, along(t, Math.min(t.len, d + look)).p);
  if (!t.stops) return { c: here, b: want, p: 62, z: zoomFor(t.len) };
  if (stop && stop.look) {   // 看点：转身对着要看的东西；远处雪山把相机抬高、往后拉，让山顶留在画面上部
    const far = hav(here, stop.look) > 3;
    return { c: here, b: brg(here, stop.look), look: stop.look, p: far ? 85 : 70, back: far ? 1.4 : 0.55, clear: far ? 1100 : 320 };
  }
  return { c: here, b: want, look: null, p: 80, back: 1.0, clear: 380 };
}
// 跟拍：相机在人身后 back km、离地 clear m，对准一个目标点（行进时是前方 1.2 km 的地面，看点时是那座山/那条瀑布）。
// 用「相机点 → 目标点」反算镜头，地图中心就落在目标上，不会被放到海平面上。
function chase(t, d, sway = 0) {
  const H = along(t, d).p, b = cam.b + sway, C = offset(H, b + 180, cam.back), M = offset(H, b + 180, cam.back / 2);
  const g = q => map.queryTerrainElevation(q) || 0, eH = eleAt(t, d) * EXAG;
  const ground = Math.max(eH, g(H), g(C), g(M));
  const wantAlt = ground + cam.clear, first = cam.alt == null;
  cam.alt = first ? wantAlt : Math.max(cam.alt + (wantAlt - cam.alt) * 0.08, ground + 150);
  const T = cam.look ? cam.look.slice(0, 2) : offset(H, b, 1.2);
  cam.T = first || !cam.T ? T : [cam.T[0] + (T[0] - cam.T[0]) * 0.06, cam.T[1] + (T[1] - cam.T[1]) * 0.06];
  const horiz = hav(C, cam.T) * 1000, minAlt = cam.alt - horiz / Math.tan(cam.p * rad);   // 压住俯仰角不超过 cam.p
  const tAlt = cam.look ? minAlt : Math.max(g(cam.T) || eH, minAlt);
  cam.tAlt = first || cam.tAlt == null ? tAlt : cam.tAlt + (tAlt - cam.tAlt) * 0.08;
  cam.C = C;
  const o = map.calculateCameraOptionsFromTo(C, cam.alt, cam.T, cam.tAlt);
  return { center: o.center, zoom: o.zoom, elevation: o.elevation, pitch: o.pitch, bearing: o.bearing, padding: ZERO };
}
function setProg(p, follow, snap, k = 0.05, stop = null, sway = 0) {
  prog = clamp(p, 0, 1); const t = cur; if (!t) return;
  const d = prog * t.len, r = along(t, d);
  hiker.setLngLat(r.p);
  // 跟拍时相机就在走过的路上方，近处的线会被透视放得很粗：只画前方的路
  const ahead = follow && t.stops;
  map.getSource('done')?.setData(fc(prog > 0 && !ahead ? [lineF(slice(t, d))] : []));
  map.getSource('sel')?.setData(fc([lineF(ahead ? [r.p, ...t.line.slice(r.i + 1)] : t.line)]));
  chaseMode(ahead);
  $('#scrub').value = Math.round(prog * 1000);
  updStop(d, !!stop);
  drawProf();
  if (follow) {
    const w = camFor(t, d, stop);
    if (snap) { Object.assign(cam, w); cam.alt = null; cam.T = null; }
    else {
      cam.b = lerpAng(cam.b, w.b, k); cam.p += (w.p - cam.p) * k; cam.look = w.look;
      if (t.stops) { cam.back += (w.back - cam.back) * k; cam.clear += (w.clear - cam.clear) * k; } else cam.z += (w.z - cam.z) * k;
    }
    map.jumpTo(t.stops ? chase(t, d, sway) : { center: r.p, zoom: cam.z, pitch: cam.p, bearing: cam.b + sway, padding: pad() });
    if (t.stops) markVis();
  }
}
const play = { on: false, raf: 0, last: 0, dur: 20, si: 0, hold: null };
const HOLD = reduce ? 2.5 : 5.5;
function startPlay() {
  const t = cur; if (!t) return;
  if (prog >= 0.999) prog = 0;
  play.on = true; setPlayBtn(); if (mobile()) { $('#detail').classList.add('min'); requestAnimationFrame(placeCap); }
  play.dur = reduce ? 8 : t.stops ? clamp(t.len * 1.9, 30, 60) : clamp(14 + t.len * 0.11, 16, 42);
  const d0 = prog * t.len; play.hold = null;
  play.si = t.stops ? (prog === 0 ? 0 : t.stops.findIndex(s => s.dj > d0 + 0.02)) : -1;
  if (play.si < 0) play.si = t.stops ? t.stops.length : 0;
  Object.assign(cam, camFor(t, d0)); cam.alt = null; cam.T = null;
  if (t.stops) chaseMode(true);
  const tok = ++camTok;
  map.flyTo({ ...(t.stops ? chase(t, d0) : { center: cam.c, zoom: cam.z, pitch: cam.p, bearing: cam.b, padding: pad() }), duration: reduce ? 0 : 2600, essential: true });
  after(tok, () => { if (!play.on) return; play.last = performance.now(); play.raf = requestAnimationFrame(tick); });
}
function tick(now) {
  if (!play.on) return;
  const dt = Math.min(0.1, (now - play.last) / 1000); play.last = now;
  const t = cur, S = t.stops || [];
  if (play.hold) {                                   // 停在看点：镜头转过去，慢慢摆一摆
    const h = play.hold; h.t += dt;
    setProg(prog, true, false, 0.035, h.s, reduce ? 0 : Math.sin(h.t / HOLD * Math.PI) * 7);
    if (h.t >= HOLD) { play.hold = null; play.si++; if (prog >= 1) { pause(); ended(); return; } }
    play.raf = requestAnimationFrame(tick); return;
  }
  const nx = S[play.si], d = prog * t.len;
  const slow = nx ? 0.3 + 0.7 * clamp((nx.dj - d) / 0.8, 0, 1) : 1;   // 快到看点时放慢
  let p = prog + dt / play.dur * slow;
  if (nx && p * t.len >= nx.dj) { p = nx.dj / t.len; play.hold = { s: nx, t: 0 }; }
  setProg(p, true);
  if (p >= 1 && !play.hold) { pause(); ended(); return; }
  play.raf = requestAnimationFrame(tick);
}
function pause() { play.on = false; play.hold = null; cancelAnimationFrame(play.raf); setPlayBtn(); }
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

// ---------- 沿途看点：地图上的站点、远处地标、讲解卡片
const KC = { start: '#ffffff', village: '#e9d8b0', climb: '#ff8a5b', view: tok('--blaze'), water: '#6cc8ff', peak: '#ffffff' };
const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  start: svg('<path d="M6 21V4M6 4h11l-2 4 2 4H6"/>'),
  village: svg('<path d="M4 11l8-6 8 6M6 10v9h12v-9M10 19v-5h4v5"/>'),
  climb: svg('<path d="M4 20l5-5-3-3 6-6 3 3 5-5"/>'),
  view: svg('<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>'),
  water: svg('<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>'),
  peak: svg('<path d="M3 20l7-12 3 5 2-3 6 10z"/>'),
};
let storyMk = [], stopEls = [], capS = null;
function showStory(t) {
  storyMk.forEach(m => m.remove()); storyMk = []; stopEls = []; capS = null; $('#cap').hidden = true;
  if (!t || !t.stops) return;
  for (const m of t.marks || []) {
    const el = Object.assign(document.createElement('div'), { className: 'mark mark-' + m.kind });
    el.innerHTML = `${ICON[m.kind]}<b>${m.name}</b>${m.sub ? `<small>${m.sub}</small>` : ''}`;
    storyMk.push(new maplibregl.Marker({ element: el, anchor: 'bottom', opacityWhenCovered: '0.9' }).setLngLat(m.at).addTo(map));
  }
  for (const s of t.stops) {
    const el = Object.assign(document.createElement('button'), { className: 'stop', title: s.name });
    el.style.setProperty('--k', KC[s.kind]); el.innerHTML = `${ICON[s.kind]}<span>${s.name}</span>`;
    el.onclick = e => { e.stopPropagation(); goStop(s); };
    stopEls.push(el); storyMk.push(new maplibregl.Marker({ element: el }).setLngLat(along(t, s.dj).p).addTo(map));
  }
}
// 远处地标：在相机背后的不显示（否则会投影到画面底部）
function markVis() {
  for (const m of storyMk) {
    const at = m.getLngLat().toArray(), off = Math.abs(((brg(cam.C, at) - cam.b + 540) % 360) - 180);
    m.getElement().style.visibility = off < 75 ? '' : 'hidden';
  }
}
function markShow() { for (const m of storyMk) m.getElement().style.visibility = ''; }
// 当前在哪一站附近：停留时一定显示，走过 0.6 km 后收起
function updStop(d, holding) {
  const t = cur; if (!t || !t.stops) return;
  let s = null;
  for (const x of t.stops) if (x.dj <= d + 0.05) s = x;
  if (s && !holding && d - s.dj > 0.6) s = null;
  if (s === capS) return;
  capS = s; stopEls.forEach((el, i) => el.classList.toggle('on', s && i === s.i));
  document.querySelectorAll('[data-stop]').forEach(b => b.setAttribute('aria-current', !!s && +b.dataset.stop === s.i));
  const c = $('#cap'); if (!s) { c.hidden = true; return; }
  const P = t.prof, e = P[Math.min(P.length - 1, Math.round(s.d / P[P.length - 1][0] * (P.length - 1)))][1];
  c.style.setProperty('--k', KC[s.kind]);
  c.innerHTML = `<div class="c-meta">${ICON[s.kind]}第 ${s.i + 1} / ${t.stops.length} 站<span>${fmtKm(s.d)} km · 海拔 ${e.toLocaleString()} m</span></div>
    <h3>${s.name}</h3><p>${s.text}</p>`;
  placeCap(); c.hidden = false; c.classList.remove('in'); void c.offsetWidth; c.classList.add('in');
}
function placeCap() {
  const c = $('#cap'), d = $('#detail');
  c.style.bottom = mobile() && !d.hidden ? innerHeight - d.getBoundingClientRect().top + 10 + 'px' : '';
}
function goStop(s) {
  const t = cur; if (!t) return;
  stopTour(); pause();
  Object.assign(cam, camFor(t, s.dj, s)); cam.alt = null; cam.T = null;
  setProg(s.dj / t.len, false);
  const r = along(t, s.dj);
  map.getSource('done').setData(fc([])); map.getSource('sel').setData(fc([lineF([r.p, ...t.line.slice(r.i + 1)])]));
  chaseMode(true);
  const tok = ++camTok;
  map.easeTo({ ...chase(t, s.dj), duration: reduce ? 0 : 1800, essential: true });
  after(tok, () => { cam.alt = null; cam.T = null; setProg(s.dj / t.len, true, false, 1, s); });   // easeTo 落地时会把中心海拔归零，落地后按跟拍镜头再摆一次
  markVis();
}
$('#d-stops').onclick = e => { const b = e.target.closest('[data-stop]'); if (b && cur) goStop(cur.stops[+b.dataset.stop]); };

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
  // 看点
  for (const s of t.stops || []) {
    const k = Math.min(P.length - 1, Math.round(s.d / L * (P.length - 1))), on = s === capS;
    g.beginPath(); g.arc(X(s.d), Y(P[k][1]), on ? 5 : 3.5, 0, 7); g.fillStyle = KC[s.kind]; g.fill();
    g.lineWidth = 1.5; g.strokeStyle = '#0d1513'; g.stroke();
  }
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
addEventListener('resize', () => { layout(); requestAnimationFrame(() => { drawProf(); placeCap(); }); });

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
