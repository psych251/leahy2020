#!/usr/bin/env node
/*
 * Combine two coders' graded (1-5) similarity ratings into the ratings.csv the report reads
 * (Phase 2). Each coder downloads ratings_<initials>.csv from coding/index.html and puts it in
 * data/coded/<experiment>/.
 *
 *   node scripts/reconcile-ratings.js --experiment leahy2020-phase2 --coders AB,CD
 *
 * Rule: the final rating of each concept is the mean of the two coders' ratings. A concept
 * only one coder has rated gets no final rating yet (the report treats it as not yet rated),
 * so both coders must rate every concept.
 *
 * Writes
 *   data/coded/<experiment>/ratings.csv    participant_id, sheet_number, similarity (final),
 *                                          rating_1, rating_2, flag
 * `flag` is 1 if either coder flagged the concept as illegible / uninterpretable.
 * Agreement between the coders is printed here; the report computes it again (with Cohen's κ).
 * Run it again whenever a coder's file changes: ratings.csv is rebuilt from the coders' files.
 */
const fs = require("fs");
const path = require("path");
const { parseCsv } = require("./csv");

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const experimentId = arg("experiment", null);
const coders = (arg("coders", "") || "").split(",").map((c) => c.trim()).filter(Boolean);
const force = process.argv.includes("--force");
if (!experimentId || coders.length !== 2) {
  console.error("Usage: node scripts/reconcile-ratings.js --experiment <id> --coders A,B");
  process.exit(1);
}

const root = path.join(__dirname, "..");
const dir = path.join(root, "data", "coded", experimentId);
const rel = (p) => path.relative(root, p);
const fileFor = (coder) => path.join(dir, "ratings_" + coder.replace(/[^A-Za-z0-9_-]/g, "") + ".csv");

function readCoder(coder) {
  const f = fileFor(coder);
  if (!fs.existsSync(f)) {
    console.error(`No ${rel(f)}. Each coder downloads ratings_<initials>.csv from the coding page into ${rel(dir)}/.`);
    process.exit(1);
  }
  const rows = parseCsv(fs.readFileSync(f, "utf8"));
  if (rows.length && !("similarity" in rows[0])) {
    console.error(`${rel(f)} has no 'similarity' column: it was coded on the similar / not similar scale.`);
    process.exit(1);
  }
  const out = new Map();
  for (const r of rows) {
    const v = r.similarity === "" ? null : Number(r.similarity);
    if (v !== null && !(Number.isInteger(v) && v >= 1 && v <= 5)) {
      console.error(`${rel(f)}: rating '${r.similarity}' for ${r.participant_id} sheet ${r.sheet_number} is not 1-5.`);
      process.exit(1);
    }
    out.set(r.participant_id + "\u0000" + r.sheet_number, { participant_id: r.participant_id,
      sheet_number: Number(r.sheet_number), v, flag: r.flag === "1" });
  }
  return out;
}

// Never overwrite a ratings.csv this script did not write (e.g. Phase 1's hand-reconciled file).
const outPath = path.join(dir, "ratings.csv");
if (fs.existsSync(outPath) && !force) {
  const header = fs.readFileSync(outPath, "utf8").split(/\r?\n/)[0];
  if (!header.split(",").includes("rating_1")) {
    console.error(`${rel(outPath)} exists and was not written by this script. Pass --force to replace it.`);
    process.exit(1);
  }
}

const [a, b] = coders.map(readCoder);
const keys = [...new Set([...a.keys(), ...b.keys()])];

const rows = [];
let both = 0, exact = 0, within1 = 0, nMissing = 0;
for (const k of keys) {
  const ra = a.get(k), rb = b.get(k);
  const base = ra || rb;
  const v1 = ra ? ra.v : null, v2 = rb ? rb.v : null;
  let final = null;
  if (v1 !== null && v2 !== null) {
    both++;
    if (v1 === v2) exact++;
    if (Math.abs(v1 - v2) <= 1) within1++;
    final = (v1 + v2) / 2;
  } else {
    nMissing++;
  }
  rows.push({ participant_id: base.participant_id, sheet_number: base.sheet_number, final, v1, v2,
              flag: [ra, rb].some((r) => r && r.flag) });
}
rows.sort((x, y) => x.participant_id.localeCompare(y.participant_id) || x.sheet_number - y.sheet_number);

const cell = (v) => (v === null || v === undefined ? "" : String(v));
fs.writeFileSync(outPath, ["participant_id,sheet_number,similarity,rating_1,rating_2,flag",
  ...rows.map((r) => [r.participant_id, r.sheet_number, cell(r.final), cell(r.v1), cell(r.v2), r.flag ? 1 : 0].join(","))]
  .join("\n") + "\n");

const pct = (n) => (both ? ((100 * n) / both).toFixed(0) + "%" : "n/a");
console.log(`Wrote ${rel(outPath)}.`);
console.log(`Concepts: ${keys.length}; rated by both coders: ${both}; missing a rating from one coder: ${nMissing}.`);
console.log(`Agreement (${coders.join(" vs ")}): exact ${pct(exact)}, within 1 point ${pct(within1)}.`);
if (nMissing > 0) console.log("Concepts missing a rating from either coder have no final rating until both have rated them.");
