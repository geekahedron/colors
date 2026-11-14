// Port of color_similarity, find_similar_colors, and find_consistent_colors
// from reference/color-finder.pl. The arithmetic follows that script,
// including its CIEDE2000 hue handling.

const PI = Math.PI;

function deg2rad(degrees) {
  return (degrees * PI) / 180;
}

function hexToRgb(hex) {
  const h = String(hex).replace(/^#/, "");
  const m = h.match(/(..)(..)(..)/);
  return [
    parseInt(m[1], 16) / 255,
    parseInt(m[2], 16) / 255,
    parseInt(m[3], 16) / 255,
  ];
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function rgbToXyz(r, g, b) {
  r = srgbToLinear(r);
  g = srgbToLinear(g);
  b = srgbToLinear(b);
  const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
  const z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041;
  return [x, y, z];
}

function fLab(t) {
  return t > (6 / 29) ** 3 ? t ** (1 / 3) : (1 / 3) * (29 / 6) ** 2 * t + 4 / 29;
}

function xyzToLab(x, y, z) {
  const xn = 0.95047;
  const yn = 1.0;
  const zn = 1.08883;
  x /= xn;
  y /= yn;
  z /= zn;
  const fx = fLab(x);
  const fy = fLab(y);
  const fz = fLab(z);
  const L = 116 * fy - 16;
  const a = 500 * (fx - fy);
  const b = 200 * (fy - fz);
  return [L, a, b];
}

function ciede2000(L1, a1, b1, L2, a2, b2) {
  const C1 = Math.sqrt(a1 ** 2 + b1 ** 2);
  const C2 = Math.sqrt(a2 ** 2 + b2 ** 2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.sqrt(a1p ** 2 + b1 ** 2);
  const C2p = Math.sqrt(a2p ** 2 + b2 ** 2);
  let h1p = Math.atan2(b1, a1p);
  if (h1p < 0) h1p += 2 * PI;
  let h2p = Math.atan2(b2, a2p);
  if (h2p < 0) h2p += 2 * PI;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = h2p - h1p;
  if (Math.abs(dhp) > PI) {
    if (h2p <= h1p) dhp += 2 * PI;
    if (h2p > h1p) dhp -= 2 * PI;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp / 2);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = (h1p + h2p) / 2;
  if (Math.abs(h1p - h2p) > PI) {
    if (h1p + h2p < 2 * PI) hbarp += PI;
    if (h1p + h2p >= 2 * PI) hbarp -= PI;
  }

  const T =
    1 -
    0.17 * Math.cos(hbarp - deg2rad(30)) +
    0.24 * Math.cos(2 * hbarp) +
    0.32 * Math.cos(3 * hbarp + deg2rad(6)) -
    0.20 * Math.cos(4 * hbarp - deg2rad(63));
  const Sl = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const dtheta = deg2rad(30) * Math.exp(-(((hbarp - deg2rad(275)) / deg2rad(25)) ** 2));
  const Rc = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
  const Rt = -Rc * Math.sin(2 * dtheta);

  return Math.sqrt(
    (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh),
  );
}

export function normalizeHex(input) {
  if (input == null) return null;
  let s = String(input).trim();
  if (s.startsWith("#")) s = s.slice(1);
  if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.replace(/[0-9a-fA-F]/g, (ch) => ch + ch);
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return `#${s.toUpperCase()}`;
}

export function labFromHex(hex) {
  const [r, g, b] = hexToRgb(hex);
  const [x, y, z] = rgbToXyz(r, g, b);
  return xyzToLab(x, y, z);
}

export function similarityFromLab(lab1, lab2) {
  const dE00 = ciede2000(lab1[0], lab1[1], lab1[2], lab2[0], lab2[1], lab2[2]);
  let similarity = 100 * (1 - dE00 / 100);
  if (similarity < 0) similarity = 0;
  if (similarity > 100) similarity = 100;
  return similarity;
}

export function colorSimilarity(hex1, hex2) {
  return similarityFromLab(labFromHex(hex1), labFromHex(hex2));
}

export function prepareCatalog(pairs) {
  return pairs.map(([name, hex]) => ({
    name,
    hex,
    lab: labFromHex(hex),
  }));
}

export function nameToHexMap(colors) {
  const map = new Map();
  for (const c of colors) map.set(c.name.toLowerCase(), c.hex);
  return map;
}

/**
 * guesses is either { "White Blue": 90 } or [{ name, hex, sim }].
 * Returns null when a named guess is not in the catalog.
 */
export function guessSpecs(guesses, nameToHex) {
  const rows = Array.isArray(guesses)
    ? guesses.map((g) => ({
        name: g.name,
        sim: Number(g.sim),
        hex: g.hex || (g.name ? nameToHex.get(String(g.name).toLowerCase()) : null),
      }))
    : Object.entries(guesses).map(([name, sim]) => ({
        name,
        sim: Number(sim),
        hex: nameToHex.get(name.toLowerCase()) || null,
      }));
  const specs = [];
  for (const row of rows) {
    if (!row.hex) return null;
    specs.push({
      name: row.name,
      hex: row.hex,
      sim: row.sim,
      lab: labFromHex(row.hex),
    });
  }
  return specs;
}

export function matchConsistent(color, specs, tolerance) {
  const deviations = {};
  const perGuess = [];
  let totalDev = 0;
  for (const g of specs) {
    const similarity = similarityFromLab(g.lab, color.lab);
    const deviation = Math.abs(similarity - g.sim);
    if (deviation > tolerance) return null;
    deviations[g.name] = deviation;
    perGuess.push({
      name: g.name,
      hex: g.hex,
      similarity,
      deviation,
    });
    totalDev += deviation;
  }
  return {
    name: color.name,
    hex: color.hex,
    deviations,
    perGuess,
    totalDev,
  };
}

export function findConsistentColors(guesses, tolerance, colors, nameToHex) {
  const specs = guessSpecs(guesses, nameToHex);
  if (!specs) return [];
  const matches = [];
  for (const color of colors) {
    const hit = matchConsistent(color, specs, tolerance);
    if (hit) matches.push(hit);
  }
  return matches;
}

export function matchSimilar(color, targetLab, targetSim, tolerance) {
  const similarity = similarityFromLab(targetLab, color.lab);
  if (Math.abs(similarity - targetSim) <= tolerance) {
    return { name: color.name, hex: color.hex, similarity };
  }
  return null;
}

export function findSimilarColors(targetHex, targetSim, tolerance, colors) {
  const targetLab = labFromHex(targetHex);
  const matches = [];
  for (const color of colors) {
    const hit = matchSimilar(color, targetLab, targetSim, tolerance);
    if (hit) matches.push(hit);
  }
  return matches;
}

export function byTotalDev(a, b) {
  return a.totalDev - b.totalDev;
}

export function byCloseness(targetSim) {
  return (a, b) => {
    const d = Math.abs(a.similarity - targetSim) - Math.abs(b.similarity - targetSim);
    if (d !== 0) return d;
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  };
}

function yieldToLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function scanLoop(colors, hooks, visit) {
  const chunk = hooks.chunk || 5000;
  const matches = [];
  for (let i = 0; i < colors.length; i++) {
    const hit = visit(colors[i]);
    if (hit) matches.push(hit);
    if ((i + 1) % chunk === 0) {
      if (hooks.shouldStop?.()) return null;
      hooks.onProgress?.((i + 1) / colors.length);
      await yieldToLoop();
    }
  }
  return matches;
}

export function scanSimilarAsync(colors, targetLab, targetSim, tolerance, hooks = {}) {
  return scanLoop(colors, hooks, (color) => matchSimilar(color, targetLab, targetSim, tolerance));
}

export function scanConsistentAsync(colors, specs, tolerance, hooks = {}) {
  const exclude = hooks.exclude || null;
  return scanLoop(colors, hooks, (color) => {
    if (exclude && color.name && exclude.has(color.name)) return null;
    return matchConsistent(color, specs, tolerance);
  });
}
