/* Suntime – sol på uteserveringar i Göteborg (prototyp) */
(function () {
  'use strict';

  const CITIES = {
    goteborg: { name: 'Göteborg', lat: 57.7072, lon: 11.9668, zoom: 14, bbox: [57.66, 11.87, 57.75, 12.05] },
    barcelona: { name: 'Barcelona', lat: 41.3870, lon: 2.1700, zoom: 15, bbox: [41.372, 2.150, 41.404, 2.192] },
    malaga: { name: 'Málaga', lat: 36.7213, lon: -4.4214, zoom: 15, bbox: [36.708, -4.440, 36.730, -4.405] },
  };
  const cityId = (() => {
    const q = new URLSearchParams(location.search).get('stad');
    if (q && CITIES[q]) return q;
    try { const s = localStorage.getItem('suntime-city'); if (s && CITIES[s]) return s; } catch (e) { /* */ }
    return 'goteborg';
  })();
  const CITY = CITIES[cityId];
  const BBOX = CITY.bbox; // syd, väst, nord, öst
  const DATA_KEY = 'suntime-data-v3-' + cityId;
  const DATA_TTL = 7 * 864e5;
  try { // städa bort gamla cachade versioner
    Object.keys(localStorage).filter((k) => k.startsWith('suntime-data-') && !k.startsWith('suntime-data-v3-')).forEach((k) => localStorage.removeItem(k));
  } catch (e) { /* */ }
  const WX_KEY = 'suntime-wx-v1-' + cityId;
  const WX_TTL = 30 * 60e3;
  const CLOUDY = 75; // % molntäcke där vi räknar solen som borta
  const OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];
  const KINDS = { restaurant: 'Restaurang', bar: 'Bar', pub: 'Pub', cafe: 'Café', biergarten: 'Ölträdgård' };

  const $ = (id) => document.getElementById(id);
  const favs = new Set((() => { try { return JSON.parse(localStorage.getItem('suntime-favs')) || []; } catch (e) { return []; } })());
  const loadSet = (k) => new Set((() => { try { return JSON.parse(localStorage.getItem(k)) || []; } catch (e) { return []; } })());
  const saveSet = (k, set) => { try { localStorage.setItem(k, JSON.stringify([...set])); } catch (e) { /* */ } };
  const notify = loadSet('suntime-notify');
  const hidden = loadSet('suntime-hidden');
  const notified = loadSet('suntime-notified');
  const NOTIFY_BEFORE = 30 * 60000;
  function toggleFav(id) {
    favs.has(id) ? favs.delete(id) : favs.add(id);
    try { localStorage.setItem('suntime-favs', JSON.stringify([...favs])); } catch (e) { /* */ }
    render();
  }
  const state = {
    venues: [], weather: null, live: true, dayOffset: 0, minutes: 0,
    me: null, markers: new Map(), selected: null, daySun: null, daySunKey: '',
  };

  // ---------- hjälpare ----------
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const dur = (ms) => {
    const m = Math.round(ms / 60000);
    if (m <= 0) return '0 min';
    const h = Math.floor(m / 60), r = m % 60;
    return h ? (r ? `${h} h ${r} min` : `${h} h`) : `${r} min`;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function loader(text, pct) {
    let el = $('loader');
    if (text == null) { if (el) { el.classList.add('done'); setTimeout(() => el.remove(), 400); } return; }
    if (!el) {
      el = document.createElement('div'); el.id = 'loader'; el.className = 'loader';
      el.innerHTML = '<div class="loader-card"><div class="loader-sun"></div><b></b><span></span><div class="loader-bar"><i></i></div></div>';
      $('map').appendChild(el);
    }
    el.querySelector('b').textContent = text;
    el.querySelector('span').textContent = pct == null ? 'Första gången kan det ta upp till en halv minut.' : `${pct} %`;
    el.querySelector('.loader-bar i').style.width = (pct == null ? 12 : Math.max(12, pct)) + '%';
    el.querySelector('.loader-bar').classList.toggle('indet', pct == null);
  }
  const setStatus = (t, err) => { const el = $('status'); el.textContent = t; el.classList.toggle('error', !!err); };
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* fullt eller blockerat */ } },
  };
  // IndexedDB för husen (för stora för localStorage)
  const idb = {
    open() {
      return new Promise((res, rej) => {
        const r = indexedDB.open('suntime', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
    },
    async get(k) {
      try { const db = await this.open(); return await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); }
      catch (e) { return null; }
    },
    async set(k, v) {
      try { const db = await this.open(); db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); } catch (e) { /* */ }
    },
  };
  function distM(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  function selectedTime() {
    if (state.live) return new Date();
    const d = new Date(); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + state.dayOffset);
    return new Date(d.getTime() + state.minutes * 60000);
  }

  // ---------- data från OpenStreetMap ----------
  async function overpass(query) {
    let lastErr;
    for (const url of OVERPASS) {
      try {
        const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  function buildQuery() {
    const b = BBOX.join(',');
    return `[out:json][timeout:120];
(
  nwr["amenity"~"^(restaurant|bar|pub|cafe)$"]["outdoor_seating"="yes"](${b});
  nwr["amenity"="biergarten"](${b});
)->.v;
.v out center tags;
(
  way["building"](around.v:120);
  relation["building"](around.v:120);
);
out tags geom;`;
  }

  async function loadVenues(force) {
    const cached = store.get(DATA_KEY);
    if (!force && cached && Date.now() - cached.ts < DATA_TTL && cached.venues?.length) {
      idb.get('buildings-' + cityId).then((b) => b && SunView.setBuildings(b));
      return cached.venues;
    }

    setStatus('Hämtar uteserveringar och hus från OpenStreetMap… (kan ta en halv minut första gången)');
    loader(`Läser in barer och restauranger i ${CITY.name}…`);
    const json = await overpass(buildQuery());
    const venues = [], buildings = [], seen = new Set();
    for (const el of json.elements || []) {
      const t = el.tags || {};
      const isVenue = (t.amenity === 'biergarten') || (KINDS[t.amenity] && t.outdoor_seating === 'yes');
      if (isVenue && !seen.has(el.type + el.id) && (el.lat != null || el.center)) {
        seen.add(el.type + el.id);
        const lat = el.lat ?? el.center.lat, lon = el.lon ?? el.center.lon;
        venues.push({
          id: el.type + '/' + el.id, lat, lon,
          name: t.name || KINDS[t.amenity] || 'Servering',
          kind: t.amenity,
          web: t.website || t['contact:website'] || t.url || '',
          phone: t.phone || t['contact:phone'] || '',
          hours: t.opening_hours || '',
          addr: [t['addr:street'] && `${t['addr:street']} ${t['addr:housenumber'] || ''}`.trim()].filter(Boolean).join(''),
          cuisine: t.cuisine || '',
        });
      }
      if (t.building && Array.isArray(el.geometry) && el.geometry.length > 2) {
        buildings.push({ h: Shadow.buildingHeight(t), pts: el.geometry.map((g) => [g.lat, g.lon]) });
      } else if (t.building && el.type === 'relation' && Array.isArray(el.members)) {
        // flerdelade byggnader (t.ex. kvarter med innergård): använd de yttre väggarna
        const h = Shadow.buildingHeight(t);
        for (const m of el.members) {
          if (m.type === 'way' && m.role !== 'inner' && Array.isArray(m.geometry) && m.geometry.length > 2) {
            buildings.push({ h, pts: m.geometry.map((g) => [g.lat, g.lon]) });
          }
        }
      }
    }
    if (!venues.length) throw new Error('Inga serveringar hittades');

    // rutnät för att snabbt hitta hus nära varje servering
    const CELL = 0.002, grid = new Map();
    const key = (la, lo) => Math.floor(la / CELL) + ':' + Math.floor(lo / CELL);
    for (const b of buildings) {
      const ks = new Set(b.pts.map((p) => key(p[0], p[1])));
      for (const k of ks) { if (!grid.has(k)) grid.set(k, []); grid.get(k).push(b); }
    }
    const nearby = (v) => {
      const set = new Set(), gy = Math.floor(v.lat / CELL), gx = Math.floor(v.lon / CELL);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -3; dx <= 3; dx++) {
        for (const b of grid.get((gy + dy) + ':' + (gx + dx)) || []) set.add(b);
      }
      return [...set];
    };

    for (let i = 0; i < venues.length; i++) {
      const v = venues[i];
      const r = Shadow.computeProfile(v, nearby(v));
      v.profile = r.profile; v.slat = r.lat; v.slon = r.lon; v.indoor = r.indoor;
      if (i % 15 === 0) {
        setStatus(`Räknar skuggor… ${Math.round((i / venues.length) * 100)} %`);
        loader(`Räknar ut skuggor för ${venues.length} serveringar…`, Math.round((i / venues.length) * 100));
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    store.set(DATA_KEY, { ts: Date.now(), venues });
    const slim = buildings.map((b) => ({ h: Math.round(b.h * 10) / 10, pts: b.pts.map(([a, o]) => [+a.toFixed(6), +o.toFixed(6)]) }));
    SunView.setBuildings(slim);
    idb.set('buildings-' + cityId, slim);
    return venues;
  }

  // ---------- väder ----------
  async function loadWeather() {
    const c = store.get(WX_KEY);
    if (c && Date.now() - c.ts < WX_TTL) return c.data;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${CITY.lat}&longitude=${CITY.lon}` +
      '&hourly=cloud_cover,temperature_2m,weather_code,precipitation&timezone=auto&forecast_days=2';
    const res = await fetch(url);
    if (!res.ok) throw new Error('Väder: HTTP ' + res.status);
    const j = await res.json();
    const data = {};
    j.hourly.time.forEach((t, i) => {
      data[t.slice(0, 13)] = { cloud: j.hourly.cloud_cover[i], temp: j.hourly.temperature_2m[i],
        code: j.hourly.weather_code[i], rain: j.hourly.precipitation[i] };
    });
    store.set(WX_KEY, { ts: Date.now(), data });
    return data;
  }
  function wxAt(d) {
    if (!state.weather) return null;
    const k = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`;
    return state.weather[k] || null;
  }
  function wxText(w) {
    if (!w) return '';
    const c = w.code;
    const icon = c >= 95 ? '⛈' : c >= 71 && c <= 86 ? '🌨' : c >= 51 ? '🌧' : c === 45 || c === 48 ? '🌫' :
      w.cloud >= CLOUDY ? '☁️' : w.cloud >= 35 ? '⛅' : '☀️';
    return `${icon} ${Math.round(w.temp)}° · moln ${w.cloud}%`;
  }

  // ---------- solberäkning ----------
  // Solens bana beräknas en gång per dag för stadens mitt (skillnaden inom stan är försumbar).
  function daySun(date) {
    const d0 = new Date(date); d0.setHours(0, 0, 0, 0);
    const k = d0.toDateString();
    if (state.daySunKey === k) return state.daySun;
    const arr = [];
    for (let t = d0.getTime(); t <= d0.getTime() + 864e5; t += 5 * 60000) {
      arr.push({ t, ...Shadow.sunPos(new Date(t), CITY.lat, CITY.lon) });
    }
    state.daySun = arr; state.daySunKey = k;
    for (const v of state.venues) v._iv = null;
    return arr;
  }
  function litBy(v, s) { return s.alt > 0.5 && s.alt > v.profile[Math.floor(s.az) % 360] / 10; }
  function intervals(v, date) {
    const ds = daySun(date);
    if (v._iv) return v._iv;
    const out = []; let cur = null;
    for (const s of ds) {
      const lit = litBy(v, s);
      if (lit && !cur) cur = [s.t, s.t + 300000];
      else if (lit) cur[1] = s.t + 300000;
      else if (cur) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    v._iv = out;
    return out;
  }

  function evaluate(v, now) {
    const t = now.getTime();
    const iv = intervals(v, now);
    const sun = Shadow.sunPos(now, CITY.lat, CITY.lon);
    const lit = litBy(v, sun);
    const w = wxAt(now);
    const cloudy = w && w.cloud >= CLOUDY;
    let left = 0;
    for (const [a, b] of iv) if (b > t) left += b - Math.max(a, t);
    const curIv = iv.find(([a, b]) => a <= t && b > t);
    const next = iv.find(([a]) => a > t);
    const total = iv.reduce((s, [a, b]) => s + (b - a), 0);
    let status = sun.alt <= 0 ? 'night' : lit ? (cloudy ? 'cloudy' : 'sun') : 'shade';
    let line;
    if (status === 'night') line = next ? `Solen kommer ${hhmm(new Date(next[0]))}` : 'Solen har gått ner';
    else if (lit) line = `Sol till ${hhmm(new Date(curIv ? curIv[1] : t))}` + (cloudy ? ' (molnigt)' : '');
    else line = next ? `Skugga – sol igen ${hhmm(new Date(next[0]))}` : 'Skugga – ingen mer sol idag';
    return { status, lit, left, line, iv, total, next, curIv, w };
  }

  // ---------- karta ----------
  let map;
  function initMap() {
    map = L.map('map', { zoomControl: false, attributionControl: true }).setView([CITY.lat, CITY.lon], CITY.zoom);
    L.control.zoom({ position: 'topright' }).addTo(map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    SunView.init(map, {
      enabled: store.get('suntime-sunview') !== false,
      onToggle: (on) => { store.set('suntime-sunview', on); render(); },
    });
  }
  function pinIcon(cat, cloudy) {
    return L.divIcon({ className: '', html: `<div class="pin ${cat}${cloudy ? ' cloudy' : ''}"></div>`, iconSize: [20, 20], iconAnchor: [10, 10] });
  }
  // Lägen för vad som visas: alla / sol någon gång idag / sol just nu
  const MODES = [['all', 'Alla'], ['today', 'Sol idag'], ['now', 'Sol nu']];
  function initModeControl() {
    const Ctl = L.Control.extend({
      options: { position: 'bottomleft' },
      onAdd() {
        const d = L.DomUtil.create('div', 'mode-ctl');
        L.DomEvent.disableClickPropagation(d);
        d.innerHTML = `<div class="seg">${MODES.map(([k, t]) => `<button type="button" data-mode="${k}">${t}</button>`).join('')}</div>
          <div class="legend"><span><i class="pin now"></i>Sol nu</span><span><i class="pin later"></i>Sol senare</span><span><i class="pin none"></i>Ingen mer sol</span></div>`;
        d.addEventListener('click', (ev) => {
          const b = ev.target.closest('[data-mode]'); if (!b) return;
          state.mode = b.dataset.mode; store.set('suntime-mode', state.mode); render();
        });
        return d;
      },
    });
    new Ctl().addTo(map);
  }
  const catOf = (e) => (e.lit ? 'now' : e.next ? 'later' : 'none');

  // ---------- rendering ----------
  const ICON = { sun: '☀︎', cloudy: '☁︎', shade: '◐', night: '☾' };
  function render() {
    const now = selectedTime();
    if (state.live) {
      $('day').value = '0';
      $('time').value = now.getHours() * 60 + now.getMinutes() - ((now.getMinutes()) % 5);
    }
    $('timeLabel').textContent = hhmm(now);
    $('nowBtn').classList.toggle('active', state.live);
    $('weather').textContent = wxText(wxAt(now)) || (state.weather ? '' : 'Väder laddas…');
    const w0 = wxAt(now);
    SunView.update(now, w0 ? w0.cloud : 0);

    const q = $('search').value.trim().toLowerCase();
    const mode = state.mode;
    document.querySelectorAll('.mode-ctl [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    const onlyFav = $('onlyFav').checked;
    const kind = $('kind').value;
    const onlyOpen = $('onlyOpen').checked;
    const sort = $('sort').value;
    const rows = [];
    let sunCount = 0;
    for (const v of state.venues) {
      const e = evaluate(v, now);
      v._e = e;
      if (e.status === 'sun') sunCount++;
      const m = state.markers.get(v.id);
      const cat = catOf(e), key = cat + (e.status === 'cloudy' ? 'c' : '');
      v._cat = cat;
      if (m && m._status !== key) { m.setIcon(pinIcon(cat, e.status === 'cloudy')); m._status = key; }
      if (m) m._show = false;
      if (q && !(v.name.toLowerCase().includes(q) || (v.addr || '').toLowerCase().includes(q))) continue;
      if (mode === 'now' && cat !== 'now') continue;
      if (mode === 'today' && cat === 'none') continue;
      if (onlyFav && !favs.has(v.id)) continue;
      if (hidden.has(v.id)) continue;
      if (kind && !(kind === 'bar' ? (v.kind === 'bar' || v.kind === 'pub' || v.kind === 'biergarten') : v.kind === kind)) continue;
      if (onlyOpen && Hours.isOpen(v.hours, now) === false) continue;
      rows.push(v);
      if (m) m._show = true;
    }
    for (const m of state.markers.values()) {
      const on = map.hasLayer(m);
      if (m._show && !on) m.addTo(map); else if (!m._show && on) m.remove();
    }
    const rank = { sun: 0, cloudy: 1, shade: 2, night: 3 };
    if (sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name, 'sv'));
    else if (sort === 'near' && state.me) rows.sort((a, b) => distM(state.me, a) - distM(state.me, b));
    else rows.sort((a, b) => (rank[a._e.status] - rank[b._e.status]) || (b._e.left - a._e.left) || a.name.localeCompare(b.name, 'sv'));

    const html = rows.slice(0, 300).map((v) => {
      const e = v._e;
      const dist = state.me ? ` · ${distM(state.me, v) < 1000 ? Math.round(distM(state.me, v) / 10) * 10 + ' m' : (distM(state.me, v) / 1000).toFixed(1) + ' km'}` : '';
      return `<li class="item" data-id="${esc(v.id)}">
        <div class="dot ${v._cat}${e.status === 'cloudy' ? ' cloudy' : ''}">${ICON[e.status]}</div>
        <div class="main"><div class="name">${esc(v.name)}</div>
          <div class="sub">${esc(e.line)}${dist}${openTag(v, now)}</div></div>
        <button class="star${favs.has(v.id) ? ' on' : ''}" data-fav="${esc(v.id)}" type="button" aria-label="Favorit">${favs.has(v.id) ? '★' : '☆'}</button>
        <div class="left"><b>${e.left ? dur(e.left) : '–'}</b>sol kvar</div>
      </li>`;
    }).join('');
    $('list').innerHTML = html || (onlyFav && !favs.size
      ? '<li class="status">Du har inga favoriter än. Tryck på ☆ vid en servering för att spara den.</li>'
      : '<li class="status">Inga serveringar matchar.</li>');
    renderBest(now);
    if (state.live) checkNotifications(now);
    const sunAlt = Shadow.sunPos(now, CITY.lat, CITY.lon).alt;
    setStatus(sunAlt <= 0
      ? `Solen är nere kl ${hhmm(now)}. Dra i tidsreglaget eller välj imorgon för att se när det blir sol.`
      : `${sunCount} av ${state.venues.length} serveringar har sol kl ${hhmm(now)}${state.live ? ' (nu)' : ''}.`);
    if (state.selected && !document.querySelector('#repBox .report')) openSheet(state.selected, true);
  }

  function openTag(v, now) {
    const o = Hours.isOpen(v.hours, now);
    return o === true ? ' · <span class="is-open">Öppet</span>' : o === false ? ' · <span class="is-closed">Stängt</span>' : '';
  }

  // Sol-minuter i ett intervall där vädret också är okej (molntäcke under gränsen)
  function clearMinutes(a, b) {
    let ms = 0;
    for (let t = a; t < b; t += 300000) { const w = wxAt(new Date(t)); if (!w || w.cloud < CLOUDY) ms += 300000; }
    return ms;
  }
  // Bästa sammanhängande solfönster från "now" och framåt samma dag
  function bestWindow(v, now) {
    const t = now.getTime();
    let best = null;
    for (const [a0, b] of v._e.iv) {
      if (b <= t) continue;
      const a = Math.max(a0, t);
      const clear = clearMinutes(a, b);
      if (!best || clear > best.clear || (clear === best.clear && b - a > best.len)) best = { v, a, b, len: b - a, clear };
    }
    return best;
  }
  function renderBest(now) {
    const box = $('best');
    const pool = state.venues.filter((v) => !hidden.has(v.id) && (favs.size ? favs.has(v.id) : true));
    let best = null;
    for (const v of pool) { const w = bestWindow(v, now); if (w && (!best || w.clear > best.clear || (w.clear === best.clear && w.len > best.len))) best = w; }
    if (!best) {
      box.innerHTML = favs.size ? '☾ Ingen av dina favoriter får mer sol idag.' : '';
      box.hidden = !favs.size;
      return;
    }
    const cloudy = best.clear < best.len * 0.5;
    box.hidden = false;
    box.innerHTML = `<span class="best-icon">${cloudy ? '⛅' : '☀︎'}</span>
      <span><small>${favs.size ? 'Bästa sol bland dina favoriter' : 'Bästa sol i stan'}${state.dayOffset ? ' den dagen' : ' idag'}</small>
      <b>${esc(best.v.name)}</b> ${hhmm(new Date(best.a))}–${hhmm(new Date(best.b))} (${dur(best.len)}${cloudy ? ', men molnigt' : ''})</span>`;
    box.onclick = () => { setMenu(false); openSheet(best.v); };
  }

  // ---------- notiser ----------
  async function showNote(title, body) {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) return reg.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: title });
      new Notification(title, { body, icon: 'icons/icon-192.png' });
    } catch (e) { /* */ }
  }
  function checkNotifications(now) {
    if (!notify.size || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const t = now.getTime();
    for (const v of state.venues) {
      if (!notify.has(v.id) || !v._e) continue;
      const nx = v._e.iv.find(([a]) => a > t && a - t <= NOTIFY_BEFORE);
      if (!nx) continue;
      const key = v.id + '@' + nx[0];
      if (notified.has(key)) continue;
      notified.add(key);
      saveSet('suntime-notified', new Set([...notified].slice(-200)));
      const w = wxAt(new Date(nx[0]));
      showNote(`☀︎ Sol snart på ${v.name}`,
        `Solen kommer ${hhmm(new Date(nx[0]))} och stannar till ${hhmm(new Date(nx[1]))}.` + (w && w.cloud >= CLOUDY ? ' Men det ser molnigt ut.' : ''));
    }
  }
  async function toggleNotify(v) {
    if (notify.has(v.id)) { notify.delete(v.id); saveSet('suntime-notify', notify); openSheet(v, true); return; }
    if (typeof Notification === 'undefined') {
      alert('Den här webbläsaren stödjer inte notiser. På iPhone måste appen först läggas till på hemskärmen.');
      return;
    }
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm !== 'granted') { alert('Notiser är avstängda för Suntime i telefonens inställningar.'); return; }
    notify.add(v.id); saveSet('suntime-notify', notify);
    if (!favs.has(v.id)) { favs.add(v.id); try { localStorage.setItem('suntime-favs', JSON.stringify([...favs])); } catch (e) { /* */ } }
    openSheet(v, true);
    render();
  }

  // ---------- rapportera till OpenStreetMap ----------
  async function sendOsmNote(lat, lon, text) {
    const url = `https://api.openstreetmap.org/api/0.6/notes.json?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&text=${encodeURIComponent(text)}`;
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    return j?.properties?.id;
  }
  function reportForm(target, { lat, lon, title, preset, osmId }) {
    target.innerHTML = `
      <div class="report">
        <b>${esc(title)}</b>
        <div class="report-opts">
          ${preset.map((p, i) => `<label><input type="radio" name="rep" value="${i}" ${i === 0 ? 'checked' : ''}> ${esc(p)}</label>`).join('')}
        </div>
        <textarea id="repText" rows="2" maxlength="500" placeholder="Beskriv gärna (frivilligt), t.ex. namnet eller var bordet står"></textarea>
        <div class="actions">
          <button class="btn" id="repSend" type="button">Skicka</button>
          <button class="btn secondary" id="repCancel" type="button">Avbryt</button>
        </div>
        <div class="note">Rapporten skickas som en öppen anteckning på OpenStreetMap, där frivilliga rättar kartan. Den syns publikt men innehåller inget om dig.</div>
      </div>`;
    target.querySelector('#repCancel').onclick = () => { target.innerHTML = ''; };
    target.querySelector('#repSend').onclick = async (ev) => {
      const btn = ev.currentTarget;
      const choice = preset[+target.querySelector('input[name=rep]:checked').value];
      const extra = target.querySelector('#repText').value.trim();
      const text = `${choice}${osmId ? ` (https://www.openstreetmap.org/${osmId})` : ''}${extra ? '\n' + extra : ''}\n\nRapporterat via Suntime (uteservering / outdoor_seating)`;
      btn.disabled = true; btn.textContent = 'Skickar…';
      try {
        const id = await sendOsmNote(lat, lon, text);
        target.innerHTML = `<div class="report ok">Tack! Rapporten är skickad${id ? ` (<a href="https://www.openstreetmap.org/note/${id}" target="_blank" rel="noopener">se anteckningen</a>)` : ''}. Ändringen syns i appen när någon rättat kartan.</div>`;
      } catch (e) {
        target.innerHTML = `<div class="report">Det gick inte att skicka just nu. Du kan rapportera direkt på <a href="https://www.openstreetmap.org/note/new#map=19/${lat}/${lon}" target="_blank" rel="noopener">OpenStreetMap</a>.</div>`;
      }
    };
  }
  function startAddMode() {
    setMenu(false);
    state.addMode = true;
    $('sheet').hidden = true;
    map.getContainer().classList.add('adding');
    setStatus('Tryck på kartan där den saknade uteserveringen ligger.');
  }
  function openAddSheet(latlng) {
    state.addMode = false; state.selected = null;
    map.getContainer().classList.remove('adding');
    const s = $('sheet');
    s.innerHTML = `<button class="close" id="sheetClose" aria-label="Stäng">✕</button><h2>Saknad uteservering</h2><div id="repBox"></div>`;
    s.hidden = false;
    $('sheetClose').onclick = () => { s.hidden = true; };
    reportForm($('repBox'), { lat: latlng.lat, lon: latlng.lng, title: 'Vad saknas här?',
      preset: ['Här finns en uteservering som saknas på kartan', 'Här finns ett ställe, men uteserveringen är inte markerad'] });
    render();
  }

  // Väder per timme resten av dagen, med markering för timmar då stället har sol
  function hourly(v, now) {
    const d0 = new Date(now); d0.setMinutes(0, 0, 0);
    const end = new Date(now); end.setHours(23, 59, 0, 0);
    const cells = [];
    for (let t = d0.getTime(); t <= end.getTime(); t += 3600000) {
      const w = wxAt(new Date(t));
      let lit = 0;
      for (const [a, b] of v._e.iv) lit += Math.max(0, Math.min(b, t + 3600000) - Math.max(a, t));
      const sunny = lit >= 15 * 60000;
      const ico = w ? wxText(w).split(' ')[0] : '·';
      cells.push(`<div class="hr${sunny ? ' lit' : ''}${sunny && w && w.cloud >= CLOUDY ? ' clouded' : ''}">
        <span>${pad(new Date(t).getHours())}</span><i>${ico}</i><b>${w ? Math.round(w.temp) + '°' : '–'}</b>
        <small>${w ? w.cloud + '%' : ''}</small><em>${sunny ? '☀︎ ' + Math.round(lit / 60000) + 'm' : ''}</em></div>`);
    }
    return `<div class="hours-title">Timme för timme <small>(☀︎ = solen når serveringen, % = moln)</small></div><div class="hourly">${cells.join('')}</div>`;
  }

  function openSheet(v, refresh) {
    state.selected = v;
    const now = selectedTime();
    const e = evaluate(v, now);
    const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
    const pct = (t) => ((t - d0.getTime()) / 864e5) * 100;
    const segs = e.iv.map(([a, b]) => `<div class="seg" style="left:${pct(a)}%;width:${pct(b) - pct(a)}%"></div>`).join('');
    const big = { sun: 'Sol just nu', cloudy: 'Sol i läge – men molnigt', shade: 'I skugga', night: 'Solen är nere' }[e.status];
    const ivText = e.iv.length ? e.iv.map(([a, b]) => `${hhmm(new Date(a))}–${hhmm(new Date(b))}`).join(', ') : 'Ingen direkt sol';
    const web = v.web && (/^https?:\/\//.test(v.web) ? v.web : 'https://' + v.web);
    const s = $('sheet');
    s.innerHTML = `
      <button class="close" id="sheetClose" aria-label="Stäng">✕</button>
      <h2>${esc(v.name)} <button class="star big-star${favs.has(v.id) ? ' on' : ''}" id="sheetFav" type="button" aria-label="Favorit">${favs.has(v.id) ? '★' : '☆'}</button></h2>
      <div class="kind">${esc(KINDS[v.kind] || '')}${v.cuisine ? ' · ' + esc(v.cuisine.replace(/;/g, ', ')) : ''}${v.addr ? ' · ' + esc(v.addr) : ''}</div>
      <div class="big"><div class="dot ${catOf(e)}${e.status === 'cloudy' ? ' cloudy' : ''}">${ICON[e.status]}</div>
        <div><b>${big}</b><br><span>${esc(e.line)}</span></div></div>
      <div class="facts">
        <div class="fact"><span>Sol kvar ${state.dayOffset ? 'den dagen' : 'idag'}</span><b>${e.left ? dur(e.left) : '–'}</b></div>
        <div class="fact"><span>Sol totalt under dagen</span><b>${e.total ? dur(e.total) : '–'}</b></div>
        <div class="fact"><span>Soltider</span><b style="font-size:14px">${ivText}</b></div>
        <div class="fact"><span>Väder kl ${pad(now.getHours())}</span><b style="font-size:14px">${e.w ? esc(wxText(e.w)) : '–'}</b></div>
      </div>
      <div class="timeline">${segs}<div class="now" style="left:${pct(now.getTime())}%"></div></div>
      <div class="ticks"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
      ${state.weather ? hourly(v, now) : ''}
      ${v.hours ? `<div class="note"><b>Öppettider:</b> ${esc(v.hours)}${openTag(v, now)}</div>` : ''}
      <div class="actions">
        ${web ? `<a class="btn" href="${esc(web)}" target="_blank" rel="noopener">Hemsida / boka bord</a>` : ''}
        ${v.phone ? `<a class="btn secondary" href="tel:${esc(v.phone.replace(/\s/g, ''))}">Ring</a>` : ''}
        <a class="btn secondary" href="https://www.google.com/maps/dir/?api=1&destination=${v.lat},${v.lon}" target="_blank" rel="noopener">Vägbeskrivning</a>
        <button class="btn secondary${notify.has(v.id) ? ' active' : ''}" id="sheetNotify" type="button">${notify.has(v.id) ? '🔔 Påminnelse på' : '🔔 Påminn när solen kommer'}</button>
      </div>
      <div class="note">Skuggan räknas fram från omgivande hus i OpenStreetMap (höjder uppskattas när de saknas) och kan avvika från verkligheten.
      ${v.indoor ? 'Platsen låg inne i en byggnad på kartan, så vi antar att serveringen står vid närmaste fasad.' : ''}
      ${web ? '' : 'Ingen hemsida finns registrerad.'}</div>
      <div class="actions small"><button class="link" id="sheetReport" type="button">Stämmer inte? Rapportera</button>
        <button class="link" id="sheetHide" type="button">Dölj för mig</button></div>
      <div id="repBox"></div>`;
    s.hidden = false;
    $('sheetFav').onclick = () => toggleFav(v.id);
    $('sheetNotify').onclick = () => toggleNotify(v);
    $('sheetReport').onclick = () => reportForm($('repBox'), { lat: v.lat, lon: v.lon, osmId: v.id, title: 'Vad är fel?',
      preset: ['Uteserveringen finns inte (längre)', 'Stället har stängt för gott', 'Uteserveringen ligger på fel plats', 'Annat fel'] });
    $('sheetHide').onclick = () => { hidden.add(v.id); saveSet('suntime-hidden', hidden); s.hidden = true; state.selected = null; render(); };
    $('sheetClose').onclick = () => { s.hidden = true; state.selected = null; };
    if (!refresh) map.panTo([v.lat, v.lon]);
  }

  function addMarkers() {
    for (const m of state.markers.values()) m.remove();
    state.markers.clear();
    for (const v of state.venues) {
      const m = L.marker([v.lat, v.lon], { icon: pinIcon('none'), title: v.name }).addTo(map);
      m._status = 'none';
      m.on('click', () => openSheet(v));
      state.markers.set(v.id, m);
    }
  }

  // ---------- sidomeny ----------
  function setMenu(open) {
    $('panel').classList.toggle('open', open);
    $('backdrop').hidden = !open;
    $('menuBtn').setAttribute('aria-expanded', String(open));
    if (open) $('sheet').hidden = true, state.selected = null;
  }

  // ---------- händelser ----------
  function bind() {
    $('menuBtn').addEventListener('click', () => setMenu(!$('panel').classList.contains('open')));
    $('menuClose').addEventListener('click', () => setMenu(false));
    $('backdrop').addEventListener('click', () => setMenu(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
    $('time').addEventListener('input', () => { state.live = false; state.minutes = +$('time').value; render(); });
    $('day').addEventListener('change', () => { state.live = false; state.dayOffset = +$('day').value; state.minutes = +$('time').value; render(); });
    $('nowBtn').addEventListener('click', () => { state.live = true; state.dayOffset = 0; render(); });
    $('search').addEventListener('input', render);

    $('onlyFav').addEventListener('change', render);
    $('kind').addEventListener('change', render);
    $('onlyOpen').addEventListener('change', render);
    $('addMissing').addEventListener('click', startAddMode);
    $('showHidden').addEventListener('click', () => { hidden.clear(); saveSet('suntime-hidden', hidden); render(); });
    map.on('click', (e) => { if (state.addMode) openAddSheet(e.latlng); });
    $('sort').addEventListener('change', () => {
      if ($('sort').value === 'near' && !state.me && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition((p) => {
          state.me = { lat: p.coords.latitude, lon: p.coords.longitude };
          L.circleMarker([state.me.lat, state.me.lon], { radius: 7, color: '#2b7cff', fillOpacity: 0.9 }).addTo(map);
          render();
        }, () => setStatus('Kunde inte hämta din position.', true), { enableHighAccuracy: true, timeout: 10000 });
      }
      render();
    });
    $('list').addEventListener('click', (ev) => {
      const st = ev.target.closest('[data-fav]');
      if (st) { ev.stopPropagation(); toggleFav(st.dataset.fav); return; }
      const li = ev.target.closest('.item'); if (!li) return;
      const v = state.venues.find((x) => x.id === li.dataset.id); if (v) { setMenu(false); openSheet(v); }
    });
    $('refresh').addEventListener('click', () => start(true));
    setInterval(() => { if (state.live) render(); }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && state.live) render(); });
  }

  // ---------- installera som app ----------
  function initInstall() {
    let deferred;
    const box = $('install');
    const dismissed = store.get('suntime-install-dismissed');
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); deferred = e;
      if (!dismissed) box.hidden = false;
    });
    $('installBtn').onclick = async () => {
      if (deferred) { deferred.prompt(); await deferred.userChoice; deferred = null; }
      box.hidden = true;
    };
    $('installClose').onclick = () => { box.hidden = true; store.set('suntime-install-dismissed', true); };
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (ios && !standalone && !dismissed) {
      box.querySelector('span').textContent = 'Installera: tryck på Dela ⬆︎ och välj ”Lägg till på hemskärmen”.';
      $('installBtn').hidden = true;
      box.hidden = false;
    }
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  async function start(force) {
    try {
      state.venues = await loadVenues(force);
      state.daySunKey = '';
      addMarkers();
      render();
      loader(null);
    } catch (e) {
      console.error(e);
      loader(null);
      setStatus('Kunde inte hämta serveringar (' + e.message + '). Kontrollera nätet och tryck ”Hämta om data”.', true);
    }
  }

  const citySel = $('city');
  citySel.innerHTML = Object.entries(CITIES).map(([k, c]) => `<option value="${k}">${c.name}</option>`).join('');
  citySel.value = cityId;
  citySel.addEventListener('change', () => {
    try { localStorage.setItem('suntime-city', citySel.value); } catch (e) { /* */ }
    location.search = '?stad=' + citySel.value;
  });
  document.title = 'Suntime – sol på uteserveringar i ' + CITY.name;
  state.mode = ['all', 'today', 'now'].includes(store.get('suntime-mode')) ? store.get('suntime-mode') : 'all';
  initMap();
  initModeControl();
  bind();
  initInstall();
  const now = new Date();
  $('time').value = now.getHours() * 60 + now.getMinutes();
  loadWeather().then((w) => { state.weather = w; if (state.venues.length) render(); else $('weather').textContent = wxText(wxAt(new Date())); })
    .catch(() => { $('weather').textContent = 'Väder saknas'; });
  start(false);
})();
