/*
 * Leahy, Daly, McKilligan & Seifert (2020), "Design fixation from initial examples: provided
 * versus self-generated ideas", Journal of Mechanical Design. Replication of Hypothesis 1
 * (providing an example leads to more fixation), both design problems, as in the original.
 *
 * Design summary
 *   IVs:       2 x 2 between subjects, each factor assigned at random:
 *              fixation source (`condition`):
 *                "example" = problem + the Jansson & Smith (1991) example and its flaws;
 *                "control" = problem only, participant sketches their own initial concept;
 *              design problem (`problem`): "cup" (no-spill cup) or "bike" (car bike rack).
 *   DV:        fixation = share of brainstormed concepts that coders rate "similar" to the
 *              participant's initial concept (the example, or their own initial sheet). Coded
 *              afterwards from rows with task "concept_sheet" and phase "brainstorm":
 *              fields `sketch` (PNG data URL), `description`, `sheet_number`. Fluency is the
 *              number of non-empty brainstorm sheets (`empty` false). Participants can go back
 *              and edit earlier sheets, so a sheet can have several rows (`revision` 1, 2, ...);
 *              the row with the highest `revision` for each `sheet_number` is the final version.
 *   Structure: consent, welcome, initial phase (3 min: view example / draw initial concept),
 *              intro to idea generation (2 min), intro to brainstorming (2 min), practice
 *              "design a seating device" (3 min), brainstorm the assigned problem (25 min), debrief.
 *              Shorter than the original's 6 / 3 / 3 / 3 / 30 min (Leahy et al., 2020, Fig. 4).
 *              Every phase is a maximum: a countdown shows the time left, the participant can
 *              move on early, and the phase ends by itself when time is up (`end_reason`).
 *   Assignment: balanced. After consent, each participant takes the next slot of a shared
 *              counter in Firestore (DataSaver.nextAssignmentIndex), and slots map to the four
 *              cells in shuffled blocks of four (cellFor), so every four consecutive participants
 *              cover all four cells. If the counter cannot be reached, the cell is random.
 *              Recorded as `assignment_method` ("counter" | "random_fallback" | "forced_test")
 *              and `assignment_index` (the slot) on the participant document.
 *   Exclusion: not yet decided (see the report's analysis plan). No attention check.
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
window.TEMPLATE_VERSION = "0.1.0";

const EXPERIMENT = {
  // Firestore path: experiments/<id>/participants/... Change it when you start a new study
  // so pilot data and real data never mix (e.g. "smith2016-pilot-a", "smith2016-final").
  id: "leahy2020-pilot-a",

  // Trials per Firestore write. 1 = save every trial the moment it finishes (dropouts leave
  // partial data). The free tier allows 20,000 writes/day: with 200 participants x 100 trials
  // you would exceed it, so raise this for long trial-based tasks (e.g. 20).
  chunk_size: 1,

  // Also store the complete jsPsych dataset on the participant document at the end.
  // Costs one extra write and makes export robust; turn off if trials are very large.
  save_full_data_at_end: true,

  // Prolific: if set, participants are redirected to Prolific when they finish.
  // Leave empty for local testing or non-Prolific samples.
  prolific_completion_code: "CYVQ7HUS",

  // Contact shown in consent and debrief.
  contact_email: "stanfordpsych251@gmail.com",

  // Does this study need a physical keyboard? Yes: participants type a description of every
  // concept for up to 40 minutes and sketch with a mouse or trackpad. When true, phones and
  // tablets are turned away before consent.
  requires_keyboard: true,

  // Maximum length of each phase, in minutes. Shortened from the original's 6 / 3 / 3 / 3 / 30
  // (Leahy et al., 2020, Fig. 4). The initial phase is the same length in both conditions:
  // viewing the example, or sketching one's own initial concept. Participants may
  // move on earlier.
  minutes: {
    initial: 3,
    intro_idea_generation: 2,
    intro_brainstorming: 2,
    practice: 3,
    brainstorm: 25,
  },
};

// True on anything with a mouse, trackpad, or stylus, including laptops with touchscreens.
// False on phones and tablets without a pointing device, which are also the devices with no
// physical keyboard. See docs/student-guide.md "Devices".
function hasFinePointer() {
  return !!(
    window.matchMedia && window.matchMedia("(any-pointer: fine)").matches
  );
}

// `?emulator=1` in the URL sends data to the local emulator instead of the real project.
// Used by `npm test`; handy for development too (start it with `npm run emulators`).
const URL_PARAMS = new URLSearchParams(window.location.search);
const USE_EMULATOR = URL_PARAMS.get("emulator") === "1";
// `?chunk_size=N` overrides the setting above; used by the test suite to exercise chunked writes.
const CHUNK_SIZE =
  Number(URL_PARAMS.get("chunk_size")) || EXPERIMENT.chunk_size;
// Test-only: `?cc=CODE` sets a Prolific completion code during emulator runs, so the test
// suite can check the screen a participant sees once you have set yours. Ignored in live runs.
if (USE_EMULATOR && URL_PARAMS.get("cc"))
  EXPERIMENT.prolific_completion_code = URL_PARAMS.get("cc");
// Test-only: `?time_scale=0.01` shrinks every phase, and `?condition=example|control` and
// `?problem=cup|bike` force the assignment, so the test suite can reach the time limits and
// every cell. Ignored in live runs.
const TIME_SCALE = (USE_EMULATOR && Number(URL_PARAMS.get("time_scale"))) || 1;
const FORCED_CONDITION = USE_EMULATOR ? URL_PARAMS.get("condition") : null;
const FORCED_PROBLEM = USE_EMULATOR ? URL_PARAMS.get("problem") : null;

// ---------------------------------------------------------------------------
// Boot: connect the saver first so even a crash in the first trial gets logged.
// ---------------------------------------------------------------------------
(async function main() {
  const deviceSupported = !EXPERIMENT.requires_keyboard || hasFinePointer();

  const saver = await DataSaver.init({
    experiment_id: EXPERIMENT.id,
    chunk_size: CHUNK_SIZE,
    save_full_data_at_end: EXPERIMENT.save_full_data_at_end,
    use_emulator: USE_EMULATOR,
    contact_email: EXPERIMENT.contact_email,
  });
  window.__saver = saver; // for debugging and the automated test

  // Record the device verdict on the participant document before anything else, so a
  // participant turned away below is still visible in the data rather than simply absent.
  saver.updateParticipant({
    device_supported: deviceSupported,
    requires_keyboard: EXPERIMENT.requires_keyboard,
  });

  if (!deviceSupported) {
    document.body.innerHTML =
      '<div id="device-unsupported" class="jspsych-content" style="max-width:640px;margin:15vh auto;font:16px/1.6 system-ui,sans-serif;">' +
      "<h2>Please use a computer</h2>" +
      "<p>This study needs a computer with a physical keyboard and a mouse or trackpad, because " +
      "you will type descriptions and sketch ideas. Phones and tablets cannot be used.</p>" +
      "<p>Please reopen this link on a laptop or desktop computer. If you were sent here from " +
      "Prolific, you can return the study and take it later on a computer; nothing has been recorded " +
      "against you.</p>" +
      '<p>Questions: <a href="mailto:' +
      EXPERIMENT.contact_email +
      '">' +
      EXPERIMENT.contact_email +
      "</a></p></div>";
    return;
  }

  // Progress steps: consent, welcome, initial phase, the two introductions, practice, the
  // brainstorm instructions, brainstorm, debrief.
  const N_STEPS = 9;
  let stepsDone = 0;

  const jsPsych = initJsPsych({
    show_progress_bar: true,
    // Updated by hand: the bar moves one step per part of the study, so moving between concept
    // sheets does not move it (a brainstorm can have any number of sheets).
    auto_update_progress_bar: false,
    on_trial_finish: (data) => {
      // Moving between concept sheets (new sheet, go to another) is not progress through the
      // study, and neither is the moment's wait while the condition is assigned.
      if (data.task === "assignment") return;
      if (
        data.task === "concept_sheet" &&
        !["finished", "time_up"].includes(data.end_reason)
      )
        return;
      stepsDone += 1;
      jsPsych.progressBar.progress = Math.min(1, stepsDone / N_STEPS);
    },
    on_data_update: (trial) => saver.onTrial(trial),
    on_finish: async () => {
      const el = jsPsych.getDisplayElement();
      el.innerHTML =
        '<div id="finish-message"><p class="thanks">Saving your responses…</p></div>';
      // finish() flushes remaining trials, marks the participant complete, and (only if
      // saving failed) appends a download-fallback box to the display element.
      const result = await saver.finish(jsPsych);
      const consentRow = jsPsych.data
        .get()
        .filter({ task: "consent" })
        .values()[0];
      const consented = !consentRow || consentRow.consented !== false;
      const msg = document.getElementById("finish-message");

      if (!consented) {
        msg.innerHTML =
          "<h2 class='thanks'>Thank you</h2><p class='thanks'>You chose not to participate. " +
          "You may close this window" +
          (EXPERIMENT.prolific_completion_code
            ? " and return the study on Prolific"
            : "") +
          ".</p>";
        return;
      }
      if (result.ok && EXPERIMENT.prolific_completion_code && !USE_EMULATOR) {
        msg.innerHTML =
          "<p class='thanks'>Saved. Returning you to Prolific…</p>";
        window.location.href =
          "https://app.prolific.com/submissions/complete?cc=" +
          EXPERIMENT.prolific_completion_code;
        return;
      }
      // In emulator/test runs we stay on the page instead of navigating to Prolific, so that
      // setting a completion code can never turn `npm test` or CI red. Live runs redirect above.
      msg.innerHTML =
        "<h2 class='thanks'>All done</h2>" +
        (result.ok
          ? "<p class='thanks'>Your responses were saved. Thank you for participating!</p>"
          : "") +
        (EXPERIMENT.prolific_completion_code
          ? "<p class='thanks'>Your completion code is <strong>" +
            EXPERIMENT.prolific_completion_code +
            "</strong>.</p>"
          : "");
    },
  });

  // Record the participant id and URL parameters on every trial row.
  jsPsych.data.addProperties({
    // Must be the run-scoped document id, so trial rows join to participants.csv on export.
    participant_id: saver.docId,
    prolific_pid: saver.params.PROLIFIC_PID || null,
    experiment_id: EXPERIMENT.id,
  });

  // Fixation source x design problem, assigned right after consent (see `assignment` below),
  // so that participants turned away or declining never use up a slot.
  const assigned = { condition: null, problem: null };

  const phaseMs = (name) => EXPERIMENT.minutes[name] * 60000 * TIME_SCALE;

  // Materials, quoted from Leahy et al. (2020), Materials; problems and example sketches from
  // Jansson & Smith (1991), Fig. 1 of the paper.
  const PROBLEMS = {
    cup: {
      text:
        "Design a disposable, spill-proof coffee cup. The design should be operable with one " +
        "hand, durable and should not include a mouthpiece or straw.",
      example_text:
        "Below is an example of a spill proof coffee cup. Please note, the straw will " +
        "leak when the cup is rotated 90 deg from the angle shown. The cup will leak if " +
        "squeezed and the hot liquid emerging from the straw will burn one's mouth.",
      image: "stimuli/example_cup.png",
      alt:
        "Example sketch: a styrofoam coffee cup with a plastic top and a tube running from " +
        "inside the cup to a mouthpiece",
    },
    bike: {
      text:
        "Design a car-mounted bicycle rack that addresses the following needs: (1) Easy " +
        "mounting of the bicycle, (2) Easy mounting of the rack, (3) Cannot harm bike or car, " +
        "and (4) Must be versatile for all bikes and cars.",
      example_text:
        "Below is an example of a present day bike rack. The bicycle is set in the " +
        "rails and the vinyl coated hook is attached to the seat tube of the bike, and then the " +
        "hook is tightened down by hand with a wing nut. One should note the difficulty of " +
        "mounting the middle bikes on the rack.",
      image: "stimuli/example_bike_rack.png",
      alt:
        "Example sketch: a roof rack with rails across a car roof and upright hooks holding " +
        "bicycles by the seat tube",
    },
  };
  // The assigned problem's materials. Functions, because the cell is only known after consent;
  // jsPsych evaluates them when each trial starts.
  const P = () => PROBLEMS[assigned.problem];
  const problemBox = () =>
    `<div class="design-problem"><strong>Design problem:</strong> ${P().text}</div>`;

  // Balanced assignment. Slot i of the shared counter maps to a cell: slots come in blocks of
  // four, each block holding all four cells in an order shuffled by a seed made from the
  // experiment id and the block number, so the sequence is reproducible from the data but not
  // a fixed rotation.
  const CELLS = [
    ["example", "cup"],
    ["example", "bike"],
    ["control", "cup"],
    ["control", "bike"],
  ];
  function cellFor(index) {
    let h = 2166136261;
    for (const ch of EXPERIMENT.id + ":" + Math.floor(index / 4))
      h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    const rand = () =>
      ((h =
        Math.imul(h ^ (h >>> 15), 2246822507) ^
        Math.imul(h ^ (h >>> 13), 3266489909)) >>>
        0) /
      4294967296;
    const order = CELLS.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order[index % 4];
  }
  window.__cellFor = cellFor; // for the automated test

  // -------------------------------------------------------------------------
  // 1. Consent (course-wide IRB text; edit only the contact address)
  // -------------------------------------------------------------------------
  const consent = {
    type: jsPsychHtmlButtonResponse,
    stimulus: `
      <div class="consent">
        <h2>Consent</h2>
        <p>By answering the following questions, you are participating in a study being performed by
        cognitive scientists in the Stanford Department of Psychology. If you have questions about
        this research, please contact us at <a href="mailto:${EXPERIMENT.contact_email}">${EXPERIMENT.contact_email}</a>.
        You must be at least 18 years old to participate. Your participation in this research is
        voluntary. You may decline to answer any or all of the following questions. You may decline
        further participation, at any time, without adverse consequences. Your anonymity is assured;
        the researchers who have requested your participation will not receive any personal
        information about you.</p>
      </div>`,
    choices: ["I agree to participate", "I do not agree"],
    data: { task: "consent" },
    on_finish: (data) => {
      data.consented = data.response === 0;
      if (!data.consented) {
        // No end message here: jsPsych would paint it over the screen that on_finish renders.
        jsPsych.abortExperiment();
      }
    },
  };

  // Takes the next counter slot (a moment's wait on a "Loading" screen) and records the cell.
  const assignment = {
    type: jsPsychHtmlKeyboardResponse,
    stimulus: '<p class="thanks">Loading…</p>',
    choices: "NO_KEYS",
    data: { task: "assignment" },
    on_load: async () => {
      let method,
        index = null,
        cell;
      if (
        ["example", "control"].includes(FORCED_CONDITION) &&
        ["cup", "bike"].includes(FORCED_PROBLEM)
      ) {
        method = "forced_test";
        cell = [FORCED_CONDITION, FORCED_PROBLEM];
      } else {
        index = await saver.nextAssignmentIndex();
        if (index === null) {
          method = "random_fallback";
          cell = jsPsych.randomization.sampleWithoutReplacement(CELLS, 1)[0];
        } else {
          method = "counter";
          cell = cellFor(index);
        }
      }
      [assigned.condition, assigned.problem] = cell;
      jsPsych.data.addProperties({
        condition: assigned.condition,
        problem: assigned.problem,
      });
      saver.updateParticipant({
        condition: assigned.condition,
        problem: assigned.problem,
        assignment_method: method,
        assignment_index: index,
      });
      // Fetch the example image now, so it is on screen the moment the example phase starts.
      if (assigned.condition === "example") new Image().src = P().image;
      jsPsych.finishTrial({
        assignment_method: method,
        assignment_index: index,
      });
    },
  };

  // -------------------------------------------------------------------------
  // 2. Welcome
  // -------------------------------------------------------------------------
  const instructions = {
    type: jsPsychInstructions,
    pages: [
      `<h2>Welcome</h2>
       <p>In this study you will work on an engineering design problem on your own. You will
       sketch and describe design ideas on "concept sheets" in your browser. It takes up to
       about 40 minutes.</p>`,
      `<p>Each part of the study has a time limit, shown at the top of the screen. When the time
       is up, the study moves on automatically. You may also move on before the time is up.</p>
       <p>Please complete the study in one sitting, in a quiet place, on a laptop or desktop
       computer with a mouse or trackpad. Use the buttons or the arrow keys to move between pages.</p>`,
    ],
    show_clickable_nav: true,
    data: { task: "instructions" },
  };

  // A page with a countdown that ends by itself after `ms`, or earlier when the participant
  // clicks the button. Records end_reason "time_up" or "finished".
  function timedPage(task, ms, html, button) {
    let interval = null;
    return {
      type: jsPsychHtmlButtonResponse,
      stimulus: () =>
        `<div class="concept-timer" id="page-timer" aria-live="polite"></div>${typeof html === "function" ? html() : html}`,
      choices: [button],
      trial_duration: ms,
      data: { task: task },
      on_load: () => {
        const endAt = Date.now() + ms;
        const el = document.getElementById("page-timer");
        const tick = () => {
          const s = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
          el.textContent =
            "Time remaining: " +
            Math.floor(s / 60) +
            ":" +
            String(s % 60).padStart(2, "0");
          el.classList.toggle("warning", s <= 60);
        };
        tick();
        interval = setInterval(tick, 250);
      },
      on_finish: (data) => {
        clearInterval(interval);
        data.end_reason = data.response === null ? "time_up" : "finished";
      },
    };
  }

  // A phase of concept sheets that share one deadline: the participant fills a sheet, saves
  // it and starts the next, and can switch to any sheet from the "Go to" list, until they finish the phase
  // or time runs out. Each visit to a sheet is one trial (a new `revision` of that sheet), so
  // nothing is lost if they leave mid-phase; the last revision of each sheet is its final version.
  function conceptPhase(phase, ms, header, opts = {}) {
    // sheets[i] holds what sheet i+1 contains, so it can be restored when revisited.
    const state = {
      deadline: null,
      sheets: [{ strokes: [], description: "", visits: 0 }],
      current: 0,
      done: false,
    };
    const cur = () => state.sheets[state.current];
    const sheet = {
      type: jsPsychConceptSheet,
      header: header,
      allow_new_sheet: opts.allow_new_sheet !== false,
      finish_label: opts.finish_label || "I'm finished with this part",
      sheet_class: opts.sheet_class || "",
      data: { task: "concept_sheet", phase: phase },
      // Sketches are big; the header is the same on every sheet, and the restored strokes are
      // already in the previous revision's sketch, so none of these need repeating in the data.
      save_trial_parameters: {
        header: false,
        initial_strokes: false,
        initial_description: false,
      },
      // The phase clock starts with its first sheet.
      deadline: () => {
        if (state.deadline === null) state.deadline = Date.now() + ms;
        return state.deadline;
      },
      sheet_number: () => state.current + 1,
      n_sheets: () => state.sheets.length,
      revision: () => cur().visits + 1,
      initial_strokes: () => cur().strokes,
      initial_description: () => cur().description,
      on_save: (content) => Object.assign(cur(), content),
      on_finish: (data) => {
        cur().visits++;
        const isLast = state.current === state.sheets.length - 1;
        if (data.end_reason === "new_sheet") {
          state.sheets.push({ strokes: [], description: "", visits: 0 });
          state.current = state.sheets.length - 1;
        } else if (data.end_reason === "go_to") {
          // A blank sheet left at the end is dropped rather than kept as an empty concept.
          if (isLast && data.empty) state.sheets.pop();
          state.current = Math.min(state.sheets.length, data.go_to) - 1;
        } else {
          state.done = true;
        }
        if (Date.now() >= state.deadline) state.done = true;
      },
    };
    return { timeline: [sheet], loop_function: () => !state.done };
  }

  // -------------------------------------------------------------------------
  // 3. Initial phase (3 min): view the provided example, or sketch your own initial concept
  // -------------------------------------------------------------------------
  const initialExample = timedPage(
    "example_view",
    phaseMs("initial"),
    () => `<div class="design-task">
       ${problemBox()}
       <p>${P().example_text}</p>
       <img class="example-sketch" src="${P().image}" alt="${P().alt}">
       <p>Please study the problem and this example. You will be asked to come up with your own
       designs later.</p>
     </div>`,
    "Continue",
  );
  const initialOwn = conceptPhase(
    "initial",
    phaseMs("initial"),
    () => `<div class="design-task">${problemBox()}
       <p>Sketch and describe your own initial design for this problem on the colored concept
       sheet below.</p></div>`,
    {
      allow_new_sheet: false,
      finish_label: "I'm finished with my initial design",
      sheet_class: "initial",
    },
  );
  const initialPhase = {
    timeline: [
      {
        timeline: [initialExample],
        conditional_function: () => assigned.condition === "example",
      },
      {
        timeline: [initialOwn],
        conditional_function: () => assigned.condition === "control",
      },
    ],
  };

  // -------------------------------------------------------------------------
  // 4. Introduction to idea generation (2 min). Fixation is deliberately not mentioned.
  // -------------------------------------------------------------------------
  const introIdeaGeneration = timedPage(
    "intro_idea_generation",
    phaseMs("intro_idea_generation"),
    `<div class="lesson">
       <h2>Idea generation</h2>
       <p>Early in a design process, designers use <strong>divergent thinking</strong>: coming up
       with many different possible solutions to a problem before choosing one to develop. The
       goal at this stage is to create <strong>multiple, diverse concepts</strong>.</p>
       <p>In the parts that follow:</p>
       <ul>
         <li>Generate varied, alternative concepts.</li>
         <li>Sketch your concepts without worrying about your drawing skills. Rough sketches are fine.</li>
         <li>Draw and describe each concept on its own concept sheet. Use
         <em>Save and start a new concept</em> to begin the next one. Sheets are numbered for you,
         and you can go back to edit any sheet using the <em>Go to</em> list above it.</li>
       </ul>
     </div>`,
    "Continue",
  );

  // -------------------------------------------------------------------------
  // 5. Introduction to individual brainstorming (2 min)
  // -------------------------------------------------------------------------
  const introBrainstorming = timedPage(
    "intro_brainstorming",
    phaseMs("intro_brainstorming"),
    `<div class="lesson">
       <h2>Individual brainstorming</h2>
       <p>Brainstorming is a method for generating ideas. When brainstorming on your own:</p>
       <ol>
         <li>Postpone and withhold your judgment of ideas.</li>
         <li>Encourage wild and exaggerated ideas.</li>
         <li>Quantity counts at this stage, not quality.</li>
         <li>Build consecutively on your ideas.</li>
         <li>Every idea has equal worth.</li>
       </ol>
       <p>Next, you will practice brainstorming on a practice problem for a few minutes.</p>
     </div>`,
    "Continue",
  );

  // -------------------------------------------------------------------------
  // 6. Practice brainstorming (3 min)
  // -------------------------------------------------------------------------
  const practice = conceptPhase(
    "practice",
    phaseMs("practice"),
    `<div class="design-task">
       <div class="design-problem"><strong>Practice problem:</strong> Design a seating device.</div>
       <p>Practice individual brainstorming: create as many concepts as you can, one per sheet.</p>
     </div>`,
  );

  // -------------------------------------------------------------------------
  // 7. Brainstorming on the design problem (25 min)
  // -------------------------------------------------------------------------
  const brainstormIntro = {
    type: jsPsychInstructions,
    pages: () => [
      `<h2>Design problem</h2>
       ${problemBox()}
       <p>Now create concepts for this design problem using individual brainstorming, or any other
       method you prefer. Draw and describe each concept on its own sheet. You have up to
       ${EXPERIMENT.minutes.brainstorm} minutes; the timer starts when you continue.</p>`,
    ],
    show_clickable_nav: true,
    data: { task: "instructions" },
  };
  const brainstorm = conceptPhase(
    "brainstorm",
    phaseMs("brainstorm"),
    () => `<div class="design-task">${problemBox()}</div>`,
  );

  // -------------------------------------------------------------------------
  // 8. Debrief
  // -------------------------------------------------------------------------
  const debrief = {
    type: jsPsychHtmlButtonResponse,
    stimulus: `
      <h2>Debrief</h2>
      <p>Thank you. In this study we tested whether seeing an example design before generating
      ideas changes the ideas people come up with. Some participants saw an example design
      first; others sketched their own first idea. We will compare how similar later ideas are to
      that first design. If you have questions about this research, contact
      <a href="mailto:${EXPERIMENT.contact_email}">${EXPERIMENT.contact_email}</a>.
      Press the button to save your responses and finish.</p>`,
    choices: ["Finish"],
    data: { task: "debrief" },
  };

  await jsPsych.run([
    consent,
    assignment,
    instructions,
    initialPhase,
    introIdeaGeneration,
    introBrainstorming,
    practice,
    brainstormIntro,
    brainstorm,
    debrief,
  ]);
})();
