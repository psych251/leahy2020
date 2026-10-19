#!/usr/bin/env node
/*
 * Write a blank ratings file for the coders, from an exported trials.csv.
 *
 *   node scripts/ratings-template.js --experiment leahy2020-pilot-a
 *   node scripts/ratings-template.js --experiment leahy2020-pilot-a --force   (overwrite)
 *
 * Reads   data/raw/<experiment>/trials.csv, participants.csv   (from `npm run export`)
 * Writes  data/coded/<experiment>/ratings.csv
 *
 * One row per brainstorm concept to be rated: the final version of each non-empty brainstorm
 * sheet (the highest `revision`, since sheets can be revisited and edited), for participants
 * who completed the study (the report never analyses the others). Columns:
 *   participant_id, sheet_number, similar
 * `similar` is left blank: fill in 1 (similar to that participant's initial concept) or 0.
 * This is the file writeup/replication-report.qmd reads. Condition and problem are left out
 * so the file itself does not tell the coders which group a participant was in.
 *
 * An existing ratings.csv is never overwritten without --force, so coding work is not lost.
 */
const fs = require("fs");
const path = require("path");

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const experimentId = arg("experiment", null);
const force = process.argv.includes("--force");
if (!experimentId) {
  console.error("Usage: node scripts/ratings-template.js --experiment <id> [--force]");
  process.exit(1);
}

const root = path.join(__dirname, "..");
const trialsPath = path.join(root, "data", "raw", experimentId, "trials.csv");
const participantsPath = path.join(root, "data", "raw", experimentId, "participants.csv");
const outDir = path.join(root, "data", "coded", experimentId);
const outPath = path.join(outDir, "ratings.csv");

if (!fs.existsSync(trialsPath) || !fs.existsSync(participantsPath)) {
  console.error(`No ${path.relative(root, trialsPath)} or participants.csv. Export first: npm run export -- --experiment ${experimentId} --key <path to your key>`);
  process.exit(1);
}
if (fs.existsSync(outPath) && !force) {
  console.error(`${path.relative(root, outPath)} already exists and may hold ratings. Pass --force to overwrite it.`);
  process.exit(1);
}

const { parseCsv } = require("./csv");

const trials = parseCsv(fs.readFileSync(trialsPath, "utf8"));
const completed = new Set(parseCsv(fs.readFileSync(participantsPath, "utf8"))
  .filter((p) => p.completed === "true").map((p) => p.participant_id));

// Final version of each brainstorm sheet: highest revision per participant and sheet number.
const final = new Map();
for (const t of trials) {
  if (t.task !== "concept_sheet" || t.phase !== "brainstorm" || !completed.has(t.participant_id)) continue;
  const key = t.participant_id + "\u0000" + t.sheet_number;
  const rev = Number(t.revision) || 1;
  if (!final.has(key) || rev > final.get(key).rev) final.set(key, { t, rev });
}
const concepts = [...final.values()]
  .map(({ t }) => t)
  .filter((t) => t.empty !== "true")
  .map((t) => ({ participant_id: t.participant_id, sheet_number: Number(t.sheet_number) }))
  .sort((a, b) => a.participant_id.localeCompare(b.participant_id) || a.sheet_number - b.sheet_number);

fs.mkdirSync(outDir, { recursive: true });
const lines = ["participant_id,sheet_number,similar", ...concepts.map((c) => `${c.participant_id},${c.sheet_number},`)];
fs.writeFileSync(outPath, lines.join("\n") + "\n");

const nParticipants = new Set(concepts.map((c) => c.participant_id)).size;
console.log(`Wrote ${path.relative(root, outPath)}: ${concepts.length} concepts from ${nParticipants} participants.`);
console.log("Fill in `similar` with 1 or 0 for every row. Rows left blank are treated as not yet rated.");
