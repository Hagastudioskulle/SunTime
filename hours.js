// Suntime – enkel tolkning av OSM opening_hours (vanliga mönster).
// Returnerar true (öppet), false (stängt) eller null (vet inte).
(function (root) {
  'use strict';
  const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

  function parseDays(tok) {
    const out = new Set();
    for (const part of tok.split(',')) {
      const m = part.match(/^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/);
      if (!m) return null;
      const a = DAYS.indexOf(m[1]), b = m[2] ? DAYS.indexOf(m[2]) : a;
      for (let i = a; ; i = (i + 1) % 7) { out.add(i); if (i === b) break; }
    }
    return out;
  }

  function parseTimes(tok) {
    const out = [];
    for (const part of tok.split(',')) {
      const m = part.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\+?$/) || part.match(/^(\d{1,2}):(\d{2})\+$/);
      if (!m) return null;
      const a = +m[1] * 60 + +m[2];
      let b = m[3] != null ? +m[3] * 60 + +m[4] : 24 * 60;
      if (b <= a) b += 24 * 60; // över midnatt
      out.push([a, b]);
    }
    return out;
  }

  // -> array[7] med intervall i minuter från dygnets början, eller null
  function parse(str) {
    if (!str) return null;
    str = str.trim();
    if (str === '24/7') return Array.from({ length: 7 }, () => [[0, 1440]]);
    const week = Array.from({ length: 7 }, () => null);
    for (let rule of str.split(/\s*;\s*/)) {
      rule = rule.trim();
      if (!rule) continue;
      rule = rule.replace(/\bPH\s*(off|closed)\b/g, '').replace(/,?\s*PH\b/g, '').trim();
      if (!rule) continue;
      let days = new Set([0, 1, 2, 3, 4, 5, 6]), rest = rule;
      const dm = rule.match(/^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:,(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)\s*(.*)$/);
      if (dm) { days = parseDays(dm[1]); rest = dm[2]; }
      if (!days) return null;
      rest = rest.replace(/\s+/g, '');
      let times;
      if (/^(off|closed)$/.test(rest)) times = [];
      else { times = parseTimes(rest); if (!times) return null; }
      for (const d of days) week[d] = times;
    }
    // dagar som inte nämns räknas som stängda
    return week.map((t) => t || []);
  }

  function isOpen(str, date) {
    const w = parse(str);
    if (!w) return null;
    const d = (date.getDay() + 6) % 7; // måndag = 0
    const min = date.getHours() * 60 + date.getMinutes();
    for (const [a, b] of w[d]) if (min >= a && min < b) return true;
    const y = (d + 6) % 7;
    for (const [a, b] of w[y]) if (b > 1440 && min + 1440 >= a && min + 1440 < b) return true;
    return false;
  }

  root.Hours = { parse, isOpen };
})(typeof window !== 'undefined' ? window : globalThis);
