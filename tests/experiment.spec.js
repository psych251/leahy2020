// End-to-end test: a robot participant runs the whole experiment.
//
// Two modes:
//   - Emulator mode (EMULATOR=1, set automatically by `npm test`): data must land in the
//     local Firestore emulator, the security rules must reject forbidden requests, and
//     client errors must be logged.
//   - Offline mode (plain `npx playwright test`): the experiment must still run to the end
//     and offer the JSON download fallback.
//
// If you change the timeline in experiment.js, update `runThroughExperiment` below so the
// robot still knows which buttons to press. That is a feature: the test documents the flow.

const { test, expect, devices } = require("@playwright/test");

const EMULATOR = process.env.EMULATOR === "1" || !!process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = "demo-psych251";
const EXPERIMENT_ID = "leahy2020-pilot-b";
const FS = `http://localhost:8080/v1/projects/${PROJECT}/databases/(default)/documents`;

// Draw one stroke across the sketch box of the current concept sheet.
async function sketch(page) {
  const canvas = page.locator("#concept-canvas");
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 90, { steps: 5 });
  await page.mouse.move(box.x + 200, box.y + 60, { steps: 5 });
  await page.mouse.up();
}

// Finish a concept phase early: the finish button asks for a second click to confirm.
async function finishPhase(page) {
  await page.locator("#concept-finish").click();
  await page.locator("#concept-finish").click();
}

// Moving to another sheet (a new one, or one picked from the "Go to" list) must not move the
// progress bar: only finishing a phase does.
async function switchSheet(page, action, n) {
  const bar = page.locator("#jspsych-progressbar-inner");
  const before = await bar.evaluate((el) => el.style.width);
  await action();
  await page.locator(`.concept-sheet[data-sheet="${n}"]`).waitFor();
  expect(await bar.evaluate((el) => el.style.width)).toBe(before);
}
const nextSheet = (page, n) =>
  switchSheet(page, () => page.getByRole("button", { name: "Save and start a new concept" }).click(), n);
const goToSheet = (page, n) =>
  switchSheet(page, () => page.locator("#concept-goto").selectOption(String(n)), n);

async function runThroughExperiment(page, { stopBeforeFinish = false } = {}) {
  // 1. consent
  await page.getByRole("button", { name: "I agree to participate" }).click();
  // 2. welcome (two pages)
  await page.locator("#jspsych-instructions-next").click();
  await page.locator("#jspsych-instructions-next").click();
  // 3. initial phase: the example (example condition) or an initial concept sheet (control)
  await page.locator(".example-sketch, #concept-canvas").first().waitFor();
  if (await page.locator(".example-sketch").count()) {
    await page.getByRole("button", { name: "Continue" }).click();
  } else {
    await sketch(page);
    await page.locator("#concept-description").fill("Robot initial cup: a lid that seals with a twist.");
    await finishPhase(page);
  }
  // 4-5. introductions to idea generation and brainstorming
  await page.getByRole("heading", { name: "Idea generation" }).waitFor();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Individual brainstorming" }).waitFor();
  await page.getByRole("button", { name: "Continue" }).click();
  // 6. practice: two sheets, after checking that an empty sheet cannot be saved
  await page.locator('.concept-sheet[data-sheet="1"]').waitFor();
  await page.getByRole("button", { name: "Save and start a new concept" }).click();
  await expect(page.locator("#concept-message")).toContainText("before starting a new one");
  await sketch(page);
  await nextSheet(page, 2);
  await page.locator("#concept-description").fill("A beanbag.");
  await finishPhase(page);
  // 7. brainstorm: instructions page, then two sheets
  await page.locator("#jspsych-instructions-next").click();
  await page.locator('.concept-sheet[data-sheet="1"]').waitFor();
  await sketch(page);
  await page.locator("#concept-description").fill("Robot concept 1: weighted base.");
  await nextSheet(page, 2);
  await page.locator("#concept-description").fill("Robot concept 2: gel that thickens when tipped.");
  // The list holds every concept, the current one selected; go back and edit concept 1, whose
  // sketch and description are restored.
  await expect(page.locator("#concept-goto option")).toHaveText(["Concept 1", "Concept 2 (this sheet)"]);
  await expect(page.locator("#concept-goto")).toHaveValue("2");
  await goToSheet(page, 1);
  await expect(page.locator("#concept-description")).toHaveValue("Robot concept 1: weighted base.");
  await page.locator("#concept-description").fill("Robot concept 1: weighted base. Edited.");
  await goToSheet(page, 2);
  await expect(page.locator("#concept-description")).toHaveValue("Robot concept 2: gel that thickens when tipped.");
  await finishPhase(page);
  // 8. debrief: every step but the debrief itself is done
  await page.getByRole("heading", { name: "Debrief" }).waitFor();
  const width = await page.locator("#jspsych-progressbar-inner").evaluate((el) => parseFloat(el.style.width));
  expect(width).toBeCloseTo((8 / 9) * 100, 0);
  if (stopBeforeFinish) return;
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(page.getByText("All done")).toBeVisible({ timeout: 30000 });
}

async function fsGet(path) {
  // "Bearer owner" is the emulator's admin token: it bypasses security rules, like the Admin SDK.
  const r = await fetch(`${FS}/${path}`, { headers: { Authorization: "Bearer owner" } });
  return { status: r.status, body: r.status === 200 ? await r.json() : null };
}

// Unwrap Firestore REST "fields" encoding into plain JS.
function decode(v) {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode);
  return v;
}
function decodeFields(fields) {
  const out = {};
  for (const k of Object.keys(fields)) out[k] = decode(fields[k]);
  return out;
}

test.describe("experiment", () => {
  test("runs to the end and saves data", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    await page.goto(EMULATOR ? "/?emulator=1&PROLIFIC_PID=robot123&STUDY_ID=s1&SESSION_ID=sess1" : "/");
    await page.waitForFunction(() => window.__saver && window.__saver.uid);
    const mode = await page.evaluate(() => window.__saver.mode);
    expect(mode).toBe(EMULATOR ? "emulator" : "offline");

    await runThroughExperiment(page);

    // No uncaught errors from the experiment itself.
    expect(consoleErrors, "uncaught page errors").toEqual([]);

    const uid = await page.evaluate(() => window.__saver.docId);
    const stats = await page.evaluate(() => window.__saver.stats);

    if (!EMULATOR) {
      // Offline: no counter to reach, so the cell is random; banner + download fallback.
      const a = await page.evaluate(() => window.__saver.allTrials.find((t) => t.task === "assignment"));
      expect(a.assignment_method).toBe("random_fallback");
      await expect(page.locator("#data-saver-banner")).toHaveAttribute("data-kind", "offline");
      await expect(page.locator("#data-saver-fallback")).toBeVisible();
      return;
    }

    expect(stats.writes_failed).toBe(0);
    await expect(page.locator("#data-saver-fallback")).toHaveCount(0);

    // Participant document is complete and carries condition + Prolific ids.
    const p = await fsGet(`experiments/${EXPERIMENT_ID}/participants/${uid}`);
    expect(p.status).toBe(200);
    const pdoc = decodeFields(p.body.fields);
    expect(pdoc.completed).toBe(true);
    expect(["example", "control"]).toContain(pdoc.condition);
    expect(["cup", "bike"]).toContain(pdoc.problem);
    // Balanced assignment: the cell is the one the shared counter's slot maps to.
    expect(pdoc.assignment_method).toBe("counter");
    expect(Number.isInteger(pdoc.assignment_index)).toBe(true);
    expect(await page.evaluate((i) => window.__cellFor(i), pdoc.assignment_index)).toEqual([pdoc.condition, pdoc.problem]);
    expect(pdoc.prolific_pid).toBe("robot123");
    expect(pdoc.n_trials).toBeGreaterThanOrEqual(10);
    expect(typeof pdoc.full_data).toBe("string");
    const full = JSON.parse(pdoc.full_data);
    expect(full.length).toBe(pdoc.n_trials);

    // One chunk per trial (chunk_size = 1), each carrying the trial data.
    const chunks = await fsGet(`experiments/${EXPERIMENT_ID}/participants/${uid}/trials?pageSize=500`);
    expect(chunks.status).toBe(200);
    const docs = (chunks.body.documents || []).map((d) => decodeFields(d.fields));
    expect(docs.length).toBe(pdoc.n_trials);
    const trials = docs.flatMap((d) => d.trials);
    const sheets = trials.filter((t) => t.task === "concept_sheet");
    // Brainstorm visits in order: 1 -> new 2 -> go to 1 -> go to 2 -> finish.
    const brainstorm = sheets.filter((t) => t.phase === "brainstorm").sort((a, b) => a.trial_index - b.trial_index);
    expect(brainstorm.map((t) => [t.sheet_number, t.revision, t.end_reason])).toEqual([
      [1, 1, "new_sheet"], [2, 1, "go_to"], [1, 2, "go_to"], [2, 2, "finished"],
    ]);
    expect(brainstorm.map((t) => t.go_to)).toEqual([null, 1, 2, null]);
    expect(brainstorm.map((t) => t.changed)).toEqual([true, true, true, false]);
    // Final version of each sheet = its highest revision.
    const final = {};
    for (const t of brainstorm) if (!final[t.sheet_number] || t.revision > final[t.sheet_number].revision) final[t.sheet_number] = t;
    expect(final[1].description).toBe("Robot concept 1: weighted base. Edited.");
    expect(final[1].n_strokes).toBe(1);                          // sketch restored on revisit
    expect(final[1].sketch).toMatch(/^data:image\/png;base64,/);
    expect(final[2].sketch).toBeNull();
    expect(final[2].description).toContain("Robot concept 2");
    expect(brainstorm.every((t) => t.empty === false && t.condition === pdoc.condition && t.problem === pdoc.problem)).toBe(true);
    expect(sheets.filter((t) => t.phase === "practice").length).toBe(2);
    if (pdoc.condition === "control") {
      const initial = sheets.filter((t) => t.phase === "initial");
      expect(initial.length).toBe(1);
      expect(initial[0].n_strokes).toBe(1);
      expect(trials.some((t) => t.task === "example_view")).toBe(false);
    } else {
      expect(trials.find((t) => t.task === "example_view").end_reason).toBe("finished");
      expect(sheets.some((t) => t.phase === "initial")).toBe(false);
    }
    for (const task of ["intro_idea_generation", "intro_brainstorming"]) {
      expect(trials.find((t) => t.task === task).end_reason).toBe("finished");
    }

    // Every trial row must carry the same participant id as its participant document,
    // otherwise trials.csv and participants.csv cannot be joined in the analysis.
    expect([...new Set(trials.map((t) => t.participant_id))]).toEqual([uid]);
  });

  test("chunked writes (chunk_size > 1) save every trial", async ({ page }) => {
    test.skip(!EMULATOR, "needs the Firestore emulator");
    // Forces example + bike rack; the next test forces control + cup, so both levels of both
    // factors are exercised whatever the random assignment does elsewhere.
    await page.goto("/?emulator=1&chunk_size=5&condition=example&problem=bike");
    await page.waitForFunction(() => window.__saver && window.__saver.uid);
    await runThroughExperiment(page);
    const uid = await page.evaluate(() => window.__saver.docId);
    const p = decodeFields((await fsGet(`experiments/${EXPERIMENT_ID}/participants/${uid}`)).body.fields);
    const chunks = await fsGet(`experiments/${EXPERIMENT_ID}/participants/${uid}/trials?pageSize=500`);
    const docs = (chunks.body.documents || []).map((d) => decodeFields(d.fields));
    expect([p.condition, p.problem]).toEqual(["example", "bike"]);
    expect(docs.length).toBe(Math.ceil(p.n_trials / 5));
    // Every trial the browser recorded is in some chunk. (trial_index can skip a number where a
    // conditional part of the timeline is skipped, e.g. the other condition's initial phase.)
    const indices = docs.flatMap((d) => d.trials).map((t) => t.trial_index).sort((a, b) => a - b);
    const recorded = await page.evaluate(() => window.__saver.allTrials.map((t) => t.trial_index));
    expect(indices).toEqual(recorded.sort((a, b) => a - b));
    expect(indices.length).toBe(p.n_trials);
  });

  test("phases end by themselves when time runs out, saving the sheet in progress", async ({ page }) => {
    test.skip(!EMULATOR, "needs the Firestore emulator");
    // time_scale shrinks every phase: 2-3 min -> under 1 s, 25 min -> ~4.5 s.
    await page.goto("/?emulator=1&condition=control&problem=cup&time_scale=0.003");
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    await page.getByRole("button", { name: "I agree to participate" }).click();
    await page.locator("#jspsych-instructions-next").click();
    await page.locator("#jspsych-instructions-next").click();
    // Initial sheet, both introductions and practice all time out untouched.
    await page.getByRole("heading", { name: "Design problem" }).waitFor({ timeout: 20000 });
    await page.locator("#jspsych-instructions-next").click();
    await sketch(page);
    await page.locator("#concept-description").fill("Unfinished idea");
    // The brainstorm times out with the sheet still open.
    await page.getByRole("heading", { name: "Debrief" }).waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "Finish" }).click();
    await expect(page.getByText("All done")).toBeVisible({ timeout: 30000 });

    const uid = await page.evaluate(() => window.__saver.docId);
    const chunks = await fsGet(`experiments/${EXPERIMENT_ID}/participants/${uid}/trials?pageSize=500`);
    const trials = (chunks.body.documents || []).map((d) => decodeFields(d.fields)).flatMap((d) => d.trials);
    const byPhase = (phase) => trials.filter((t) => t.task === "concept_sheet" && t.phase === phase);
    // The consent row is saved before assignment; every row from the assignment on has the cell.
    const fromAssignment = trials.slice(trials.findIndex((t) => t.task === "assignment"));
    expect(fromAssignment.every((t) => t.condition === "control" && t.problem === "cup")).toBe(true);
    expect(fromAssignment[0].assignment_method).toBe("forced_test");
    expect(byPhase("initial").map((t) => [t.end_reason, t.empty])).toEqual([["time_up", true]]);
    expect(byPhase("practice").map((t) => [t.end_reason, t.empty])).toEqual([["time_up", true]]);
    for (const task of ["intro_idea_generation", "intro_brainstorming"]) {
      const row = trials.find((t) => t.task === task);
      expect(row.end_reason).toBe("time_up");
      expect(row.response).toBeNull();
    }
    const last = byPhase("brainstorm");
    expect(last.length).toBe(1);
    expect(last[0].end_reason).toBe("time_up");
    expect(last[0].empty).toBe(false);
    expect(last[0].n_strokes).toBe(1);
    expect(last[0].description).toBe("Unfinished idea");
  });

  test("the shared counter gives every block of four participants all four cells", async ({ browser }) => {
    test.skip(!EMULATOR, "needs the Firestore emulator");
    test.setTimeout(120000);
    // Eight participants in a row, each in a fresh browser (a new anonymous uid). Other tests
    // also use the counter, but eight consecutive slots always contain one whole block.
    const got = [];
    for (let i = 0; i < 8; i++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto("http://localhost:8017/?emulator=1");
      await page.waitForFunction(() => window.__saver && window.__saver.docId);
      await page.getByRole("button", { name: "I agree to participate" }).click();
      await page.locator("#jspsych-instructions-next").waitFor();   // assignment done
      await page.evaluate(() => window.__saver._settle());
      const docId = await page.evaluate(() => window.__saver.docId);
      const pdoc = decodeFields((await fsGet(`experiments/${EXPERIMENT_ID}/participants/${docId}`)).body.fields);
      expect(pdoc.assignment_method).toBe("counter");
      got.push({ index: pdoc.assignment_index, cell: pdoc.condition + "/" + pdoc.problem,
                 expected: (await page.evaluate((n) => window.__cellFor(n), pdoc.assignment_index)).join("/") });
      await context.close();
    }
    const indices = got.map((g) => g.index);
    expect(new Set(indices).size).toBe(8);                          // no slot handed out twice
    expect(Math.max(...indices) - Math.min(...indices)).toBe(7);    // consecutive slots
    for (const g of got) expect(g.cell).toBe(g.expected);
    const start = Math.ceil(Math.min(...indices) / 4) * 4;          // first whole block
    const block = got.filter((g) => g.index >= start && g.index < start + 4).map((g) => g.cell);
    expect(new Set(block)).toEqual(new Set(["example/cup", "example/bike", "control/cup", "control/bike"]));
  });

  test("declining consent ends the study without a thank-you-for-your-data message", async ({ page }) => {
    await page.goto(EMULATOR ? "/?emulator=1" : "/");
    await page.waitForFunction(() => window.__saver && window.__saver.uid);
    await page.getByRole("button", { name: "I do not agree" }).click();
    await expect(page.getByText("You chose not to participate")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Your responses were saved")).toHaveCount(0);
  });

  test("losing the connection at the end offers the download fallback instead of hanging", async ({ page, context }) => {
    test.skip(!EMULATOR, "needs the Firestore emulator");
    test.setTimeout(120000);
    // Run the real flow up to the last click, then cut the connection before "Finish".
    await page.goto("/?emulator=1");
    await page.waitForFunction(() => window.__saver && window.__saver.uid);
    await runThroughExperiment(page, { stopBeforeFinish: true });
    await context.setOffline(true);
    await page.getByRole("button", { name: "Finish" }).click();
    await expect(page.locator("#data-saver-fallback")).toBeVisible({ timeout: 40000 });
    await expect(page.getByText("connection to the server was lost")).toBeVisible();
    await expect(page.getByText("Your responses were saved")).toHaveCount(0);
    await context.setOffline(false);
  });

  test("a second run in the same browser is a new participant and saves cleanly", async ({ page }) => {
    test.skip(!EMULATOR, "needs the Firestore emulator");
    test.setTimeout(120000);

    const ids = [];
    for (let run = 0; run < 2; run++) {
      // Same page/context both times: the anonymous auth session persists, exactly as it
      // does for a student testing twice in one browser or a participant who reloads.
      await page.goto("/?emulator=1&PROLIFIC_PID=rerun" + run);
      await page.waitForFunction(() => window.__saver && window.__saver.docId);
      await runThroughExperiment(page);
      const info = await page.evaluate(() => ({
        uid: window.__saver.uid, docId: window.__saver.docId, stats: window.__saver.stats,
      }));
      expect(info.stats.writes_failed, "run " + run + " had failed writes").toBe(0);
      await expect(page.locator("#data-saver-fallback")).toHaveCount(0);
      ids.push(info);
    }

    expect(ids[0].uid).toBe(ids[1].uid);          // same browser, same anonymous identity
    expect(ids[0].docId).not.toBe(ids[1].docId);  // but a separate participant record

    // Both runs survive intact, with their own Prolific id and their own trials.
    for (let run = 0; run < 2; run++) {
      const p = await fsGet(`experiments/${EXPERIMENT_ID}/participants/${ids[run].docId}`);
      expect(p.status).toBe(200);
      const pdoc = decodeFields(p.body.fields);
      expect(pdoc.completed, "run " + run + " completed").toBe(true);
      expect(pdoc.prolific_pid).toBe("rerun" + run);
      const chunks = await fsGet(`experiments/${EXPERIMENT_ID}/participants/${ids[run].docId}/trials?pageSize=500`);
      expect((chunks.body.documents || []).length).toBe(pdoc.n_trials);
    }
  });

  test("setting a Prolific completion code does not break the test run", async ({ page }) => {
    // Regression test for the failure students hit right before launch: with a completion
    // code set, the live page redirects to Prolific, but a test run must stay put so that
    // `npm test` and CI keep passing.
    const navigations = [];
    page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });

    await page.goto(EMULATOR ? "/?emulator=1&cc=QA123CODE" : "/?cc=QA123CODE");
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    await runThroughExperiment(page);

    expect(navigations.some((u) => u.includes("prolific.com")), "must not navigate to Prolific").toBe(false);
    if (EMULATOR) await expect(page.getByText("QA123CODE")).toBeVisible();
  });

  test("phones and tablets are turned away before consent", async ({ browser }) => {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await context.newPage();
    await page.goto("http://localhost:8017/?emulator=1");
    await expect(page.locator("#device-unsupported")).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole("button", { name: "I agree to participate" })).toHaveCount(0);

    if (EMULATOR) {
      // The turned-away visit is still recorded, so phone traffic is visible in the data.
      await page.waitForFunction(() => window.__saver && window.__saver.docId);
      const docId = await page.evaluate(() => window.__saver.docId);
      await page.evaluate(() => window.__saver._settle());
      const p = await fsGet(`experiments/${EXPERIMENT_ID}/participants/${docId}`);
      const pdoc = decodeFields(p.body.fields);
      expect(pdoc.device_supported).toBe(false);
      expect(pdoc.completed).toBe(false);
    }
    await context.close();
  });

  test("a desktop browser is not turned away", async ({ page }) => {
    await page.goto(EMULATOR ? "/?emulator=1" : "/");
    await expect(page.getByRole("button", { name: "I agree to participate" })).toBeVisible();
    await expect(page.locator("#device-unsupported")).toHaveCount(0);
  });

  test("a write the database refuses is announced on the page, not only in the console", async ({ page }) => {
    test.skip(!EMULATOR, "needs the Firestore emulator");
    // Regression test for the state a student is in when they skip publishing the rules, or
    // once test-mode rules expire: sign-in succeeds, so the page used to look perfectly
    // healthy from consent to debrief and only admitted the problem on the last screen.
    await page.goto("/?emulator=1");
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    // Emulator runs carry an informational banner; what must be absent is a failure banner.
    await expect(page.locator('#data-saver-banner[data-kind="offline"]')).toHaveCount(0);

    // Force a genuine permission-denied on a normal save path by aiming the participant
    // document at someone else's id, which the rules refuse exactly as deny-all rules would.
    await page.evaluate(async () => {
      window.__saver.docId = "someone-else-deadbeef";
      await window.__saver.updateParticipant({ blocked: true });
    });

    const banner = page.locator("#data-saver-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("data-kind", "offline");
    await expect(banner).toContainText("NOT being saved");
    await expect(banner).toContainText("permission-denied");
    await expect(banner).toContainText("2.3");
    expect(await page.evaluate(() => window.__saver.stats.writes_failed)).toBeGreaterThan(0);
  });

  test("the download fallback tells the participant where to send the file", async ({ page }) => {
    await page.goto(EMULATOR ? "/?emulator=1" : "/");
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    await page.evaluate(() => window.__saver._offerDownload(null, "[]"));
    const box = page.locator("#data-saver-fallback");
    await expect(box).toBeVisible();
    await expect(box).toContainText("@");                       // a contact address is present
    await expect(box).toContainText("you will be paid");
    await expect(box.getByRole("link")).toHaveAttribute("href", /^mailto:/);
  });

  test("security rules reject reads and writes to other participants", async ({ page }) => {
    test.skip(!EMULATOR, "needs the Firestore emulator");
    await page.goto("/?emulator=1");
    await page.waitForFunction(() => window.__saver && window.__saver.uid);

    const results = await page.evaluate(async () => {
      const s = window.__saver;
      const fb = s.fb;
      const out = {};
      const attempt = async (name, fn) => {
        try { await fn(); out[name] = "allowed"; } catch (e) { out[name] = e.code || e.message; }
      };
      await attempt("read own doc", () =>
        fb.getDoc(fb.doc(s.db, "experiments", s.opts.experiment_id, "participants", s.docId)));
      await attempt("write other participant", () =>
        fb.setDoc(fb.doc(s.db, "experiments", s.opts.experiment_id, "participants", "someone-else"), { hacked: true }));
      await attempt("write other participant trials", () =>
        fb.setDoc(fb.doc(s.db, "experiments", s.opts.experiment_id, "participants", "someone-else", "trials", "c0"), { trials: [] }));
      await attempt("write unrelated collection", () =>
        fb.setDoc(fb.doc(s.db, "spam", "doc"), { spam: true }));
      await attempt("error doc with wrong uid", () =>
        fb.addDoc(fb.collection(s.db, "experiments", s.opts.experiment_id, "errors"), { uid: "not-me", message: "x" }));
      await attempt("own chunk (should be allowed)", () =>
        fb.setDoc(fb.doc(s.db, "experiments", s.opts.experiment_id, "participants", s.docId, "trials", "chunk-test"), { trials: [{ a: 1 }] }));
      await attempt("participant doc without the run suffix", () =>
        fb.setDoc(fb.doc(s.db, "experiments", s.opts.experiment_id, "participants", s.uid), { sneaky: true }));
      await attempt("another browser's run id", () =>
        fb.setDoc(fb.doc(s.db, "experiments", s.opts.experiment_id, "participants", "someone-else-abcd1234"), { sneaky: true }));
      // The assignment counter: readable, and movable forward by exactly one, nothing else.
      const counter = fb.doc(s.db, "experiments", s.opts.experiment_id, "assignment", "counter");
      await attempt("counter: take a slot (should be allowed)", () => s.nextAssignmentIndex().then((i) => { if (i === null) throw new Error("no slot"); }));
      let n = null;
      await attempt("counter: read (should be allowed)", async () => { n = (await fb.getDoc(counter)).data().n; });
      await attempt("counter: jump ahead", () => fb.setDoc(counter, { n: n + 5 }));
      await attempt("counter: move back", () => fb.setDoc(counter, { n: n - 1 }));
      await attempt("counter: extra field", () => fb.setDoc(counter, { n: n + 1, note: "x" }));
      await attempt("counter: non-integer", () => fb.setDoc(counter, { n: n + 0.5 }));
      await attempt("counter: another document", () => fb.setDoc(fb.doc(s.db, "experiments", s.opts.experiment_id, "assignment", "other"), { n: 1 }));
      return out;
    });

    expect(results["read own doc"]).toBe("permission-denied");
    expect(results["write other participant"]).toBe("permission-denied");
    expect(results["write other participant trials"]).toBe("permission-denied");
    expect(results["write unrelated collection"]).toBe("permission-denied");
    expect(results["error doc with wrong uid"]).toBe("permission-denied");
    expect(results["own chunk (should be allowed)"]).toBe("allowed");
    expect(results["participant doc without the run suffix"]).toBe("permission-denied");
    expect(results["another browser's run id"]).toBe("permission-denied");
    expect(results["counter: take a slot (should be allowed)"]).toBe("allowed");
    expect(results["counter: read (should be allowed)"]).toBe("allowed");
    for (const k of ["counter: jump ahead", "counter: move back", "counter: extra field", "counter: non-integer", "counter: another document"]) {
      expect(results[k], k).toBe("permission-denied");
    }
  });

  test("uncaught errors are logged to the errors collection", async ({ page }) => {
    test.skip(!EMULATOR, "needs the Firestore emulator");
    await page.goto("/?emulator=1");
    await page.waitForFunction(() => window.__saver && window.__saver.uid);
    const uid = await page.evaluate(() => window.__saver.uid);

    // Simulate a bug in a trial: an uncaught exception.
    await page.evaluate(() => {
      setTimeout(() => { throw new Error("simulated bug in trial code"); }, 0);
    });
    await page.waitForFunction(() => window.__saver.stats.errors_logged >= 1);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));

    const errs = await fsGet(`experiments/${EXPERIMENT_ID}/errors?pageSize=100`);
    const mine = (errs.body.documents || []).map((d) => decodeFields(d.fields)).filter((d) => d.uid === uid);
    expect(mine.length).toBe(1);
    expect(mine[0].message).toContain("simulated bug");
    expect(mine[0].context.kind).toBe("uncaught");
  });
});
