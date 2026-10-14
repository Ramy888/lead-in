// Lead-In UI. Plain DOM building: every user- or API-supplied string goes in via textContent, never innerHTML.

const $ = (sel) => document.querySelector(sel);

/** h("div", {class: "x", onclick}, child, "text") → element. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") for (const [p, val] of Object.entries(v)) p.startsWith("--") ? el.style.setProperty(p, String(val)) : (el.style[p] = val);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const state = {
  presets: [],
  presetId: null, // the selected library; planning needs one
  expanded: null, // the library whose details are open
  edited: false, // shows were added or removed since it was picked
  library: [],
  plan: null,
  seq: [],
  view: null, // { slots, flow, violations } for the current order
  planning: false,
  agentRunning: false,
  agent: false, // the server has a Claude key
};

const dpClass = (name) => "dp-" + name.toLowerCase().replace(/\s+/g, "-");
function strength(slot, next, weak) {
  if (slot.showId === next.showId) return "stack";
  if (slot.handoffScore < weak) return "weak";
  return slot.handoffScore >= 0.6 ? "strong" : "mid";
}
const fmt = (x) => (x === null || x === undefined ? "—" : Number(x).toFixed(2));

// ---------- Library ----------

const CHEVRON = () => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "chev");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M6 9l6 6 6-6");
  svg.append(path);
  return svg;
};

/** Library accordion: titles only; the selected one opens to its description, show list and add field. */
function renderPresets() {
  const parts = $("#library-parts");
  $("#presets").replaceChildren(
    ...state.presets.map((p) => {
      const sel = p.id === state.presetId, open = sel && state.expanded === p.id;
      const bodyId = `preset-body-${p.id}`;
      return h("div", { class: `preset${sel ? " sel" : ""}${open ? " open" : ""}` },
        h("button", {
          class: "preset-head", type: "button", "aria-expanded": String(open), "aria-controls": bodyId,
          "aria-current": sel ? "true" : null,
          onclick: () => {
            if (!sel) {
              state.presetId = p.id;
              state.library = p.library.map((x) => ({ ...x }));
              state.edited = false;
              state.expanded = p.id;
            } else state.expanded = open ? null : p.id;
            renderPresets();
            renderLibrary();
          },
        },
          h("span", { class: "radio", "aria-hidden": "true" }),
          h("span", { class: "title" },
            h("strong", {}, p.name),
            h("span", { class: "count" }, `${(sel ? state.library : p.library).length} shows`, sel && state.edited ? h("span", { class: "tag ours" }, "Edited") : null)),
          CHEVRON()),
        open ? h("div", { class: "preset-body", id: bodyId }, h("p", {}, p.description), parts) : null,
      );
    }),
  );
  parts.hidden = !state.expanded;
  if (!state.expanded) $(".setup").append(parts); // keep the list and form in the page while every card is closed
  syncPlanButton();
}

function syncPlanButton() {
  const btn = $("#plan-btn");
  btn.disabled = state.planning || !state.presetId || !state.library.length;
  btn.title = !state.presetId ? "Select a library first" : !state.library.length ? "Add at least one show" : "";
  // Visible on touch screens too, where the tooltip never shows.
  $("#plan-hint").hidden = !!state.presetId && state.library.length > 0;
  $("#plan-hint").textContent = !state.presetId ? "Pick a library below to start." : "Add at least one show to plan.";
  // The empty day panel's own button mirrors the main one.
  $("#empty-plan").disabled = btn.disabled;
  $("#empty-hint").textContent = !state.presetId ? "Pick a library first." : !state.library.length ? "Add at least one show first." : `Ready: ${state.presets.find((p) => p.id === state.presetId)?.name ?? "your library"}, ${state.library.length} shows.`;
}

function renderLibrary() {
  const ambiguous = new Set((state.plan?.unresolved ?? []).map((u) => u.name.toLowerCase()));
  $("#library").replaceChildren(
    ...state.library.map((s, i) =>
      h("li", { class: ambiguous.has(s.name.toLowerCase()) ? "ambiguous" : "" },
        h("span", { class: "name", title: s.name }, s.name),
        h("span", { class: "rt num" }, s.runtimeMinutes ? `${s.runtimeMinutes}m` : "TMDB"),
        h("button", { class: "icon-btn", "aria-label": `Remove ${s.name}`, onclick: () => { state.library.splice(i, 1); state.edited = true; renderPresets(); renderLibrary(); } }, "×"),
      ),
    ),
    h("li", { class: "add-row" }, h("button", { type: "button", class: "add-btn", onclick: openAddShow }, "+ Add a show")),
  );
}

// ---------- Add a show (TMDB search) ----------

const inLibrary = (name) => state.library.some((x) => x.name.toLowerCase() === name.toLowerCase());
let addSeq = 0; // ignores answers to queries the user has already typed past
let addTimer;

function openAddShow() {
  $("#add-q").value = "";
  renderAddIdle();
  $("#add-dialog").showModal();
  $("#add-q").focus();
}

function addToLibrary(item) {
  state.library.push(item);
  state.edited = true;
  renderPresets();
  renderLibrary();
  $("#add-dialog").close();
}

const renderAddIdle = () => $("#add-results").replaceChildren(h("p", { class: "empty" }, "Start typing a title, e.g. Magnum, P.I."));

function renderAddSkeleton() {
  $("#add-results").replaceChildren(h("div", { class: "result-list", "aria-busy": "true", "aria-label": "Searching TMDB" },
    ...Array.from({ length: 4 }, () => h("div", { class: "result sk-result", "aria-hidden": "true" },
      h("i", { class: "sk poster" }), h("div", { class: "sk-lines" }, h("i", { class: "sk w30" }), h("i", { class: "sk w40" }), h("i", { class: "sk w24" }))))));
}

/** Add the title as typed, after the user confirms it and sets an episode length. */
function addAnywayPanel(name, lead) {
  const minutes = h("input", { type: "number", min: 5, max: 240, value: 45, class: "minutes", "aria-label": "Episode length in minutes" });
  const confirm = h("div", { class: "confirm", hidden: true },
    h("p", {}, `Add “${name}” to your library as typed? Lead-In will still look it up on Qloo when you plan.`),
    h("label", { class: "minutes-row" }, "Episode length", minutes, "minutes"),
    h("div", { class: "row-actions" },
      h("button", { type: "button", class: "ghost", onclick: () => { confirm.hidden = true; ask.hidden = false; } }, "Cancel"),
      h("button", { type: "button", class: "primary", onclick: () => {
        const rt = Math.round(Number(minutes.value));
        if (!(rt >= 5 && rt <= 240)) { minutes.focus(); minutes.setCustomValidity("5 to 240 minutes"); minutes.reportValidity(); return; }
        addToLibrary({ name, runtimeMinutes: rt });
      } }, "Confirm and add")));
  const ask = h("button", { type: "button", class: "ghost", disabled: inLibrary(name),
    onclick: () => { ask.hidden = true; confirm.hidden = false; minutes.focus(); } },
    inLibrary(name) ? `“${name}” is already in your library` : `Add “${name}” anyway`);
  return h("div", { class: "anyway" }, lead, ask, confirm);
}

async function searchShows(q) {
  const seq = ++addSeq;
  renderAddSkeleton();
  let results, failed = null;
  try {
    const res = await fetch(`/api/tmdb/search?q=${encodeURIComponent(q)}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    results = body.results;
  } catch (err) {
    failed = err.message;
  }
  if (seq !== addSeq) return; // a newer query is on its way
  if (failed) {
    return $("#add-results").replaceChildren(addAnywayPanel(q,
      h("div", { class: "notice" }, h("strong", {}, "Show search isn't available right now."), h("p", {}, `${failed}. You can try again in a moment, or add the title as typed.`))));
  }
  if (!results.length) {
    return $("#add-results").replaceChildren(addAnywayPanel(q,
      h("div", { class: "notice" }, h("strong", {}, `No TV show called “${q}” on TMDB.`), h("p", {}, "Check the spelling or try the original title. If it's right, you can still add it as typed."))));
  }
  $("#add-results").replaceChildren(
    h("div", { class: "result-list", role: "list" }, ...results.map((r) => resultRow(r))),
    addAnywayPanel(q, h("p", { class: "empty small" }, "Not the show you meant?")),
  );
}

/** One inline panel under a result at a time, however often it's clicked. */
function panelAfter(row, panel) {
  if (row.nextElementSibling?.classList.contains("anyway")) row.nextElementSibling.remove();
  row.after(panel);
}

function resultRow(r) {
  const dup = inLibrary(r.name);
  const status = h("span", { class: "status" });
  const row = h("button", {
    type: "button", class: "result", role: "listitem", disabled: dup,
    onclick: async () => {
      row.disabled = true;
      status.replaceChildren(h("span", { class: "spinner", "aria-hidden": "true" }), "Getting episode length…");
      try {
        const res = await fetch(`/api/tmdb/shows/${r.tmdbId}`);
        const body = await res.json().catch(() => ({}));
        if (res.status === 404) {
          row.disabled = false;
          status.replaceChildren();
          return panelAfter(row, addAnywayPanel(r.name, h("div", { class: "notice" }, h("p", {}, `TMDB doesn't list an episode length for ${r.name}. Add it with your own length:`))));
        }
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        if (!(body.runtimeMinutes >= 5 && body.runtimeMinutes <= 240)) {
          // e.g. web shorts of 2 minutes: a channel slot needs 5–240, so let the user set it.
          row.disabled = false;
          status.replaceChildren();
          return panelAfter(row, addAnywayPanel(body.name, h("div", { class: "notice" }, h("p", {}, `TMDB lists ${body.runtimeMinutes}-minute episodes for ${body.name}, which won't fill a channel slot. Add it with your own length:`))));
        }
        addToLibrary({ name: body.name, runtimeMinutes: body.runtimeMinutes, ...(body.year ? { year: body.year } : {}) });
      } catch (err) {
        row.disabled = false;
        status.replaceChildren(h("span", { class: "err" }, `Couldn't add: ${err.message}`));
      }
    },
  },
    r.posterPath ? h("img", { class: "poster", src: `https://image.tmdb.org/t/p/w92${r.posterPath}`, alt: "", loading: "lazy" }) : h("span", { class: "poster none", "aria-hidden": "true" }, "TV"),
    h("span", { class: "info" },
      h("strong", {}, r.name, r.year ? h("span", { class: "year" }, ` (${r.year})`) : null),
      r.overview ? h("span", { class: "overview" }, r.overview) : null,
      dup ? h("span", { class: "tag ok" }, "In your library") : status),
  );
  return row;
}

$("#add-q").addEventListener("input", () => {
  clearTimeout(addTimer);
  const q = $("#add-q").value.trim();
  if (q.length < 2) { addSeq++; return renderAddIdle(); }
  addTimer = setTimeout(() => searchShows(q), 350);
});
$("#add-q").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  clearTimeout(addTimer);
  const q = $("#add-q").value.trim();
  if (q.length >= 2) searchShows(q);
});

// ---------- Planning (streamed) ----------

async function planChannel() {
  if (state.planning || !state.presetId || !state.library.length) return;
  state.planning = true;
  syncPlanButton();
  $("#needs-input").replaceChildren();
  const ticker = h("div", { class: "ticker" });
  const count = h("span", { class: "num" }, "0");
  $("#progress").replaceChildren(h("div", {}, "Asking Qloo… calls so far: ", count), ticker);
  // The day panel shows the wait too, so the click visibly did something wherever the user is looking.
  $("#intro").hidden = true;
  $("#planning").hidden = false;
  const live = h("span", { class: "num" }, "0");
  $("#planning-text").replaceChildren("Asking Qloo how each show's audience overlaps with the others… ", live, " calls");
  if (matchMedia("(max-width: 900px)").matches) $("#schedule-title").scrollIntoView({ behavior: "smooth", block: "start" });

  const body = { library: state.library };
  let calls = 0;
  try {
    const res = await fetch("/api/plans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.type === "trace") {
          calls++;
          count.textContent = String(calls);
          live.textContent = String(calls);
          ticker.textContent = `${msg.entry.tool} ${JSON.stringify(msg.entry.params)} → ${msg.entry.status}${msg.entry.cached ? " (cached)" : ""}`;
        } else if (msg.type === "plan") {
          loadPlan(msg.plan);
        } else if (msg.type === "error") {
          throw new Error(msg.message);
        }
      }
    }
    $("#progress").replaceChildren(`${calls} Qloo calls. Done.`);
  } catch (err) {
    $("#progress").replaceChildren(h("span", { style: { color: "var(--weak)" } }, `Couldn't plan: ${err.message}`));
    if (!state.view) $("#intro").hidden = false;
  } finally {
    $("#planning").hidden = true;
    state.planning = false;
    syncPlanButton();
  }
}
$("#plan-btn").addEventListener("click", planChannel);
$("#empty-plan").addEventListener("click", planChannel);
// Welcome dialog: on a first visit, and from the "?" button any time.
const WELCOME_KEY = "lead-in-welcomed";
$("#welcome-ok").addEventListener("click", () => $("#welcome").close());
$("#welcome").addEventListener("close", () => {
  try { localStorage.setItem(WELCOME_KEY, "1"); } catch { /* storage blocked: it shows again next visit */ }
});
$("#help-btn").addEventListener("click", () => $("#welcome").showModal());
let welcomed = false;
try { welcomed = localStorage.getItem(WELCOME_KEY) === "1"; } catch { /* storage blocked: treat as a first visit */ }
if (!welcomed) $("#welcome").showModal();

function loadPlan(plan) {
  state.plan = plan;
  state.seq = plan.schedule.slots.map((s) => s.showId);
  state.view = plan.schedule;
  const weakest = plan.schedule.slots.findIndex((x) => x.weakHandoff);
  selected = { kind: "slot", index: Math.max(0, weakest) }; // open on the problem, if there is one
  const badge = $("#source-badge");
  badge.hidden = false;
  badge.className = "badge " + (plan.synthetic ? "synthetic" : "live");
  badge.textContent = plan.synthetic ? "Synthetic stand-in data · no Qloo key configured" : "Live Qloo data";
  renderLibrary();
  renderNeedsInput();
  renderSchedule();
  renderInsights();
  renderCompareIntro();
}

function renderNeedsInput() {
  const box = $("#needs-input");
  const items = state.plan.unresolved;
  if (!items.length) return box.replaceChildren();
  box.replaceChildren(
    ...items.map((u) =>
      h("div", {},
        u.candidates?.length
          ? [h("strong", {}, `Which “${u.name}”?`), " Qloo found more than one match. Pick one and the channel is re-planned."]
          : u.status === "error"
            ? [h("strong", {}, `“${u.name}” couldn't be looked up.`), " Qloo didn't answer in time, so it was left out. Plan again to retry."]
            : [h("strong", {}, `“${u.name}” not found.`), " Qloo has no TV show by that name; it was left out."],
        h("div", { class: "choices" },
          ...(u.candidates ?? []).map((c) =>
            h("button", {
              class: "ghost",
              onclick: () => {
                const item = state.library.find((s) => s.name.toLowerCase() === u.name.toLowerCase());
                // Send the picked ID: two shows can share a title (Matlock 1986 and 2024).
                if (item) Object.assign(item, { name: c.name, qlooId: c.id, ...(Number(c.hint) ? { year: Number(c.hint) } : {}) });
                renderLibrary();
                planChannel();
              },
            }, c.hint ? `${c.name} (${c.hint})` : c.name),
          ),
        ),
      ),
    ),
  );
}

// ---------- Schedule: the day as a half-circle dial ----------

// The broadcast day runs 06:00 → 06:00 in 48 half-hour units, left to right over the top of the dial.
const DAY_UNITS = 48;
const DAY_START_MIN = 6 * 60;
const clock = (unit) => {
  const m = (DAY_START_MIN + unit * 30) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const DAYPART_SHORT = { "Early fringe": "Fringe", "Late night": "Late", Overnight: "Night", Morning: "AM", Daytime: "Day" };
const HANDOFF_LABEL = { strong: "strong handoff", mid: "ok handoff", weak: "weak handoff", stack: "next episode" };
/** A stable muted colour per show, so repeats of the same show are recognisable around the dial.
 *  Kept to blues and violets: green, amber and red are reserved for handoff quality. */
const showTone = (showId) => {
  const order = Math.max(0, state.plan.shows.findIndex((s) => s.id === showId));
  return { "--hue": 195 + ((order * 41) % 90), "--lum": 21 + ((order * 7) % 4) * 3 };
};

const SVG = "http://www.w3.org/2000/svg";
/** Like h(), for SVG elements. Styles go through CSSOM: the CSP forbids style attributes. */
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") for (const [p, val] of Object.entries(v)) el.style.setProperty(p, String(val));
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

let selected = { kind: "slot", index: 0 };
let changedHandoffs = new Set();

/** Slots with their start unit and next slot, in airing order. */
function placedSlots() {
  const slots = state.view.slots;
  let at = 0;
  return slots.map((slot, i) => {
    const p = { slot, i, start: at, next: slots[(i + 1) % slots.length], prev: slots[(i - 1 + slots.length) % slots.length] };
    at += slot.units;
    return p;
  });
}
function daypartBands(placed) {
  const bands = [];
  for (const p of placed) {
    const last = bands.at(-1);
    if (last && last.name === p.slot.daypart) last.units += p.slot.units;
    else bands.push({ name: p.slot.daypart, start: p.start, units: p.slot.units });
  }
  return bands;
}
const gapFor = (daypart) => state.plan.gaps.find((g) => g.daypart === daypart);
const weakCount = () => state.view.slots.filter((x, i, all) => strength(x, all[(i + 1) % all.length], state.plan.rules.weakHandoff) === "weak").length;

function renderSchedule() {
  $("#intro").hidden = true;
  $("#schedule-hint").hidden = false;
  $("#dial").hidden = false;
  $("#legend").hidden = false;
  $("#schedule-hint").replaceChildren(airingsLine(), h("br"), "Tap a show on the dial for its details and to move it earlier or later; tap a daypart for titles to license. Every handoff is re-scored.");
  $("#legend").replaceChildren(...["strong", "mid", "weak", "stack"].map((k) => h("span", {}, h("i", { class: `h-${k}` }), HANDOFF_LABEL[k])));
  renderArc();
  renderHub();
  fitHub();
  renderViolations();
  renderDetail();
}

/** Explains why a small library repeats: the day is 24 hours of episode slots, so each show airs several episodes. */
function airingsLine() {
  const counts = new Map();
  for (const x of state.view.slots) counts.set(x.name, (counts.get(x.name) ?? 0) + 1);
  const shows = [...counts].sort((a, b) => b[1] - a[1]);
  return h("span", { class: "airings" },
    `Your ${shows.length} show${shows.length === 1 ? "" : "s"} fill the 24 hours as ${state.view.slots.length} episode slots: `,
    shows.map(([name, n]) => `${name} ×${n}`).join(" · "), ".");
}

const arcObserver = new ResizeObserver(() => { if (state.view) renderArc(); });
arcObserver.observe($("#dial"));

function renderArc() {
  const svg = $("#arc");
  const W = Math.round($("#dial").clientWidth);
  if (!W) return;
  const weak = state.plan.rules.weakHandoff;
  const placed = placedSlots();
  const wide = W >= 620;
  // Room for the show names fanned out around the dial on wide screens; hour labels only on phones.
  const outer = wide ? Math.min(150, Math.max(90, W * 0.13)) : 26;
  const R = Math.max(80, W / 2 - outer);
  const cx = W / 2, cy = R + outer + 4;
  const H = Math.round(cy + 18);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);

  const ang = (u) => Math.PI - (u / DAY_UNITS) * Math.PI;
  const pt = (u, r) => [cx + r * Math.cos(ang(u)), cy - r * Math.sin(ang(u))];
  const f = (n) => n.toFixed(1);
  const ring = (u0, u1, r0, r1) => {
    const [a, b] = [pt(u0, r1), pt(u1, r1)], [c, d] = [pt(u1, r0), pt(u0, r0)];
    return `M${f(a[0])},${f(a[1])} A${r1},${r1} 0 0 1 ${f(b[0])},${f(b[1])} L${f(c[0])},${f(c[1])} A${r0},${r0} 0 0 0 ${f(d[0])},${f(d[1])} Z`;
  };
  const band = { r1: R, r0: R - Math.max(18, R * 0.075) };
  const lane = { r1: band.r0 - 4, r0: band.r0 - 4 - Math.max(28, R * 0.17) };
  const tickR = lane.r0 - 4;
  const font = wide ? 12 : 10;
  const pxPerUnit = (Math.PI * lane.r1) / DAY_UNITS;

  const g = [];
  // Daypart band, with its label along the arc; a gap (weak fit) is outlined in amber.
  daypartBands(placed).forEach((b, k) => {
    const gap = gapFor(b.name);
    const id = `dp-path-${k}`;
    const mid = (band.r0 + band.r1) / 2;
    const [a, c] = [pt(b.start, mid), pt(b.start + b.units, mid)];
    const len = (Math.PI * mid * b.units) / DAY_UNITS;
    const label = [b.name, DAYPART_SHORT[b.name]].find((t) => t && t.length * font * 0.62 + 10 < len);
    g.push(s("g", {
      class: `seg-dp ${dpClass(b.name)}${gap ? " gap" : ""}${selected.kind === "daypart" && selected.name === b.name ? " sel" : ""}`,
      role: "button", tabindex: 0,
      "aria-label": `${b.name}, ${clock(b.start)} to ${clock(b.start + b.units)}${gap ? `, weak fit ${fmt(gap.meanFit)}` : ""}`,
      onclick: () => select({ kind: "daypart", name: b.name }), onkeydown: activateOnKey(() => select({ kind: "daypart", name: b.name })),
    },
      s("path", { d: ring(b.start, b.start + b.units, band.r0, band.r1) }),
      s("path", { id, d: `M${f(a[0])},${f(a[1])} A${mid},${mid} 0 0 1 ${f(c[0])},${f(c[1])}`, class: "guide" }),
      label ? s("text", { class: "dp-label", dy: font * 0.36 }, s("textPath", { href: `#${id}`, startOffset: "50%", "text-anchor": "middle" }, (gap ? "⚠ " : "") + label)) : null,
    ));
  });

  // Show segments, then the handoff marks between them.
  for (const p of placed) {
    const kind = strength(p.slot, p.next, weak);
    const tone = showTone(p.slot.showId);
    g.push(s("path", {
      class: `seg${selected.kind === "slot" && selected.index === p.i ? " sel" : ""}`,
      d: ring(p.start, p.start + p.slot.units, lane.r0, lane.r1),
      style: { "--hue": tone["--hue"], "--lum": tone["--lum"] },
      role: "button", tabindex: 0,
      "aria-label": `${clock(p.start)} ${p.slot.name}, ${HANDOFF_LABEL[kind]} to ${p.next.name}`,
      onclick: () => select({ kind: "slot", index: p.i }), onkeydown: activateOnKey(() => select({ kind: "slot", index: p.i })),
    }));
  }
  for (const p of placed) {
    const kind = strength(p.slot, p.next, weak);
    const u = p.start + p.slot.units;
    const [a, b] = [pt(u, lane.r0 - (kind === "weak" ? 3 : 0)), pt(u, lane.r1 + (kind === "weak" ? 3 : 0))];
    g.push(s("line", { class: `mark h-${kind}${changedHandoffs.has(p.i) ? " changed" : ""}`, x1: f(a[0]), y1: f(a[1]), x2: f(b[0]), y2: f(b[1]) }));
  }

  // Hour ticks inside the lane: every hour, labelled every 3 hours (every 6 on phones).
  for (let hr = 0; hr <= 24; hr++) {
    const u = hr * 2, major = hr % 3 === 0, label = wide ? major : hr % 6 === 0;
    const [a, b] = [pt(u, tickR), pt(u, tickR - (major ? 9 : 5))];
    g.push(s("line", { class: `tick${major ? " major" : ""}`, x1: f(a[0]), y1: f(a[1]), x2: f(b[0]), y2: f(b[1]) }));
    if (label) {
      const [x, y] = pt(u, tickR - 15 - font * 0.6);
      g.push(s("text", { class: "hour", x: f(x), y: f(y + font * 0.36), "text-anchor": hr === 0 ? "start" : hr === 24 ? "end" : "middle" }, clock(u)));
    }
  }

  // Show names fanned out around the dial, when there's room for one per slot.
  if (wide && pxPerUnit >= 9) {
    for (const p of placed) {
      if (p.i > 0 && p.prev.showId === p.slot.showId && p.slot.units === 1 && pxPerUnit < 14) continue; // stacked repeats: label the first
      const u = p.start + p.slot.units / 2;
      const deg = 180 - (u / DAY_UNITS) * 180;
      const [x, y] = pt(u, R + 8);
      const flip = deg > 90; // left half reads outward from the dial too
      const max = Math.floor((outer - 14) / (font * 0.56));
      const name = p.slot.name.length > max ? p.slot.name.slice(0, max - 1) + "…" : p.slot.name;
      const t = s("text", {
        class: `name${selected.kind === "slot" && selected.index === p.i ? " sel" : ""}`, x: f(x), y: f(y),
        "text-anchor": flip ? "end" : "start", "dominant-baseline": "middle",
        transform: `rotate(${f(flip ? 180 - deg : -deg)} ${f(x)} ${f(y)})`,
        onclick: () => select({ kind: "slot", index: p.i }),
      }, name);
      g.push(t);
    }
  }
  svg.replaceChildren(...g);
  $("#hub").style.setProperty("--hub-w", `${Math.round(lane.r0 * 2 - 70)}px`);
  $("#hub").style.setProperty("--hub-bottom", `${Math.round(H - cy + 6)}px`);
  // The hub must stay under the 18:00 label at the top of the inner ring.
  hubRoom = { width: lane.r0 * 2 - 70, height: tickR - 30 - font };
  fitHub();
}

let hubRoom = { width: 0, height: 0 };
/** The hub sits in the open middle of the dial when it fits there; otherwise (phones, narrow tablets) under it. */
function fitHub() {
  const hub = $("#hub");
  hub.classList.remove("below", "compact");
  if (window.innerWidth < 620 || hubRoom.width < 220) return hub.classList.add("below");
  if (hub.offsetHeight <= hubRoom.height) return;
  hub.classList.add("compact");
  if (hub.offsetHeight > hubRoom.height) hub.classList.replace("compact", "below");
}

const activateOnKey = (fn) => (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } };

function select(sel) {
  selected = sel;
  renderArc();
  renderDetail();
}

function renderHub() {
  const flow = state.view.flow;
  const base = state.plan.schedule.flow;
  const delta = Math.round((flow - base) * 1000) / 1000;
  const weakN = weakCount();
  const gaps = state.plan.gaps;
  const changed = state.seq.join() !== state.plan.schedule.slots.map((x) => x.showId).join();
  const status = (n, word, short, brief) => h("div", { class: `stat${n ? " bad" : " good"}` },
    h("span", { class: "long" }, n ? `${n} ${word}${n > 1 ? "s" : ""}` : `No ${word}s`),
    h("span", { class: "short", "aria-hidden": "true" }, n ? `${n} ${short}` : `No ${short}`),
    n && state.agent ? h("button", { class: "fix", type: "button", onclick: () => openAgent(brief) }, "Fix") : null);
  $("#hub").replaceChildren(
    h("div", { class: "flow" },
      h("span", { class: "label" }, "Audience flow"),
      h("span", { class: "value", title: "Mean handoff score between different shows (stacked episodes excluded)" }, fmt(flow)),
      h("span", { class: "caption long" }, "average handoff, 0 to 1 · higher keeps more viewers"),
      Math.abs(delta) >= 0.001 ? h("span", { class: "delta " + (delta > 0 ? "up" : "down") }, `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(3)} vs Lead-In`) : null),
    h("div", { class: "stats" },
      status(weakN, "weak handoff", weakN === 1 ? "weak handoff" : "weak handoffs", "Fix the weakest handoff in the day."),
      status(gaps.length, "daypart gap", gaps.length === 1 ? "gap" : "gaps", `${gaps.map((x) => x.daypart).join(" and ")} ${gaps.length > 1 ? "are" : "is"} weak. I can license one or two titles.`)),
    h("div", { class: "hub-actions" },
      state.agent ? h("button", { class: "primary", type: "button", onclick: () => openAgent() }, "Run the agent") : null,
      changed ? h("button", { class: "ghost", type: "button", "aria-label": "Back to Lead-In's plan", onclick: () => rescore(state.plan.schedule.slots.map((x) => x.showId)) },
        h("span", { class: "long" }, "Back to Lead-In's plan"), h("span", { class: "short" }, "↺ Reset")) : null),
  );
}

function renderViolations() {
  const v = state.view.violations ?? [];
  $("#violations").replaceChildren(
    ...(v.length ? [h("strong", {}, "This order breaks the channel's rules:"), h("ul", {}, ...v.map((x) => h("li", {}, x)))] : []),
  );
}

function renderDetail() {
  const weak = state.plan.rules.weakHandoff;
  const placed = placedSlots();
  if (selected.kind === "daypart") {
    const b = daypartBands(placed).find((x) => x.name === selected.name);
    if (!b) { selected = { kind: "slot", index: 0 }; return renderDetail(); }
    const gap = gapFor(b.name);
    const sugg = state.plan.license.filter((l) => l.daypart === b.name);
    const shows = [...new Set(placed.filter((p) => p.start >= b.start && p.start < b.start + b.units).map((p) => p.slot.name))];
    $("#detail").replaceChildren(h("div", { class: "card detail-card" },
      h("div", { class: "detail-head" },
        h("div", {}, h("span", { class: "num time" }, `${clock(b.start)}–${clock(b.start + b.units)}`), h("h3", {}, b.name)),
        gap ? h("span", { class: "tag warn" }, `Weak fit · ${fmt(gap.meanFit)}`) : h("span", { class: "tag ok" }, "Served well")),
      h("p", { class: "empty" }, `On air: ${shows.join(", ")}.`),
      gap
        ? (sugg.length
            ? [h("p", {}, "Titles to license for this daypart:"),
               h("div", { class: "suggest" },
                 h("span", { class: "h" }, "License"), h("span", { class: "h" }, "Match"), h("span", { class: "h" }, "Fit"),
                 ...sugg.flatMap((x) => [h("span", {}, x.title.name), h("span", { class: "num", title: `Qloo affinity ${x.affinity.toFixed(3)}` }, fmt(x.match)), h("span", { class: "num" }, fmt(x.fit))])),
               h("p", { class: "src" }, "Match: Qloo affinity to your library ", sourceTag(), " · fit for this daypart: ", h("span", { class: "tag ours" }, "Our read"))]
            : h("p", { class: "empty" }, "Qloo returned no candidates outside your library."))
        : h("p", { class: "empty" }, "The library's audience matches who watches at this time, so there's nothing urgent to license here."),
      gap && state.agent ? h("button", { class: "ghost", type: "button", onclick: () => openAgent(`${b.name} is weak. I can license one or two titles.`) }, `Ask the agent to fix ${b.name}`) : null,
    ));
    return;
  }
  const p = placed[Math.min(selected.index, placed.length - 1)];
  const kind = strength(p.slot, p.next, weak);
  const inKind = strength(p.prev, p.slot, weak);
  const row = (label, k, score, other) => h("div", { class: `handoff-row h-${k}` },
    h("span", { class: "muted" }, label), h("span", {}, other),
    k === "stack" ? h("span", { class: "muted" }, "next episode") : [h("span", { class: "num score" }, fmt(score)), h("span", {}, HANDOFF_LABEL[k])]);
  $("#detail").replaceChildren(h("div", { class: "card detail-card" },
    h("div", { class: "detail-head" },
      h("div", {}, h("span", { class: "num time" }, `${clock(p.start)}–${clock(p.start + p.slot.units)} · ${p.slot.daypart}`), h("h3", {}, p.slot.name)),
      h("div", { class: "moves" },
        h("button", { class: "ghost", type: "button", disabled: p.i === 0, onclick: () => move(p.i, p.i - 1) }, "↑ Earlier"),
        h("button", { class: "ghost", type: "button", disabled: p.i === placed.length - 1, onclick: () => move(p.i, p.i + 1) }, "↓ Later"))),
    h("div", { class: "meta" },
      h("span", { title: "Daypart fit: how this show's Qloo audience skew matches who watches at this hour (our read)" },
        "Daypart fit ", h("span", { class: "fitbar" }, h("i", { style: { width: `${Math.round(p.slot.fit * 100)}%` } })), " ", h("span", { class: "num" }, fmt(p.slot.fit))),
      h("span", {}, `${p.slot.units * 30} min slot`)),
    row("From", inKind, p.prev.handoffScore, p.prev.name),
    row("To", kind, p.slot.handoffScore, p.i === placed.length - 1 ? `${p.next.name} (next day)` : p.next.name),
    kind === "weak" && state.agent ? h("button", { class: "ghost", type: "button", onclick: () => openAgent(`Fix the weak handoff from ${p.slot.name} to ${p.next.name}.`) }, "Ask the agent to bridge this handoff") : null,
  ));
}

async function move(from, to) {
  if (from === to || to < 0 || to >= state.seq.length) return;
  const seq = [...state.seq];
  const [item] = seq.splice(from, 1);
  seq.splice(to, 0, item);
  // The detail card follows the moved show, so repeated taps keep moving the same show.
  if (await rescore(seq)) select({ kind: "slot", index: to });
}

async function rescore(seq) {
  const before = state.view.slots.map((x) => `${x.showId}>${fmt(x.handoffScore)}`);
  const res = await fetch(`/api/plans/${state.plan.id}/score`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sequence: seq }) });
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`;
    $("#violations").replaceChildren(h("strong", {}, msg));
    return false;
  }
  state.seq = seq;
  state.view = await res.json();
  changedHandoffs = new Set(state.view.slots.map((x, i) => (`${x.showId}>${fmt(x.handoffScore)}` !== before[i] ? i : -1)).filter((i) => i >= 0));
  renderSchedule();
  changedHandoffs = new Set();
  return true;
}

// ---------- Insights ----------

function showTab(name, { open = false } = {}) {
  if (open && !$("#drawer").open) $("#drawer").showModal();
  for (const t of document.querySelectorAll('[role="tab"]')) {
    t.setAttribute("aria-selected", String(t.dataset.tab === name));
    $(`#tab-${t.dataset.tab}`).hidden = t.dataset.tab !== name;
  }
}
for (const tab of document.querySelectorAll('[role="tab"]')) tab.addEventListener("click", () => showTab(tab.dataset.tab));

function sourceTag() {
  return state.plan.synthetic ? h("span", { class: "tag synthetic" }, "Synthetic") : h("span", { class: "tag qloo" }, "Qloo says");
}

function renderInsights() {
  const p = state.plan;
  const names = new Map(p.shows.map((s) => [s.id, s.name]));

  // Gaps & licensing
  const gaps = [];
  const weakCount = p.schedule.slots.filter((s) => s.weakHandoff).length;
  gaps.push(h("p", {}, weakCount
    ? `${weakCount} weak handoff${weakCount > 1 ? "s" : ""} in Lead-In's plan: the library has no better neighbour for those shows.`
    : "No weak handoffs: every show has a neighbour that shares its audience."));
  if (!p.gaps.length) {
    gaps.push(h("p", { class: "empty" }, "Every daypart is served reasonably well by this library, so there's nothing urgent to license."));
  }
  for (const g of p.gaps) {
    const sugg = p.license.filter((l) => l.daypart === g.daypart);
    gaps.push(h("div", { class: "card" },
      h("h4", {}, h("span", {}, `${g.daypart}: weak fit`), h("span", { class: "tag ours" }, `Our read · ${fmt(g.meanFit)}`)),
      sugg.length
        ? h("div", { class: "suggest" },
            h("span", { class: "h" }, "License"), h("span", { class: "h" }, "Match"), h("span", { class: "h" }, "Fit"),
            ...sugg.flatMap((s) => [h("span", {}, s.title.name), h("span", { class: "num", title: `Qloo affinity ${s.affinity.toFixed(3)}` }, fmt(s.match)), h("span", { class: "num" }, fmt(s.fit))]))
        : h("p", { class: "empty" }, "Qloo returned no candidates outside your library."),
      h("p", { class: "empty", style: { margin: "8px 0 0", fontSize: "12px" } }, "Match: Qloo affinity to your library ", sourceTag(), ", mapped to 0–1 like handoffs (hover for the raw value) · fit for this daypart: ", h("span", { class: "tag ours" }, "Our read")),
      state.agent ? h("button", { class: "ghost gap-ask", type: "button", onclick: () => { $("#drawer").close(); openAgent(`${g.daypart} is weak. I can license one or two titles.`); } }, `Ask the agent to fix ${g.daypart}`) : null,
    ));
  }
  if (p.notAired.length) gaps.push(h("p", { class: "notaired" }, `Not aired today (the library runs longer than 24h): ${p.notAired.map((id) => names.get(id)).join(", ")}`));
  $("#tab-gaps").replaceChildren(...gaps);

  // Matrix heatmap
  const ids = p.matrix.ids;
  const n = ids.length;
  const heat = h("div", { class: "heat", style: { gridTemplateColumns: `110px repeat(${n}, minmax(18px, 34px))` } });
  heat.append(h("span", {}));
  for (const id of ids) heat.append(h("span", { class: "col-h", title: names.get(id) }, names.get(id)));
  ids.forEach((from, i) => {
    heat.append(h("span", { class: "row-h", title: names.get(from) }, names.get(from)));
    ids.forEach((to, j) => {
      const v = p.matrix.scores[i][j];
      const raw = p.matrix.raw?.[i]?.[j];
      const bg = v === null ? "transparent" : `color-mix(in srgb, var(--qloo) ${Math.round(v * 100)}%, var(--panel-2))`;
      heat.append(h("span", { class: "cell", style: { background: bg }, title: v === null ? "" : `${names.get(from)} → ${names.get(to)}: handoff ${fmt(v)} (Qloo affinity ${raw === null || raw === undefined ? "—" : raw.toFixed(3)})` }, v === null ? "" : Math.round(v * 100)));
    });
  });
  $("#tab-matrix").replaceChildren(
    h("p", {}, "How much of each row show's audience is likely to stay for each column show. Brighter means more overlap. ", sourceTag()),
    h("p", { class: "empty", style: { fontSize: "12px" } }, p.matrix.provenance === "synthetic" ? "Built from synthetic stand-in data." : "Built from Qloo affinities (one-way: fans of the row show, scored on the column show), mapped from 0.86–0.975 to 0–1. Hover a cell for the raw value."),
    heat,
    ...(p.matrix.failures.length ? [h("p", { class: "notaired" }, `${p.matrix.failures.length} lookups failed and count as no overlap.`)] : []),
  );

  // Trace: entity IDs get their show's name, so each call reads as "demographics for Columbo".
  const known = new Map([...p.shows.map((x) => [x.id, x.name]), ...p.license.map((l) => [l.title.id, l.title.name])]);
  const labelIds = (_key, v) => (typeof v === "string" && known.has(v) ? `${known.get(v)} · ${v.slice(0, 8)}…` : v);
  const rows = p.trace.map((t, i) =>
    h("tr", {},
      h("td", {}, String(i + 1)),
      h("td", { class: "tool" }, t.tool.replace("qloo_", "").replaceAll("_", "_\u200b")), // may break after "_", never mid-word
      h("td", { class: "params" }, JSON.stringify(t.params, labelIds)),
      h("td", { class: `st-${t.status}`, title: t.stale ? "Qloo didn't answer; this is an older cached answer" : "" }, t.status + (t.stale ? " · cached (old)" : t.cached ? " · cached" : "")),
      h("td", { class: "ms" }, `${t.ms}ms`),
    ));
  $("#tab-trace").replaceChildren(
    h("p", {}, `Every Qloo call behind this plan (${p.trace.length}). Only show titles and entity IDs are sent; no personal data.`),
    h("table", { class: "trace" }, h("thead", {}, h("tr", {}, ...["#", "tool", "params", "status", "time"].map((x) => h("th", {}, x)))), h("tbody", {}, ...rows)),
  );
}

// ---------- vs AI alone ----------

function renderCompareIntro() {
  const btn = h("button", { class: "ghost", id: "compare-btn", onclick: runCompare }, "Compare this day with AI alone");
  $("#tab-compare").replaceChildren(
    h("p", {}, "Would the same AI build a day this good without Qloo? This asks Claude to schedule your library from its own knowledge, then scores both days, plus the library in listed order and 50 shuffled orders, on the same scale."),
    btn,
    h("p", { class: "bench-note", style: { marginTop: "10px" } }, "On the three demo libraries, Lead-In beat Claude alone every time: audience flow 0.824 vs 0.660 (Classic TV Mix), 0.893 vs 0.769 (Classic Crime), 0.942 vs 0.897 (Cozy Mysteries)."),
  );
}

async function runCompare() {
  const btn = $("#compare-btn");
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  btn.replaceChildren(h("span", { class: "spinner", "aria-hidden": "true" }), "Asking Claude for its own schedule…");
  // Skeleton of the result table while Claude answers (about 10 s).
  const skeleton = h("div", { class: "skeleton-table", "aria-hidden": "true" },
    ...Array.from({ length: 5 }, (_, i) => h("div", { class: "sk-row" }, h("i", { class: "sk w40" }), h("i", { class: "sk w12" }), h("i", { class: `sk bar w${[30, 24, 20, 14, 18][i]}` }), h("i", { class: "sk w8" }))));
  btn.after(skeleton);
  try {
    const res = await fetch(`/api/plans/${state.plan.id}/compare`, { method: "POST" });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error ?? `HTTP ${res.status}`);
    const rows = [
      ["Lead-In (with Qloo)", r.leadIn, true],
      ...(r.aiOnly ? [["Claude alone (no Qloo)", r.aiOnly, false]] : []),
      ["Library in listed order", r.listed, false],
      [`Shuffled (average of ${r.shuffled.samples})`, r.shuffled, false],
    ];
    const max = Math.max(...rows.map(([, m]) => m.flow), 0.01);
    $("#tab-compare").replaceChildren(
      h("table", { class: "cmp" },
        h("thead", {}, h("tr", {}, h("th", {}, "Day"), h("th", {}, "Audience flow"), h("th", {}, ""), h("th", {}, "Weak"), h("th", {}, "Fit"))),
        h("tbody", {}, ...rows.map(([name, m, us]) =>
          h("tr", { class: us ? "us" : "" },
            h("td", {}, name),
            h("td", { class: "num" }, fmt(m.flow)),
            h("td", {}, h("div", { class: "bar" }, h("i", { style: { width: `${Math.round((m.flow / max) * 100)}%` } }))),
            h("td", { class: "num" }, String(Math.round(m.weakHandoffs * 10) / 10)),
            h("td", { class: "num" }, fmt(m.fit)),
          ))),
      ),
      ...(r.aiOnly
        ? [h("p", { class: "bench-note" }, `Claude's own order: ${r.aiOnly.order.join(" → ")}${r.aiOnly.repaired ? " (looped or trimmed to fill exactly 24 hours)" : ""}.`)]
        : [h("p", { class: "bench-note" }, `Claude alone wasn't run: ${r.aiOnlyError ?? "the agent isn't configured"}.`)]),
      h("p", { class: "bench-note" }, "Every day is scored with the same Qloo audience overlap and Lead-In's daypart fit, so the gap shows what Qloo's data adds; it is not a measurement of real viewers. ", h("span", { class: "tag qloo" }, "Qloo says"), " ", h("span", { class: "tag ours" }, "Our read")),
    );
  } catch (err) {
    skeleton.remove();
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    btn.textContent = "Compare this day with AI alone";
    $("#tab-compare").append(h("p", { style: { color: "var(--weak)" } }, `Couldn't compare: ${err.message}`));
  }
}

// ---------- Agent ----------

const EXAMPLES = [
  "Late night is weak. I can license one or two titles.",
  "Fix the weakest handoff in the day.",
  "Would dropping a show make the channel flow better?",
];

const TOOL_LABEL = {
  get_plan: "read plan",
  find_bridge: "Qloo: bridge titles",
  find_titles_for_daypart: "Qloo: titles for daypart",
  what_if: "what-if re-plan",
  finish: "recommend",
};

/** Reads an NDJSON response line by line. */
async function readLines(res, onLine) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(JSON.parse(line));
    }
  }
}

async function runAgentUi() {
  if (state.agentRunning || !state.library.length) return;
  state.agentRunning = true;
  lockAgentDialog(true);
  $("#agent-btn").disabled = true;
  $("#agent-btn").replaceChildren(h("span", { class: "spinner", "aria-hidden": "true" }), "The agent is working…");
  const timeline = h("ol", { class: "timeline" });
  const status = h("p", { class: "empty" }, "Planning the day, then handing it to the agent…");
  $("#agent-out").replaceChildren(status, timeline);
  let qlooCalls = 0, cached = 0;
  const counter = h("span", { class: "num" }, "0");
  $("#agent-progress").replaceChildren("Agent working… Qloo calls: ", counter);
  const add = (icon, ...content) => timeline.append(h("li", {}, h("span", { class: "ic" }, icon), h("span", {}, ...content)));
  try {
    const res = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ library: state.library, brief: $("#brief").value, ...(state.plan ? { sequence: state.seq } : {}) }) }); // start from the day on screen
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    await readLines(res, (msg) => {
      if (msg.type === "trace") {
        qlooCalls++;
        if (msg.entry.cached) cached++;
        counter.textContent = String(qlooCalls);
      } else if (msg.type === "agent_note") {
        add("…", h("span", { class: "note" }, msg.text));
      } else if (msg.type === "agent_call") {
        status.textContent = "The agent is working:";
        add("→", h("span", { class: "tool" }, TOOL_LABEL[msg.tool] ?? msg.tool), " ", argText(msg.tool, msg.args));
      } else if (msg.type === "agent_result_step") {
        add(msg.ok ? "✓" : "✗", h("span", { class: msg.ok ? "ok" : "bad" }, msg.summary));
      } else if (msg.type === "agent_done") {
        status.textContent = "What the agent did:";
        $("#agent-out").append(agentCard(msg.result, qlooCalls, cached));
      } else if (msg.type === "error") {
        throw new Error(msg.message);
      }
    });
    $("#agent-progress").replaceChildren(`Done. ${qlooCalls} Qloo calls (${cached} cached).`);
  } catch (err) {
    $("#agent-progress").replaceChildren(h("span", { style: { color: "var(--weak)" } }, `Agent stopped: ${err.message}`));
    status.textContent = `The agent stopped: ${err.message}`;
  } finally {
    state.agentRunning = false;
    lockAgentDialog(false);
    $("#agent-btn").disabled = false;
    $("#agent-btn").textContent = "Run the agent";
  }
}

function argText(tool, args) {
  if (tool === "find_bridge") return `${args.from} → ${args.to}`;
  if (tool === "find_titles_for_daypart") return String(args.daypart ?? "");
  if (tool === "what_if") {
    const parts = [...(args.add ?? []).map((a) => `+ ${a.title}`), ...(args.remove ?? []).map((t) => `− ${t}`)];
    return parts.join(", ");
  }
  if (tool === "get_plan") return args.id ? String(args.id) : "current";
  return "";
}

function agentCard(r, qlooCalls, cached) {
  const list = (items, tag) =>
    items.length ? h("ul", {}, ...items.map((x) => h("li", {}, x))) : h("p", { class: "empty" }, tag === "qloo" ? "No Qloo figures quoted." : "—");
  const parts = [h("p", { class: "rec" }, r.recommendation)];
  if (r.adopted) {
    const flow = r.adopted.plan.schedule.flow;
    const change = [...r.adopted.add.map((t) => `+ ${t}`), ...r.adopted.remove.map((t) => `− ${t}`)].join(", ");
    parts.push(
      h("div", { class: "change" },
        h("span", {}, `${change} · audience flow ${fmt(r.baselineFlow)} → ${fmt(flow)}`),
        h("button", { class: "ghost", onclick: () => adoptAgentPlan(r.adopted) }, "Load this day"),
      ),
    );
  } else {
    parts.push(h("p", { class: "empty" }, "No change adopted: the agent recommends keeping the current plan."));
  }
  parts.push(
    h("p", {}, h("span", { class: "tag qloo" }, "Qloo says")), list(r.qlooEvidence, "qloo"),
    h("p", {}, h("span", { class: "tag ours" }, "Our read")), list(r.ourRead, "ours"),
  );
  const u = r.usage;
  const model = (u.models ?? []).join(", ");
  parts.push(h("p", { class: "usage" }, `${u.llmCalls} Claude calls (${model}) · ${(u.promptTokens + u.completionTokens).toLocaleString()} tokens · $${u.usd.toFixed(3)} · ${qlooCalls} Qloo calls (${cached} cached)${r.stoppedBecause ? " · stopped: " + r.stoppedBecause : ""}`));
  return h("div", { class: "agent-card" }, ...parts);
}

/** Puts the agent's adopted day on the grid, and the change into the library so re-plans keep it. */
function adoptAgentPlan(adopted) {
  const removed = new Set(adopted.remove.map((t) => t.toLowerCase()));
  const resolved = new Map((state.plan?.shows ?? []).map((s) => [s.name.toLowerCase(), s]));
  state.library = state.library.filter((item) => !removed.has(item.name.toLowerCase()) && !removed.has((resolved.get(item.name.toLowerCase())?.name ?? "").toLowerCase()));
  for (const title of adopted.add) {
    const show = adopted.plan.shows.find((s) => s.name === title);
    state.library.push(show ? { name: show.name, qlooId: show.id, runtimeMinutes: show.runtimeMinutes, ...(show.year ? { year: show.year } : {}) } : { name: title });
  }
  state.edited = true;
  renderPresets();
  loadPlan(adopted.plan);
  $("#agent-dialog").close();
}

$("#agent-form").addEventListener("submit", (e) => { e.preventDefault(); runAgentUi(); });

/** Opens the agent dialog, optionally with a goal filled in (the Fix buttons). Running it is still the user's click: it costs money. */
function openAgent(brief) {
  if (brief) $("#brief").value = brief;
  const d = $("#agent-dialog");
  if (!d.open) d.showModal();
  $("#brief").focus();
}
$("#examples").replaceChildren(...EXAMPLES.map((text) => h("button", { type: "button", onclick: () => ($("#brief").value = text) }, text)));

// ---------- App bar: insights drawer, dialogs, theme ----------

$("#drawer-btn").addEventListener("click", () => $("#drawer").showModal());
for (const d of document.querySelectorAll("dialog")) {
  // A tap on the backdrop (the dialog element itself, outside its content box) closes it; Esc closes it natively.
  d.addEventListener("click", (e) => {
    if (e.target !== d) return;
    const r = d.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside && !d.dataset.locked) d.close();
  });
  d.querySelector("[data-close]")?.addEventListener("click", () => { if (!d.dataset.locked) d.close(); });
  // Esc: blocked while locked. Browsers may force-close on a repeated Esc, so a locked dialog reopens itself.
  d.addEventListener("cancel", (e) => { if (d.dataset.locked) e.preventDefault(); });
  d.addEventListener("close", () => { if (d.dataset.locked) d.showModal(); });
}

/** While the agent works its dialog can't be dismissed, and the goal can't change under it. */
function lockAgentDialog(locked) {
  const d = $("#agent-dialog");
  if (locked) d.dataset.locked = "1";
  else delete d.dataset.locked;
  d.querySelector("[data-close]").disabled = locked;
  $("#brief").disabled = locked;
  for (const chip of $("#examples").querySelectorAll("button")) chip.disabled = locked;
}

const systemLight = matchMedia("(prefers-color-scheme: light)");
const currentTheme = () => document.documentElement.dataset.theme ?? (systemLight.matches ? "light" : "dark");
function syncThemeButton() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  $("#theme-btn").setAttribute("aria-label", `Switch to ${next} mode`);
}
$("#theme-btn").addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("lead-in-theme", next); } catch { /* storage blocked: the choice lasts for this visit */ }
  syncThemeButton();
});
systemLight.addEventListener("change", syncThemeButton);
syncThemeButton();

// ---------- Boot ----------

(async () => {
  try {
    state.presets = await (await fetch("/api/presets")).json();
    renderPresets(); // nothing selected yet: planning waits for a library
    renderLibrary();
    const health = await (await fetch("/api/health")).json();
    state.agent = !!health.agent;
    if (state.view) renderSchedule();
  } catch {
    $("#progress").textContent = "Couldn't reach the Lead-In server.";
  }
})();
