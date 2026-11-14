import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  byTotalDev,
  colorSimilarity,
  findConsistentColors,
  guessSpecs,
  nameToHexMap,
  prepareCatalog,
  scanConsistentAsync,
} from "../src/color.js";
import { buildNameIndex, resolveColor, suggestNames } from "../src/names.js";
import { addColorRows, loadColors, outPath, sourceFiles } from "../tools/build-colors.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fmt(n) {
  return Number(n).toFixed(2);
}

function parseResults(text) {
  const blocks = [];
  let current = null;
  for (const raw of text.split(/\n/)) {
    const line = raw.replace(/\r$/, "");
    const head = line.match(/^(.+) \(#([0-9A-F]{6})\)$/);
    if (head) {
      current = { name: head[1], hex: `#${head[2]}`, deviations: {} };
      blocks.push(current);
      continue;
    }
    const dev = line.match(/^ {2}deviation vs (.+?) +\(#([0-9A-F]{6})\) => ([0-9]+\.[0-9]+)%$/);
    if (dev) {
      current.deviations[dev[1]] = { hex: `#${dev[2]}`, value: dev[3] };
      continue;
    }
    const total = line.match(/^ {2}total deviation => ([0-9]+\.[0-9]+)%$/);
    if (total) current.total = total[1];
  }
  return blocks;
}

test("dedupes on lowercased name or uppercased hex, first file wins", () => {
  const colors = [];
  const seenName = new Set();
  const seenHex = new Set();
  addColorRows(colors, seenName, seenHex, "name,hex,good name\nRed,#aa0000,x\nBlue,#0000ff\n");
  const second = addColorRows(
    colors,
    seenName,
    seenHex,
    'name,hex\nRED,#00ff00\n"Green, Dark",#00ff00\nGray,#808080\n',
  );
  const third = addColorRows(colors, seenName, seenHex, "name,hex,good\nGray,#ffffff\nSnow,#fffafa\n");
  assert.equal(second.skipped, 1);
  assert.equal(second.added, 2);
  assert.equal(third.skipped, 1);
  assert.equal(third.added, 1);
  assert.deepEqual(colors, [
    ["Red", "#AA0000"],
    ["Blue", "#0000FF"],
    ["Green, Dark", "#00FF00"],
    ["Gray", "#808080"],
    ["Snow", "#FFFAFA"],
  ]);
});

test("header-only extras.csv adds nothing", () => {
  const colors = [];
  const seenName = new Set();
  const seenHex = new Set();
  const result = addColorRows(colors, seenName, seenHex, fs.readFileSync(sourceFiles[2], "utf8"));
  assert.deepEqual(result, { added: 0, skipped: 0 });
  assert.deepEqual(colors, []);
});

test("colors.json matches load_colors order and dedupe", () => {
  const { colors, stats } = loadColors(sourceFiles);
  assert.equal(stats[0].added > 30000, true);
  assert.equal(stats[2].added, 0);
  assert.equal(stats[1].added > 0, true);
  const names = new Set();
  const hexes = new Set();
  for (const [name, hex] of colors) {
    assert.equal(names.has(name.toLowerCase()), false);
    assert.equal(hexes.has(hex), false);
    assert.match(hex, /^#[0-9A-F]{6}$/);
    names.add(name.toLowerCase());
    hexes.add(hex);
  }
  const json = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.deepEqual(json, colors);
  const byName = new Map(colors.map(([name, hex]) => [name, hex]));
  assert.equal(byName.get("White Blue"), "#CDD6DB");
  assert.equal(byName.get("Bubblegum"), "#FF85FF");
  assert.equal(byName.get("Stardew"), "#A6B2B5");
  assert.equal(byName.has("Gray"), false);
  assert.equal(byName.get("Grey"), "#808080");
});

test("a color matches itself at 100 and black versus white is below that", () => {
  assert.equal(colorSimilarity("#FFFFFF", "#ffffff"), 100);
  const far = colorSimilarity("#000000", "#FFFFFF");
  assert.equal(far < 100, true);
  assert.equal(far >= 0, true);
});

test("White Blue 90 and Bubblegum 90 at tolerance 8 match results.txt", () => {
  const { colors: pairs } = loadColors(sourceFiles);
  const colors = prepareCatalog(pairs);
  const nameToHex = nameToHexMap(colors);
  const guesses = { "White Blue": 90, Bubblegum: 90 };
  const tolerance = 8;

  assert.equal(fmt(Math.abs(colorSimilarity(nameToHex.get("stardew"), nameToHex.get("white blue")) - 90)), "0.40");
  assert.equal(fmt(Math.abs(colorSimilarity(nameToHex.get("stardew"), nameToHex.get("bubblegum")) - 90)), "3.42");

  let matches = findConsistentColors(guesses, tolerance, colors, nameToHex);
  matches = matches.filter((c) => !Object.hasOwn(guesses, c.name));
  matches.sort(byTotalDev);

  const expected = parseResults(fs.readFileSync(path.join(root, "reference", "results.txt"), "utf8"));
  assert.equal(expected.length, 10);
  const top = matches.slice(0, 10);
  assert.equal(top.length, 10);

  for (let i = 0; i < expected.length; i++) {
    const got = top[i];
    const want = expected[i];
    assert.equal(got.name, want.name, `rank ${i + 1} name`);
    assert.equal(got.hex, want.hex, `${want.name} hex`);
    assert.equal(fmt(got.totalDev), want.total, `${want.name} total`);
    for (const [guess, info] of Object.entries(want.deviations)) {
      assert.equal(nameToHex.get(guess.toLowerCase()), info.hex, `${guess} hex`);
      assert.equal(fmt(got.deviations[guess]), info.value, `${want.name} vs ${guess}`);
    }
  }

  assert.equal(top[0].name, "Stardew");
  assert.equal(fmt(top[0].deviations["White Blue"]), "0.40");
  assert.equal(fmt(top[0].deviations.Bubblegum), "3.42");
  assert.equal(fmt(top[0].totalDev), "3.83");
});

test("chunked scan keeps the same top 10 and drops guessed names", async () => {
  const { colors: pairs } = loadColors(sourceFiles);
  const colors = prepareCatalog(pairs);
  const nameToHex = nameToHexMap(colors);
  const guesses = { "White Blue": 90, Bubblegum: 90 };
  const specs = guessSpecs(guesses, nameToHex);
  const matches = await scanConsistentAsync(colors, specs, 8, {
    chunk: 7000,
    exclude: new Set(Object.keys(guesses)),
  });
  matches.sort(byTotalDev);
  const expected = parseResults(fs.readFileSync(path.join(root, "reference", "results.txt"), "utf8"));
  assert.deepEqual(
    matches.slice(0, 10).map((c) => c.name),
    expected.map((c) => c.name),
  );
  assert.equal(fmt(matches[0].totalDev), "3.83");
  assert.equal(matches.some((c) => c.name === "White Blue" || c.name === "Bubblegum"), false);
});

test("name lookup is case-insensitive for names and hex", () => {
  const { colors } = loadColors(sourceFiles);
  const index = buildNameIndex(colors);
  assert.equal(resolveColor(index, "white blue").name, "White Blue");
  assert.equal(resolveColor(index, "#cdd6db").hex, "#CDD6DB");
  assert.equal(resolveColor(index, "CDD6DB").name, "White Blue");
  assert.equal(resolveColor(index, "#abc").hex, "#AABBCC");
  assert.equal(resolveColor(index, "not a color"), null);
  const exact = suggestNames(index, "StArDew", 5);
  assert.equal(exact[0].name, "Stardew");
  assert.equal(exact[0].hex, "#A6B2B5");
  const mid = suggestNames(index, "ardew", 10);
  assert.equal(mid.some((item) => item.name === "Stardew"), true);
  assert.equal(suggestNames(index, "#a6b2b5", 5).length, 0);
  const prefixed = suggestNames(index, "star", 12);
  assert.equal(prefixed.length > 0, true);
  assert.equal(prefixed.every((item) => item.key.startsWith("star")), true);
});
