// Rebuild src/colors.json in the same order and with the same dedupe as
// load_colors in reference/color-finder.pl:
// colornames.csv, then css-x11.csv, then extras.csv.
// A row is skipped when its lowercased name or its uppercased hex was already kept.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const sourceFiles = [
  path.join(root, "reference", "colornames.csv"),
  path.join(root, "reference", "css-x11.csv"),
  path.join(root, "reference", "extras.csv"),
];

export const outPath = path.join(root, "src", "colors.json");

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function addColorRows(colors, seenName, seenHex, csvText) {
  const rows = parseCsv(csvText);
  let added = 0;
  let skipped = 0;
  for (let i = 1; i < rows.length; i++) {
    const name = rows[i][0];
    const hex = rows[i][1];
    if (!name || !hex) continue;
    const lname = name.toLowerCase();
    const uhex = hex.toUpperCase();
    if (seenName.has(lname) || seenHex.has(uhex)) {
      skipped++;
      continue;
    }
    colors.push([name, uhex]);
    seenName.add(lname);
    seenHex.add(uhex);
    added++;
  }
  return { added, skipped };
}

export function loadColors(filenames) {
  const colors = [];
  const seenName = new Set();
  const seenHex = new Set();
  const stats = [];
  for (const filename of filenames) {
    const text = fs.readFileSync(filename, "utf8");
    const result = addColorRows(colors, seenName, seenHex, text);
    stats.push({ filename, ...result });
  }
  return { colors, stats };
}

function isMain() {
  const arg = process.argv[1];
  if (!arg) return false;
  return fileURLToPath(import.meta.url) === path.resolve(arg);
}

if (isMain()) {
  const { colors, stats } = loadColors(sourceFiles);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(colors) + "\n");
  for (const s of stats) {
    console.log(`${path.basename(s.filename)}: added ${s.added}, skipped ${s.skipped}`);
  }
  console.log(`Wrote ${colors.length} colors to ${path.relative(root, outPath)}`);
}
