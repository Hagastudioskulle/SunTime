// Suntime – skuggberäkning.
// Varje servering får en "horisontprofil": för varje kompassriktning (1°) den
// högsta vinkel som omgivande byggnader skymmer. Solen lyser på serveringen när
// solens höjd är större än profilen i solens riktning.
(function (root) {
  'use strict';

  const EYE = 1.2;          // höjd (m) där man sitter
  const RANGE = 150;        // hur långt bort byggnader räknas (m)
  const BINS = 360;
  const DEG = Math.PI / 180;

  function parseHeight(v) {
    if (!v) return null;
    const m = String(v).replace(',', '.').match(/[\d.]+/);
    if (!m) return null;
    let h = parseFloat(m[0]);
    if (/ft|'/.test(v)) h *= 0.3048;
    return isFinite(h) && h > 0 ? h : null;
  }

  // Uppskatta byggnadshöjd från OSM-taggar.
  function buildingHeight(tags) {
    tags = tags || {};
    const h = parseHeight(tags.height) || parseHeight(tags['building:height']);
    if (h) return h;
    const lv = parseFloat(tags['building:levels']);
    const roof = parseFloat(tags['roof:levels']) || 0;
    if (isFinite(lv) && lv > 0) return lv * 3.2 + roof * 2.5 + 1;
    switch (tags.building) {
      case 'house': case 'detached': case 'semidetached_house': case 'terrace': return 7;
      case 'garage': case 'garages': case 'shed': case 'carport': case 'kiosk':
      case 'hut': case 'roof': case 'service': case 'toilets': return 3;
      case 'church': case 'cathedral': return 22;
      case 'industrial': case 'warehouse': case 'retail': return 8;
      case 'commercial': case 'office': return 18;
      default: return 14; // typiskt 4–5 vånings stenstadshus i Göteborg
    }
  }

  // Lokala meter-koordinater runt en referenspunkt (x = öster, y = norr).
  function projector(lat0, lon0) {
    const ky = 111320, kx = 111320 * Math.cos(lat0 * DEG);
    return (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky];
  }

  function pointInPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function nearestOnPoly(x, y, pts) {
    let best = null, bd = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
      let t = ((x - ax) * dx + (y - ay) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(px - x, py - y);
      if (d < bd) { bd = d; best = [px, py]; }
    }
    return best;
  }

  // venue: {lat, lon}; buildings: [{h, pts:[[lat,lon],...]}]
  // Returnerar {profile: Int16Array (tiondels grader), lat, lon, indoor:boolean}
  function computeProfile(venue, buildings) {
    const proj = projector(venue.lat, venue.lon);
    const local = [];
    for (const b of buildings) {
      const pts = b.pts.map(p => proj(p[0], p[1]));
      if (pts.length < 3) continue;
      // snabb avståndskontroll
      let near = false;
      for (const p of pts) if (Math.abs(p[0]) < RANGE && Math.abs(p[1]) < RANGE) { near = true; break; }
      if (!near) continue;
      if (pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1]) pts.push(pts[0]);
      local.push({ h: b.h, pts });
    }

    // Ligger punkten inne i ett hus (vanligt i OSM)? Flytta den då ut till
    // närmaste fasad, 2 m utanför – där serveringen troligen står.
    let ox = 0, oy = 0, indoor = false;
    for (const b of local) {
      if (pointInPoly(0, 0, b.pts)) {
        const n = nearestOnPoly(0, 0, b.pts);
        const d = Math.hypot(n[0], n[1]) || 1;
        ox = n[0] + (n[0] / d) * 2; oy = n[1] + (n[1] / d) * 2;
        if (pointInPoly(ox, oy, b.pts)) { ox = n[0] - (n[0] / d) * 2; oy = n[1] - (n[1] / d) * 2; }
        indoor = true;
        break;
      }
    }

    const prof = new Float32Array(BINS);
    for (let a = 0; a < BINS; a++) {
      const az = (a + 0.5) * DEG;
      const dx = Math.sin(az), dy = Math.cos(az); // kompassriktning
      let best = 0;
      for (const b of local) {
        const rise = b.h - EYE;
        if (rise <= 0) continue;
        const pts = b.pts;
        for (let i = 0; i < pts.length - 1; i++) {
          const ax = pts[i][0] - ox, ay = pts[i][1] - oy;
          const ex = pts[i + 1][0] - pts[i][0], ey = pts[i + 1][1] - pts[i][1];
          const den = dx * ey - dy * ex;
          if (Math.abs(den) < 1e-12) continue;
          const t = (ax * ey - ay * ex) / den;     // avstånd längs strålen
          const u = (ax * dy - ay * dx) / den;     // position på väggen
          if (t > 0.3 && u >= 0 && u <= 1) {
            const el = Math.atan2(rise, t) / DEG;
            if (el > best) best = el;
          }
        }
      }
      prof[a] = best;
    }
    const out = new Int16Array(BINS);
    for (let a = 0; a < BINS; a++) out[a] = Math.round(prof[a] * 10);
    // tillbaka till lat/lon för den justerade punkten
    const lat = venue.lat + oy / 111320;
    const lon = venue.lon + ox / (111320 * Math.cos(venue.lat * DEG));
    return { profile: Array.from(out), lat, lon, indoor };
  }

  // Solens position i kompassgrader + höjd i grader.
  function sunPos(date, lat, lon) {
    const p = root.SunCalc.getPosition(date, lat, lon);
    return { az: ((p.azimuth / DEG) + 180 + 360) % 360, alt: p.altitude / DEG };
  }

  function isSunlit(profile, date, lat, lon) {
    const s = sunPos(date, lat, lon);
    if (s.alt <= 0.5) return false;
    const block = profile[Math.floor(s.az) % BINS] / 10;
    return s.alt > block;
  }

  // Soliga intervall för ett dygn (lokal tid), steg om 5 min.
  function sunIntervals(profile, day, lat, lon) {
    const start = new Date(day); start.setHours(0, 0, 0, 0);
    const STEP = 5 * 60000;
    const out = [];
    let cur = null;
    for (let t = start.getTime(); t <= start.getTime() + 864e5; t += STEP) {
      const lit = isSunlit(profile, new Date(t), lat, lon);
      if (lit && !cur) cur = [t, t];
      else if (lit && cur) cur[1] = t;
      else if (!lit && cur) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out.map(([a, b]) => [new Date(a), new Date(b + STEP)]);
  }

  root.Shadow = { computeProfile, buildingHeight, isSunlit, sunIntervals, sunPos };
})(typeof window !== 'undefined' ? window : globalThis);
