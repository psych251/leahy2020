/*
 * jsPsych 8 plugin: one "concept sheet" (Leahy et al., 2020; after Jansson & Smith, 1991).
 *
 * A boxed sketch area with the prompt "Describe the concept in detail..." below it, plus a
 * countdown to a phase deadline shared by every sheet in the phase. The participant can save
 * the sheet and start a new one, switch to any other sheet in the phase from a "Go to"
 * dropdown, or finish the phase; when the deadline passes, the sheet in progress is saved automatically.
 *
 * One trial is one visit to a sheet. Going back to a sheet starts a new trial with its earlier
 * sketch and description restored (`initial_strokes`, `initial_description`), so every edit is
 * saved as a new revision of that sheet; the last revision of each sheet is its final version.
 *
 * Data: sketch (PNG data URL of the sketch box), description, n_strokes, empty, changed
 * (edited during this visit), sheet_number, revision, end_reason ("new_sheet" | "go_to" |
 * "finished" | "time_up"), go_to (sheet number chosen in the dropdown, else null), rt.
 */
var jsPsychConceptSheet = (function (jspsych) {
  "use strict";

  const info = {
    name: "concept-sheet",
    version: "1.1.0",
    parameters: {
      /** HTML shown above the sheet (the design problem). */
      header: { type: jspsych.ParameterType.HTML_STRING, default: "" },
      /** Shown as "Concept <n>" at the top of the sheet. */
      sheet_number: { type: jspsych.ParameterType.INT, default: 1 },
      /** Date.now() value at which the phase ends. */
      deadline: { type: jspsych.ParameterType.INT, default: null },
      /** Visits to this sheet so far, including this one. */
      revision: { type: jspsych.ParameterType.INT, default: 1 },
      /** Sheets in the phase so far, including this one; all are listed in the "Go to" dropdown. */
      n_sheets: { type: jspsych.ParameterType.INT, default: 1 },
      /** Restored content when revisiting a sheet: strokes as arrays of [x, y] points. */
      initial_strokes: { type: jspsych.ParameterType.OBJECT, default: [] },
      initial_description: { type: jspsych.ParameterType.STRING, default: "" },
      /** Called with { strokes, description } as the trial ends, so the sheet can be restored. */
      on_save: { type: jspsych.ParameterType.FUNCTION, default: () => {} },
      /** Show the "Save and start a new concept" button and the "Go to" dropdown. */
      allow_new_sheet: { type: jspsych.ParameterType.BOOL, default: true },
      /** Label of the button that ends the phase early. */
      finish_label: { type: jspsych.ParameterType.STRING, default: "I'm finished" },
      /** Extra class on the sheet, e.g. "initial" for the colored initial-concept sheet. */
      sheet_class: { type: jspsych.ParameterType.STRING, default: "" },
      canvas_width: { type: jspsych.ParameterType.INT, default: 720 },
      canvas_height: { type: jspsych.ParameterType.INT, default: 270 },
    },
    data: {
      sketch: { type: jspsych.ParameterType.STRING },
      description: { type: jspsych.ParameterType.STRING },
      n_strokes: { type: jspsych.ParameterType.INT },
      empty: { type: jspsych.ParameterType.BOOL },
      changed: { type: jspsych.ParameterType.BOOL },
      sheet_number: { type: jspsych.ParameterType.INT },
      revision: { type: jspsych.ParameterType.INT },
      go_to: { type: jspsych.ParameterType.INT },
      end_reason: { type: jspsych.ParameterType.STRING },
      rt: { type: jspsych.ParameterType.INT },
    },
  };

  function fmt(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  class ConceptSheetPlugin {
    static info = info;
    constructor(jsPsych) { this.jsPsych = jsPsych; }

    trial(display_element, trial) {
      const start = performance.now();
      display_element.innerHTML = `
        <div class="concept-page">
          <div class="concept-header">${trial.header}</div>
          <div class="concept-timer" id="concept-timer" aria-live="polite"></div>
          <div class="concept-sheet ${trial.sheet_class}" data-sheet="${trial.sheet_number}">
            <div class="concept-title-row">
              <span class="concept-title">Concept ${trial.sheet_number}${trial.allow_new_sheet ? ` of ${trial.n_sheets}` : ""}</span>
              ${trial.allow_new_sheet ? `<label class="concept-goto">Go to:
                <select id="concept-goto"${trial.n_sheets > 1 ? "" : " disabled"}>
                  ${Array.from({ length: trial.n_sheets }, (_, i) => i + 1).map((n) =>
                    `<option value="${n}"${n === trial.sheet_number ? " selected" : ""}>Concept ${n}${n === trial.sheet_number ? " (this sheet)" : ""}</option>`).join("")}
                </select></label>` : ""}
              <span class="concept-tools">
                <button type="button" class="jspsych-btn small" id="concept-undo">Undo</button>
                <button type="button" class="jspsych-btn small" id="concept-clear">Clear sketch</button>
              </span>
            </div>
            <canvas id="concept-canvas" width="${trial.canvas_width}" height="${trial.canvas_height}"></canvas>
            <label for="concept-description" class="concept-prompt">Describe the concept in detail.
              How does it work? What are the unique features, mechanisms, and details?</label>
            <textarea id="concept-description" rows="3"></textarea>
          </div>
          <p class="concept-message" id="concept-message"></p>
          <div class="concept-buttons">
            ${trial.allow_new_sheet ? '<button type="button" class="jspsych-btn" id="concept-new">Save and start a new concept</button>' : ""}
            <button type="button" class="jspsych-btn" id="concept-finish">${trial.finish_label}</button>
          </div>
        </div>`;

      const canvas = display_element.querySelector("#concept-canvas");
      const ctx = canvas.getContext("2d");
      const text = display_element.querySelector("#concept-description");
      const msg = display_element.querySelector("#concept-message");
      const timerEl = display_element.querySelector("#concept-timer");
      const strokes = (trial.initial_strokes || []).map((st) => st.map((pt) => pt.slice()));
      text.value = trial.initial_description || "";
      let current = null;
      let changed = false;
      text.addEventListener("input", () => { changed = true; });

      function redraw() {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = "#111111";
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (const s of strokes) {
          ctx.beginPath();
          s.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          if (s.length === 1) ctx.lineTo(s[0][0] + 0.1, s[0][1]);
          ctx.stroke();
        }
      }
      function point(e) {
        const r = canvas.getBoundingClientRect();
        return [(e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height)];
      }
      canvas.addEventListener("pointerdown", (e) => {
        canvas.setPointerCapture(e.pointerId);
        current = [point(e)];
        strokes.push(current);
        changed = true;
        redraw();
      });
      canvas.addEventListener("pointermove", (e) => {
        if (!current) return;
        current.push(point(e));
        redraw();
      });
      const endStroke = () => { current = null; };
      canvas.addEventListener("pointerup", endStroke);
      canvas.addEventListener("pointercancel", endStroke);
      display_element.querySelector("#concept-undo").addEventListener("click", () => {
        if (strokes.length) { strokes.pop(); changed = true; redraw(); }
      });
      display_element.querySelector("#concept-clear").addEventListener("click", () => {
        if (strokes.length) { strokes.length = 0; changed = true; redraw(); }
      });
      redraw();

      const isEmpty = () => strokes.length === 0 && text.value.trim() === "";
      let done = false;
      let interval = null;
      const end = (reason, goTo = null) => {
        if (done) return;
        done = true;
        clearInterval(interval);
        const empty = isEmpty();
        trial.on_save({ strokes: strokes, description: text.value });
        this.jsPsych.finishTrial({
          // Blank sheets are not worth an image; keep the row so the end of the phase is recorded.
          sketch: strokes.length ? canvas.toDataURL("image/png") : null,
          description: text.value,
          n_strokes: strokes.length,
          empty: empty,
          changed: changed,
          sheet_number: trial.sheet_number,
          revision: trial.revision,
          go_to: goTo,
          end_reason: reason,
          rt: Math.round(performance.now() - start),
        });
      };

      const newBtn = display_element.querySelector("#concept-new");
      if (newBtn) newBtn.addEventListener("click", () => {
        if (isEmpty()) { msg.textContent = "Sketch or describe a concept before starting a new one."; return; }
        end("new_sheet");
      });
      const goto = display_element.querySelector("#concept-goto");
      if (goto) goto.addEventListener("change", () => {
        const n = Number(goto.value);
        if (n !== trial.sheet_number) end("go_to", n);
      });
      const finishBtn = display_element.querySelector("#concept-finish");
      let confirming = false;
      finishBtn.addEventListener("click", () => {
        if (!confirming) {
          confirming = true;
          finishBtn.textContent = "Click again to confirm. You cannot come back to this part.";
          return;
        }
        end("finished");
      });

      const tick = () => {
        if (trial.deadline == null) return;
        const left = trial.deadline - Date.now();
        timerEl.textContent = "Time remaining: " + fmt(left);
        timerEl.classList.toggle("warning", left <= 60000);
        if (left <= 0) end("time_up");
      };
      tick();
      if (!done) interval = setInterval(tick, 250);
    }
  }

  return ConceptSheetPlugin;
})(jsPsychModule);
