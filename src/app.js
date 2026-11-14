import {
  byCloseness,
  byTotalDev,
  colorSimilarity,
  guessSpecs,
  labFromHex,
  scanConsistentAsync,
  scanSimilarAsync,
} from "./color.js";
import { buildNameIndex, resolveColor, suggestNames } from "./names.js";

const TARGET_LIMIT = 200;
const SOLVE_LIMIT = 50;
const TABS = ["compare", "target", "solve"];

const pill = document.getElementById("count-pill");
const compareFields = document.getElementById("compare-fields");
const targetMount = document.getElementById("target-color-mount");
const targetSim = document.getElementById("target-sim");
const targetStatus = document.getElementById("target-status");
const targetBar = document.getElementById("target-bar");
const targetResults = document.getElementById("target-results");
const solveStatus = document.getElementById("solve-status");
const solveBar = document.getElementById("solve-bar");
const solveResults = document.getElementById("solve-results");
const guessesEl = document.getElementById("guesses");

let index = null;
let pairs = null;
let labsPromise = null;
let fieldA;
let fieldB;
let targetField;
const guessRows = [];
let guessSerial = 0;

let mode = "worker";
let worker = null;
let workerReady = false;
let queued = { similar: null, consistent: null };
let targetReq = 0;
let solveReq = 0;
let targetQuery = null;
let solveQuery = null;
const localGen = { similar: 0, consistent: 0 };
let targetTimer = 0;
let solveTimer = 0;

function fmt(n) {
  return Number(n).toFixed(2);
}

function fmtCount(n) {
  return n.toLocaleString("en-US");
}

function showTab(name) {
  const tab = TABS.includes(name) ? name : "compare";
  for (const id of TABS) {
    const on = id === tab;
    document.getElementById(`panel-${id}`).hidden = !on;
    const button = document.getElementById(`tab-${id}`);
    button.classList.toggle("on", on);
    button.setAttribute("aria-selected", on ? "true" : "false");
  }
  const hash = `#${tab}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

function paintSwatch(node, hex) {
  if (!hex) {
    node.style.background = "";
    node.classList.add("empty");
    return;
  }
  node.classList.remove("empty");
  node.style.background = hex;
}

function mountTolerance(parent, { onChange }) {
  const wrap = document.createElement("div");
  wrap.className = "tolerance";
  wrap.innerHTML = `
    <label>Tolerance <span class="tol-readout">±2.0%</span>
      <span class="tol-row">
        <input type="range" min="0" max="15" step="0.1" value="2" aria-label="Tolerance">
        <input type="number" min="0" max="15" step="0.1" value="2" aria-label="Tolerance percent">
      </span>
    </label>
    <p class="muted small">Colors stay when they are at most this far from the target percent.</p>`;
  parent.append(wrap);
  const range = wrap.querySelector('input[type="range"]');
  const num = wrap.querySelector('input[type="number"]');
  const read = wrap.querySelector(".tol-readout");
  function clamp(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.min(15, Math.max(0, Math.round(n * 10) / 10));
  }
  function paint(value) {
    read.textContent = `±${value.toFixed(1)}%`;
    if (document.activeElement !== num) num.value = value.toFixed(1);
  }
  range.addEventListener("input", () => {
    const value = clamp(range.value);
    num.value = value.toFixed(1);
    paint(value);
    onChange();
  });
  num.addEventListener("input", () => {
    const value = clamp(num.value);
    if (value == null) return;
    range.value = String(value);
    paint(value);
    onChange();
  });
  num.addEventListener("blur", () => {
    const value = clamp(num.value);
    const next = value == null ? 2 : value;
    num.value = next.toFixed(1);
    range.value = String(next);
    paint(next);
    onChange();
  });
  paint(2);
  return {
    value() {
      return clamp(num.value) ?? clamp(range.value) ?? 2;
    },
    set(raw, { notify = true } = {}) {
      const value = clamp(raw) ?? 2;
      range.value = String(value);
      num.value = value.toFixed(1);
      paint(value);
      if (notify) onChange();
    },
  };
}

function mountColorInput(parent, { id, label, onChange }) {
  const wrap = document.createElement("div");
  wrap.className = "color-field";
  wrap.innerHTML = `
    <div class="color-anchor">
      <div class="color-line">
        <div class="swatch empty" id="${id}-swatch" aria-hidden="true"></div>
        <label class="grow">${label}
          <input type="text" id="${id}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Name, #abc, or #aabbcc" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-list">
        </label>
        <label class="picker">Pick
          <input type="color" id="${id}-pick" value="#808080" aria-label="${label} color picker">
        </label>
      </div>
      <ul class="suggest" id="${id}-list" role="listbox" hidden></ul>
    </div>
    <p class="resolved muted small" id="${id}-meta"></p>`;
  parent.append(wrap);
  const input = wrap.querySelector('input[type="text"]');
  const pick = wrap.querySelector('input[type="color"]');
  const swatch = wrap.querySelector(".swatch");
  const list = wrap.querySelector(".suggest");
  const meta = wrap.querySelector(".resolved");
  let active = -1;
  let items = [];
  let hex3Timer = 0;
  let lastKey = "";

  function current() {
    return resolveColor(index, input.value);
  }

  function paint(color) {
    paintSwatch(swatch, color && color.hex);
    if (!color) {
      meta.textContent = "";
      return;
    }
    pick.value = color.hex.toLowerCase();
    meta.textContent = color.name ? `${color.name} · ${color.hex}` : `Custom color · ${color.hex}`;
  }

  function commit(color, { rewrite = false } = {}) {
    if (rewrite && color) input.value = color.name || color.hex;
    paint(color);
    const key = color ? `${color.hex}|${color.name || ""}` : "";
    if (key === lastKey) return;
    lastKey = key;
    onChange(color);
  }

  function closeList() {
    list.hidden = true;
    list.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
    items = [];
  }

  function highlight(next) {
    const buttons = [...list.querySelectorAll(".suggest-item")];
    if (!buttons.length) return;
    active = (next + buttons.length) % buttons.length;
    buttons.forEach((button, i) => button.classList.toggle("on", i === active));
    buttons[active].scrollIntoView({ block: "nearest" });
    input.setAttribute("aria-activedescendant", buttons[active].id);
  }

  function choose(item) {
    clearTimeout(hex3Timer);
    input.value = item.name;
    closeList();
    commit({ name: item.name, hex: item.hex });
  }

  function openSuggestions() {
    const query = input.value.trim();
    if (!index || !query || query.startsWith("#")) {
      closeList();
      return;
    }
    items = suggestNames(index, query, 12);
    if (!items.length) {
      closeList();
      return;
    }
    list.innerHTML = "";
    items.forEach((item, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "presentation");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "suggest-item";
      button.id = `${id}-opt-${i}`;
      button.setAttribute("role", "option");
      const chip = document.createElement("span");
      chip.className = "swatch";
      chip.style.background = item.hex;
      const name = document.createElement("span");
      name.className = "suggest-name";
      name.textContent = item.name;
      const hex = document.createElement("span");
      hex.className = "suggest-hex mono";
      hex.textContent = item.hex;
      button.append(chip, name, hex);
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => choose(item));
      li.append(button);
      list.append(li);
    });
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    active = -1;
  }

  function applyText({ rewrite = false } = {}) {
    const raw = input.value.trim();
    if (!raw) {
      clearTimeout(hex3Timer);
      closeList();
      commit(null);
      return;
    }
    const shortHex = /^#?[0-9a-fA-F]{3}$/.test(raw) && !index?.byName.has(raw.toLowerCase());
    const color = current();
    if (shortHex && !rewrite) {
      paint(color);
      clearTimeout(hex3Timer);
      hex3Timer = setTimeout(() => commit(current()), 400);
      return;
    }
    clearTimeout(hex3Timer);
    commit(color, { rewrite });
  }

  input.addEventListener("input", () => {
    openSuggestions();
    applyText();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (list.hidden) openSuggestions();
      highlight(active + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!list.hidden) highlight(active - 1);
    } else if (event.key === "Enter") {
      if (!list.hidden && active >= 0) {
        event.preventDefault();
        choose(items[active]);
      } else if (!list.hidden) {
        event.preventDefault();
        closeList();
        applyText({ rewrite: true });
      }
    } else if (event.key === "Escape") {
      closeList();
    }
  });
  input.addEventListener("blur", () => {
    closeList();
    applyText({ rewrite: true });
  });
  pick.addEventListener("input", () => {
    clearTimeout(hex3Timer);
    const hex = pick.value.toUpperCase();
    const name = index ? index.byHex.get(hex) || null : null;
    input.value = name || hex;
    closeList();
    commit({ name, hex });
  });
  document.addEventListener("click", (event) => {
    if (!wrap.contains(event.target)) closeList();
  });

  return {
    input,
    getColor: current,
    setColor(color) {
      clearTimeout(hex3Timer);
      input.value = color && (color.name || color.hex) || "";
      closeList();
      commit(color || null);
    },
  };
}

function renderBig(slot, color) {
  const swatch = document.getElementById(`big-${slot}`);
  const name = document.getElementById(`name-${slot}`);
  const hex = document.getElementById(`hex-${slot}`);
  paintSwatch(swatch, color && color.hex);
  if (!color) {
    name.textContent = slot === "a" ? "Color A" : "Color B";
    hex.textContent = "";
    return;
  }
  name.textContent = color.name || "Custom color";
  hex.textContent = color.hex;
}

function updateCompare() {
  const a = fieldA.getColor();
  const b = fieldB.getColor();
  renderBig("a", a);
  renderBig("b", b);
  const value = document.getElementById("sim-value");
  const bar = document.querySelector("#sim-bar > i");
  if (!a || !b) {
    value.textContent = "—";
    bar.style.width = "0";
    return;
  }
  const similarity = colorSimilarity(a.hex, b.hex);
  value.textContent = `${fmt(similarity)}%`;
  bar.style.width = `${Math.max(0, Math.min(100, similarity))}%`;
}

function setBar(bar, ratio) {
  bar.hidden = false;
  bar.querySelector("i").style.width = `${Math.round(ratio * 100)}%`;
}

function hideBar(bar) {
  bar.hidden = true;
  bar.querySelector("i").style.width = "0";
}

function actionButtons(color) {
  const actions = document.createElement("div");
  actions.className = "result-actions";
  const specs = [
    ["Compare A", () => useCompare("a", color)],
    ["Compare B", () => useCompare("b", color)],
    ["Add guess", () => useGuess(color)],
  ];
  for (const [label, fn] of specs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost mini";
    button.textContent = label;
    button.addEventListener("click", fn);
    actions.append(button);
  }
  return actions;
}

function resultShell(color) {
  const li = document.createElement("li");
  li.className = "result";
  const swatch = document.createElement("div");
  swatch.className = "swatch";
  swatch.style.background = color.hex;
  const main = document.createElement("div");
  const name = document.createElement("div");
  name.className = "result-name";
  name.textContent = color.name;
  const meta = document.createElement("div");
  meta.className = "result-meta mono";
  meta.textContent = color.hex;
  main.append(name, meta);
  li.append(swatch, main, actionButtons(color));
  return { li, main };
}

function renderTarget(message) {
  if (message.id !== targetReq) return;
  hideBar(targetBar);
  targetResults.innerHTML = "";
  const shown = message.matches.length;
  const noun = message.total === 1 ? "color" : "colors";
  const query = targetQuery;
  const tolerance = query ? query.tolerance : targetTol.value();
  const sim = query ? query.sim : Number(targetSim.value);
  if (!message.total) {
    targetStatus.textContent = `No named colors within ±${tolerance.toFixed(1)}% of ${fmt(sim)}% similar to ${query ? query.label : "that color"}.`;
    return;
  }
  const extra = message.total > shown ? ` Showing the closest ${shown}.` : "";
  targetStatus.textContent = `${fmtCount(message.total)} ${noun} within ±${tolerance.toFixed(1)}% of ${fmt(sim)}%.${extra}`;
  const frag = document.createDocumentFragment();
  for (const match of message.matches) {
    const { li, main } = resultShell(match);
    const score = document.createElement("div");
    score.className = "result-score";
    score.textContent = `${fmt(match.similarity)}%`;
    const off = document.createElement("div");
    off.className = "result-meta";
    off.textContent = `off by ${fmt(Math.abs(match.similarity - sim))}`;
    main.append(score, off);
    frag.append(li);
  }
  targetResults.append(frag);
}

function renderSolve(message) {
  if (message.id !== solveReq) return;
  hideBar(solveBar);
  solveResults.innerHTML = "";
  const shown = message.matches.length;
  const noun = message.total === 1 ? "color matches" : "colors match";
  const tolerance = solveQuery ? solveQuery.tolerance : solveTol.value();
  if (!message.total) {
    solveStatus.textContent = `No color is within ±${tolerance.toFixed(1)}% of every guess.`;
    return;
  }
  const extra = message.total > shown ? ` Showing the top ${shown}.` : "";
  solveStatus.textContent = `${fmtCount(message.total)} ${noun} every guess within ±${tolerance.toFixed(1)}%.${extra}`;
  const frag = document.createDocumentFragment();
  for (const match of message.matches) {
    const { li, main } = resultShell(match);
    const list = document.createElement("ul");
    list.className = "devs";
    for (const guess of match.perGuess) {
      const item = document.createElement("li");
      const dot = document.createElement("i");
      dot.className = "dot";
      dot.style.background = guess.hex;
      const label = document.createElement("span");
      label.textContent = guess.name || guess.hex;
      const actual = document.createElement("span");
      actual.textContent = `${fmt(guess.similarity)}%`;
      const dev = document.createElement("b");
      dev.textContent = `Δ ${fmt(guess.deviation)}`;
      item.append(dot, label, actual, dev);
      list.append(item);
    }
    const total = document.createElement("div");
    total.className = "total";
    total.textContent = `Total Δ ${fmt(match.totalDev)}`;
    main.append(list, total);
    frag.append(li);
  }
  solveResults.append(frag);
}

function onWorkerMessage(event) {
  const msg = event.data;
  if (msg.type === "prep") {
    pill.textContent = `Preparing… ${Math.round(msg.ratio * 100)}%`;
    return;
  }
  if (msg.type === "ready") {
    workerReady = true;
    if (pairs) pill.textContent = `${fmtCount(pairs.length)} names`;
    const jobs = queued;
    queued = { similar: null, consistent: null };
    if (jobs.similar) worker.postMessage(jobs.similar);
    if (jobs.consistent) worker.postMessage(jobs.consistent);
    return;
  }
  if (msg.type === "error") {
    mode = "local";
    workerReady = false;
    pill.textContent = pairs ? `${fmtCount(pairs.length)} names` : "Names ready";
    const jobs = queued;
    queued = { similar: null, consistent: null };
    if (jobs.similar) runLocal(jobs.similar);
    if (jobs.consistent) runLocal(jobs.consistent);
    return;
  }
  if (msg.type === "progress") {
    if (msg.id === targetReq) setBar(targetBar, msg.ratio);
    if (msg.id === solveReq) setBar(solveBar, msg.ratio);
    return;
  }
  if (msg.type === "similar") renderTarget(msg);
  if (msg.type === "consistent") renderSolve(msg);
}

function ask(msg) {
  const kind = msg.type === "similar" ? "similar" : "consistent";
  if (mode === "worker" && worker) {
    if (!workerReady) {
      queued[kind] = msg;
      return;
    }
    worker.postMessage(msg);
    return;
  }
  runLocal(msg);
}

function ensureLabs() {
  if (!labsPromise) {
    labsPromise = (async () => {
      const prepared = new Array(pairs.length);
      for (let i = 0; i < pairs.length; i++) {
        prepared[i] = { name: pairs[i][0], hex: pairs[i][1], lab: labFromHex(pairs[i][1]) };
        if ((i + 1) % 4000 === 0) {
          pill.textContent = `Preparing… ${Math.round(((i + 1) / pairs.length) * 100)}%`;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      pill.textContent = `${fmtCount(pairs.length)} names`;
      return prepared;
    })();
  }
  return labsPromise;
}

async function runLocal(msg) {
  const kind = msg.type === "similar" ? "similar" : "consistent";
  const colors = await ensureLabs();
  const my = ++localGen[kind];
  const hooks = {
    shouldStop: () => my !== localGen[kind],
    onProgress: (ratio) => {
      if (kind === "similar" && msg.id === targetReq) setBar(targetBar, ratio);
      if (kind === "consistent" && msg.id === solveReq) setBar(solveBar, ratio);
    },
  };
  if (kind === "similar") {
    const matches = await scanSimilarAsync(colors, labFromHex(msg.targetHex), msg.targetSim, msg.tolerance, hooks);
    if (!matches || my !== localGen.similar || msg.id !== targetReq) return;
    matches.sort(byCloseness(msg.targetSim));
    renderTarget({ id: msg.id, total: matches.length, matches: matches.slice(0, msg.limit || TARGET_LIMIT) });
    return;
  }
  const specs = guessSpecs(msg.guesses, new Map());
  if (!specs) {
    renderSolve({ id: msg.id, total: 0, matches: [] });
    return;
  }
  const exclude = new Set(msg.guesses.map((guess) => guess.name).filter(Boolean));
  const matches = await scanConsistentAsync(colors, specs, msg.tolerance, { ...hooks, exclude });
  if (!matches || my !== localGen.consistent || msg.id !== solveReq) return;
  matches.sort(byTotalDev);
  renderSolve({ id: msg.id, total: matches.length, matches: matches.slice(0, msg.limit || SOLVE_LIMIT) });
}

function scheduleTarget() {
  clearTimeout(targetTimer);
  targetTimer = setTimeout(runTarget, 280);
}

function scheduleSolve() {
  clearTimeout(solveTimer);
  solveTimer = setTimeout(runSolve, 280);
}

function runTarget() {
  const color = targetField.getColor();
  const sim = Number(targetSim.value);
  if (!index) return;
  if (!color || !Number.isFinite(sim)) {
    targetReq++;
    hideBar(targetBar);
    targetResults.innerHTML = "";
    targetStatus.textContent = color ? "Enter a target similarity." : "Choose a color and a target similarity.";
    return;
  }
  const id = ++targetReq;
  targetQuery = { sim, tolerance: targetTol.value(), label: color.name || color.hex };
  setBar(targetBar, 0.04);
  targetStatus.textContent = "Scanning named colors…";
  ask({
    type: "similar",
    id,
    targetHex: color.hex,
    targetSim: sim,
    tolerance: targetTol.value(),
    limit: TARGET_LIMIT,
  });
}

function collectGuesses() {
  const guesses = [];
  let incomplete = false;
  for (const row of guessRows) {
    const text = row.field.input.value.trim();
    const pctRaw = row.pct.value.trim();
    if (!text && !pctRaw) continue;
    const color = row.field.getColor();
    const sim = Number(pctRaw);
    if (!color || pctRaw === "" || !Number.isFinite(sim)) {
      incomplete = true;
      continue;
    }
    guesses.push({ name: color.name, hex: color.hex, sim });
  }
  return { guesses, incomplete };
}

function runSolve() {
  if (!index) return;
  const { guesses, incomplete } = collectGuesses();
  if (incomplete) {
    solveReq++;
    hideBar(solveBar);
    solveResults.innerHTML = "";
    solveStatus.textContent = "Each guess needs a color and a similarity percent.";
    return;
  }
  if (!guesses.length) {
    solveReq++;
    hideBar(solveBar);
    solveResults.innerHTML = "";
    solveStatus.textContent = "Add a color and the similarity you were shown.";
    return;
  }
  const id = ++solveReq;
  solveQuery = { tolerance: solveTol.value() };
  setBar(solveBar, 0.04);
  solveStatus.textContent = "Scanning named colors…";
  ask({
    type: "consistent",
    id,
    guesses,
    tolerance: solveTol.value(),
    limit: SOLVE_LIMIT,
  });
}

function useCompare(slot, color) {
  (slot === "a" ? fieldA : fieldB).setColor(color);
  showTab("compare");
  document.getElementById("panel-compare").scrollIntoView({ block: "start" });
}

function useGuess(color) {
  const empty = guessRows.find((row) => !row.field.input.value.trim() && !row.pct.value.trim());
  const row = empty || addGuessRow();
  row.field.setColor(color);
  showTab("solve");
  row.pct.focus();
}

function addGuessRow(color, sim) {
  const row = document.createElement("div");
  row.className = "guess-row";
  const mount = document.createElement("div");
  mount.className = "color-mount";
  const pctLabel = document.createElement("label");
  pctLabel.textContent = "Similarity %";
  const pct = document.createElement("input");
  pct.type = "number";
  pct.className = "pct";
  pct.min = "0";
  pct.max = "100";
  pct.step = "0.01";
  pct.inputMode = "decimal";
  pct.setAttribute("aria-label", "Similarity percent");
  pctLabel.append(pct);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ghost";
  remove.textContent = "Remove";
  row.append(mount, pctLabel, remove);
  guessesEl.append(row);
  const id = `guess-${++guessSerial}`;
  const field = mountColorInput(mount, { id, label: "Guess", onChange: scheduleSolve });
  pct.addEventListener("input", scheduleSolve);
  const entry = { row, field, pct };
  guessRows.push(entry);
  remove.addEventListener("click", () => {
    const at = guessRows.indexOf(entry);
    if (at >= 0) guessRows.splice(at, 1);
    row.remove();
    if (!guessRows.length) addGuessRow();
    scheduleSolve();
  });
  if (sim != null && sim !== "") pct.value = String(sim);
  if (color) field.setColor(color);
  return entry;
}

function loadSample() {
  if (!index) return;
  for (const entry of [...guessRows]) entry.row.remove();
  guessRows.length = 0;
  solveTol.set(8, { notify: false });
  addGuessRow(resolveColor(index, "White Blue"), 90);
  addGuessRow(resolveColor(index, "Bubblegum"), 90);
  scheduleSolve();
}

const targetTol = mountTolerance(document.getElementById("target-tol"), { onChange: scheduleTarget });
const solveTol = mountTolerance(document.getElementById("solve-tol"), { onChange: scheduleSolve });

fieldA = mountColorInput(compareFields, { id: "compare-a", label: "Color A", onChange: updateCompare });
fieldB = mountColorInput(compareFields, { id: "compare-b", label: "Color B", onChange: updateCompare });
targetField = mountColorInput(targetMount, { id: "target-color", label: "Color", onChange: scheduleTarget });
targetSim.addEventListener("input", scheduleTarget);
document.getElementById("add-guess").addEventListener("click", () => addGuessRow());
document.getElementById("sample-guesses").addEventListener("click", loadSample);
for (const id of TABS) {
  document.getElementById(`tab-${id}`).addEventListener("click", () => showTab(id));
}
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));
showTab(location.hash.slice(1) || "compare");
addGuessRow();
addGuessRow();

try {
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = onWorkerMessage;
  worker.onerror = () => {
    if (workerReady) return;
    mode = "local";
    worker = null;
    const jobs = queued;
    queued = { similar: null, consistent: null };
    if (jobs.similar) runLocal(jobs.similar);
    if (jobs.consistent) runLocal(jobs.consistent);
  };
  worker.postMessage({ type: "init" });
} catch {
  mode = "local";
}

fetch(new URL("./colors.json", import.meta.url))
  .then((response) => {
    if (!response.ok) throw new Error(`colors.json ${response.status}`);
    return response.json();
  })
  .then((data) => {
    pairs = data;
    index = buildNameIndex(pairs);
    if (workerReady || mode === "local") pill.textContent = `${fmtCount(pairs.length)} names`;
    fieldA.setColor(resolveColor(index, "Red"));
    fieldB.setColor(resolveColor(index, "Blue"));
  })
  .catch(() => {
    pill.textContent = "Names failed to load";
    targetStatus.textContent = "Could not load colors.json. Serve this folder over HTTP so the page can read it.";
    solveStatus.textContent = "Could not load colors.json.";
  });
