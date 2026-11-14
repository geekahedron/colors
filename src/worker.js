import {
  byCloseness,
  byTotalDev,
  guessSpecs,
  labFromHex,
  scanConsistentAsync,
  scanSimilarAsync,
} from "./color.js";

let colors = null;
let ready = false;
let pending = { similar: null, consistent: null };
const searchGen = { similar: 0, consistent: 0 };

function yieldNow() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function loadCatalog() {
  const response = await fetch(new URL("./colors.json", import.meta.url));
  if (!response.ok) throw new Error(`colors.json ${response.status}`);
  const pairs = await response.json();
  const catalog = new Array(pairs.length);
  for (let i = 0; i < pairs.length; i++) {
    catalog[i] = { name: pairs[i][0], hex: pairs[i][1], lab: labFromHex(pairs[i][1]) };
    if ((i + 1) % 5000 === 0) {
      self.postMessage({ type: "prep", ratio: (i + 1) / pairs.length });
      await yieldNow();
    }
  }
  return catalog;
}

async function runJob(msg) {
  const kind = msg.type === "similar" ? "similar" : "consistent";
  const my = ++searchGen[kind];
  const shouldStop = () => my !== searchGen[kind];
  const onProgress = (ratio) => self.postMessage({ type: "progress", id: msg.id, ratio });
  if (msg.type === "similar") {
    const targetLab = labFromHex(msg.targetHex);
    const matches = await scanSimilarAsync(colors, targetLab, msg.targetSim, msg.tolerance, {
      shouldStop,
      onProgress,
    });
    if (!matches || shouldStop()) return;
    matches.sort(byCloseness(msg.targetSim));
    self.postMessage({
      type: "similar",
      id: msg.id,
      total: matches.length,
      matches: matches.slice(0, msg.limit || 200),
    });
    return;
  }
  if (msg.type === "consistent") {
    const specs = guessSpecs(msg.guesses, new Map());
    if (!specs) {
      self.postMessage({ type: "consistent", id: msg.id, total: 0, matches: [], error: "unknown" });
      return;
    }
    const exclude = new Set();
    for (const guess of msg.guesses) {
      if (guess.name) exclude.add(guess.name);
    }
    const matches = await scanConsistentAsync(colors, specs, msg.tolerance, {
      shouldStop,
      onProgress,
      exclude,
    });
    if (!matches || shouldStop()) return;
    matches.sort(byTotalDev);
    self.postMessage({
      type: "consistent",
      id: msg.id,
      total: matches.length,
      matches: matches.slice(0, msg.limit || 50),
    });
  }
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type === "init") {
    try {
      colors = await loadCatalog();
      ready = true;
      self.postMessage({ type: "ready", count: colors.length });
      const jobs = pending;
      pending = { similar: null, consistent: null };
      if (jobs.similar) void runJob(jobs.similar);
      if (jobs.consistent) void runJob(jobs.consistent);
    } catch (error) {
      self.postMessage({ type: "error", message: String(error && error.message ? error.message : error) });
    }
    return;
  }
  if (!ready) {
    pending[msg.type === "similar" ? "similar" : "consistent"] = msg;
    return;
  }
  await runJob(msg);
};
