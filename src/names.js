import { normalizeHex } from "./color.js";

export function buildNameIndex(pairs) {
  const byName = new Map();
  const byHex = new Map();
  const sorted = [];
  for (const [name, hex] of pairs) {
    byName.set(name.toLowerCase(), hex);
    byHex.set(hex, name);
    sorted.push({ key: name.toLowerCase(), name, hex });
  }
  sorted.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { byName, byHex, sorted };
}

export function suggestNames(index, query, limit = 12) {
  const q = String(query).trim().toLowerCase();
  if (!index || !q || q.startsWith("#")) return [];
  const { sorted } = index;
  const out = [];
  const seen = new Set();
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].key < q) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < sorted.length && out.length < limit; i++) {
    if (!sorted[i].key.startsWith(q)) break;
    out.push(sorted[i]);
    seen.add(sorted[i].key);
  }
  if (out.length < limit && q.length >= 2) {
    for (const item of sorted) {
      if (seen.has(item.key)) continue;
      if (item.key.includes(q)) {
        out.push(item);
        seen.add(item.key);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

export function resolveColor(index, text) {
  if (!index) return null;
  const raw = String(text).trim();
  if (!raw) return null;
  if (raw.startsWith("#")) {
    const hex = normalizeHex(raw);
    if (!hex) return null;
    return { name: index.byHex.get(hex) || null, hex };
  }
  const namedHex = index.byName.get(raw.toLowerCase());
  if (namedHex) return { name: index.byHex.get(namedHex), hex: namedHex };
  if (/^[0-9a-fA-F]{3}$/.test(raw) || /^[0-9a-fA-F]{6}$/.test(raw)) {
    const hex = normalizeHex(raw);
    if (!hex) return null;
    return { name: index.byHex.get(hex) || null, hex };
  }
  return null;
}
