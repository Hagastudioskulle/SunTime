// Suntime – "Solvy": solkompass med solens bana + husens skuggor på kartan.
(function (root) {
  'use strict';
  const DEG = Math.PI / 180;
  const NS = 'http://www.w3.org/2000/svg';
  let map, wrap, svg, shadowLayer, renderer, enabled = true, buildings = [], last = null;

  function el(name, attrs, parent) {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function init(m, opts) {
    map = m;
    enabled = opts.enabled !== false;
    renderer = L.canvas({ padding: 0.3 });
    shadowLayer = L.layerGroup().addTo(map);

    wrap = document.createElement('div');
    wrap.className = 'sunview';
    map.getContainer().appendChild(wrap);
    svg = el('svg', { class: 'sv-svg' }, wrap);

    const Btn = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const b = L.DomUtil.create('button', 'sv-toggle');
        b.type = 'button';
        b.title = 'Visa solen och skuggor på kartan';
        L.DomEvent.disableClickPropagation(b);
        b.onclick = () => { setEnabled(!enabled); opts.onToggle && opts.onToggle(enabled); };
        this._b = b;
        return b;
      },
    });
    const btn = new Btn().addTo(map);
    root._svBtn = btn;
    map.on('moveend zoomend resize', () => last && update(last.now, last.cloud));
    setEnabled(enabled);
  }

  function setEnabled(on) {
    enabled = on;
    const b = root._svBtn && root._svBtn._b;
    if (b) { b.innerHTML = on ? '☀︎ Solvy på' : '☀︎ Solvy av'; b.classList.toggle('on', on); }
    wrap.hidden = !on;
    map.getContainer().classList.toggle('sv-on', on);
    if (!on) { shadowLayer.clearLayers(); map.getContainer().classList.remove('sv-night', 'sv-golden', 'sv-twilight'); }
    else if (last) update(last.now, last.cloud);
  }

  function setBuildings(list) {
    buildings = (list || []).map((b) => {
      let s = 90, w = 180, n = -90, e = -180;
      for (const [la, lo] of b.pts) { if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; }
      return { h: b.h, pts: b.pts, s, w, n, e };
    });
    if (last) update(last.now, last.cloud);
  }

  // konvext hölje (monotone chain)
  function hull(points) {
    const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    up.pop(); lo.pop();
    return lo.concat(up);
  }

  function drawShadows(sun, cloud) {
    shadowLayer.clearLayers();
    if (sun.alt <= 0.5 || map.getZoom() < 14 || !buildings.length) return;
    const b = map.getBounds().pad(0.4);
    const S = b.getSouth(), N = b.getNorth(), W = b.getWest(), E = b.getEast();
    const t = Math.tan(Math.max(sun.alt, 2) * DEG);
    const dirX = -Math.sin(sun.az * DEG), dirY = -Math.cos(sun.az * DEG); // bort från solen
    const opacity = 0.32 * (1 - Math.min(cloud || 0, 100) / 100 * 0.75);
    let count = 0;
    for (const bd of buildings) {
      if (bd.n < S || bd.s > N || bd.e < W || bd.w > E) continue;
      const L0 = Math.min(bd.h / t, 400);
      const kx = 111320 * Math.cos(bd.s * DEG), ky = 111320;
      const dLat = (dirY * L0) / ky, dLon = (dirX * L0) / kx;
      const pts = [];
      for (const [la, lo] of bd.pts) { pts.push([la, lo]); pts.push([la + dLat, lo + dLon]); }
      L.polygon(hull(pts), { renderer, stroke: false, fillColor: '#1d2b4f', fillOpacity: opacity, interactive: false }).addTo(shadowLayer);
      if (++count > 2500) break;
    }
  }

  function drawCompass(now, sun) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const W = wrap.clientWidth, H = wrap.clientHeight;
    if (!W || !H) return;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.42;
    const pos = (az, alt) => {
      const r = R * (1 - Math.max(alt, 0) / 90);
      return [cx + Math.sin(az * DEG) * r, cy - Math.cos(az * DEG) * r];
    };
    const defs = el('defs', {}, svg);
    const g = el('radialGradient', { id: 'svGlow' }, defs);
    el('stop', { offset: '0%', 'stop-color': '#fff6c8', 'stop-opacity': '1' }, g);
    el('stop', { offset: '35%', 'stop-color': '#ffc93c', 'stop-opacity': '.95' }, g);
    el('stop', { offset: '100%', 'stop-color': '#ff9f1c', 'stop-opacity': '0' }, g);
    const beam = el('linearGradient', { id: 'svBeam', gradientUnits: 'userSpaceOnUse' }, defs);
    el('stop', { offset: '0%', 'stop-color': '#ffcf4a', 'stop-opacity': '.55' }, beam);
    el('stop', { offset: '100%', 'stop-color': '#ffcf4a', 'stop-opacity': '0' }, beam);

    el('circle', { cx, cy, r: R, class: 'sv-ring' }, svg);
    el('circle', { cx, cy, r: R * (1 - 30 / 90), class: 'sv-ring sv-ring-in' }, svg);
    [['N', 0], ['O', 90], ['S', 180], ['V', 270]].forEach(([t, a]) => {
      const [x, y] = [cx + Math.sin(a * DEG) * (R + 12), cy - Math.cos(a * DEG) * (R + 12)];
      const tx = el('text', { x, y, class: 'sv-label', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, svg);
      tx.textContent = t;
    });

    // dagens solbana
    const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
    let path = '', rise = null, set = null, prevUp = false;
    for (let m = 0; m <= 1440; m += 10) {
      const t = new Date(d0.getTime() + m * 60000);
      const s = Shadow.sunPos(t, map.getCenter().lat, map.getCenter().lng);
      const up = s.alt > 0;
      if (up) {
        const [x, y] = pos(s.az, s.alt);
        path += (prevUp ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
        if (!prevUp) rise = { t, x, y };
        set = { t, x, y };
      }
      prevUp = up;
    }
    if (path) {
      el('path', { d: path, class: 'sv-path' }, svg);
      const hh = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      for (const [p, lbl] of [[rise, '↑ '], [set, '↓ ']]) {
        if (!p) continue;
        el('circle', { cx: p.x, cy: p.y, r: 3, class: 'sv-dot' }, svg);
        const tx = el('text', { x: p.x, y: p.y + 14, class: 'sv-time', 'text-anchor': 'middle' }, svg);
        tx.textContent = lbl + hh(p.t);
      }
    }

    if (sun.alt > 0) {
      const [sx, sy] = pos(sun.az, sun.alt);
      beam.setAttribute('x1', sx); beam.setAttribute('y1', sy); beam.setAttribute('x2', cx); beam.setAttribute('y2', cy);
      // ljuskägla från solen in mot mitten
      const ang = Math.atan2(cy - sy, cx - sx), spread = 0.16, len = Math.hypot(cx - sx, cy - sy) + 30;
      const p1 = [sx + Math.cos(ang - spread) * len, sy + Math.sin(ang - spread) * len];
      const p2 = [sx + Math.cos(ang + spread) * len, sy + Math.sin(ang + spread) * len];
      el('path', { d: `M${sx} ${sy}L${p1[0]} ${p1[1]}L${p2[0]} ${p2[1]}Z`, fill: 'url(#svBeam)', class: 'sv-beam' }, svg);
      el('circle', { cx: sx, cy: sy, r: 34, fill: 'url(#svGlow)', class: 'sv-glow' }, svg);
      el('circle', { cx: sx, cy: sy, r: 11, class: 'sv-sun' }, svg);
      const tx = el('text', { x: sx, y: sy - 20, class: 'sv-alt', 'text-anchor': 'middle' }, svg);
      tx.textContent = `${Math.round(sun.alt)}°`;
    } else {
      const tx = el('text', { x: cx, y: cy - R + 24, class: 'sv-alt', 'text-anchor': 'middle' }, svg);
      tx.textContent = '☾ Solen är nere';
    }
  }

  function update(now, cloud) {
    last = { now, cloud };
    if (!map || !enabled) return;
    const c = map.getCenter();
    const sun = Shadow.sunPos(now, c.lat, c.lng);
    const ct = map.getContainer().classList;
    ct.toggle('sv-night', sun.alt <= -4);
    ct.toggle('sv-twilight', sun.alt > -4 && sun.alt <= 2);
    ct.toggle('sv-golden', sun.alt > 2 && sun.alt < 12);
    drawCompass(now, sun);
    drawShadows(sun, cloud);
  }

  root.SunView = { init, update, setBuildings, setEnabled };
})(window);
