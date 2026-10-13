// Lead-In UI. Plain DOM building: every user- or API-supplied string goes in via textContent, never innerHTML.

const $ = (sel) => document.querySelector(sel);

/** h("div", {class: "x", onclick}, child, "text") → element. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const state = {
  presets: [],
  presetId: null,
  library: [],
  plan: null,
  seq: [],
  view: null, // { slots, flow, violations } for the current order
  planning: false,
};

const dpClass = (name) => "dp-" + name.toLowerCase().replace(/\s+/g, "-");
function strength(slot, next, weak) {
  if (slot.showId === next.showId) return "stack";
  if (slot.handoffScore < weak) return "weak";
  return slot.handoffScore >= 0.6 ? "strong" : "mid";
}
const fmt = (x) => (x === null || x === undefined ? "—" : Number(x).toFixed(2));

// ---------- Library ----------

function renderPresets() {
  const box = $("#presets");
  box.replaceChildren(
    ...state.presets.map((p) =>
      h("button", {
        class: "preset", role: "radio", "aria-checked": String(p.id === state.presetId),
        onclick: () => { state.presetId = p.id; state.library = p.library.map((s) => ({ ...s })); renderPresets(); renderLibrary(); },
      }, h("strong", {}, p.name), h("span", {}, p.description)),
    ),
  );
}

function renderLibrary() {
  const ambiguous = new Set((state.plan?.unresolved ?? []).map((u) => u.name.toLowerCase()));
  $("#library").replaceChildren(
    ...state.library.map((s, i) =>
      h("li", { class: ambiguous.has(s.name.toLowerCase()) ? "ambiguous" : "" },
        h("span", { class: "name", title: s.name }, s.name),
        h("span", { class: "rt num" }, s.runtimeMinutes ? `${s.runtimeMinutes}m` : "TMDB"),
        h("button", { class: "icon-btn", "aria-label": `Remove ${s.name}`, onclick: () => { state.library.splice(i, 1); renderLibrary(); } }, "×"),
      ),
    ),
  );
}

$("#add-show").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("#new-name").value.trim();
  const rt = Number($("#new-runtime").value);
  if (!name) return;
  state.library.push(rt >= 5 && rt <= 240 ? { name, runtimeMinutes: Math.round(rt) } : { name });
  state.presetId = null;
  $("#new-name").value = "";
  $("#new-runtime").value = "";
  renderPresets();
  renderLibrary();
});

// ---------- Planning (streamed) ----------

async function planChannel() {
  if (state.planning || !state.library.length) return;
  state.planning = true;
  $("#plan-btn").disabled = true;
  $("#needs-input").replaceChildren();
  const ticker = h("div", { class: "ticker" });
  const count = h("span", { class: "num" }, "0");
  $("#progress").replaceChildren(h("div", {}, "Asking Qloo… calls so far: ", count), ticker);

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
  } finally {
    state.planning = false;
    $("#plan-btn").disabled = false;
  }
}
$("#plan-btn").addEventListener("click", planChannel);

function loadPlan(plan) {
  state.plan = plan;
  state.seq = plan.schedule.slots.map((s) => s.showId);
  state.view = plan.schedule;
  const badge = $("#source-badge");
  badge.hidden = false;
  badge.className = "badge " + (plan.synthetic ? "synthetic" : "live");
  badge.textContent = plan.synthetic ? "Synthetic stand-in data · no Qloo key configured" : "Live Qloo data";
  renderLibrary();
  renderNeedsInput();
  renderSchedule();
  renderInsights();
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
          : [h("strong", {}, `“${u.name}” not found.`), " Qloo has no TV show by that name; it was left out."],
        h("div", { class: "choices" },
          ...(u.candidates ?? []).map((c) =>
            h("button", {
              class: "ghost",
              onclick: () => {
                const item = state.library.find((s) => s.name.toLowerCase() === u.name.toLowerCase());
                // Send the picked ID: two shows can share a title (Matlock 1986 and 2024).
                if (item) Object.assign(item, { name: c.name, qlooId: c.id });
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

// ---------- Schedule ----------

function renderFlow(prev) {
  const flow = state.view.flow;
  const base = state.plan.schedule.flow;
  const delta = Math.round((flow - base) * 1000) / 1000;
  const parts = [h("span", { class: "label" }, "Audience flow"), h("span", { class: "value", title: "Mean handoff score between different shows (stacked episodes excluded)" }, fmt(flow))];
  if (Math.abs(delta) >= 0.001) parts.push(h("span", { class: "delta " + (delta > 0 ? "up" : "down") }, `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(3)} vs Lead-In`));
  $("#flow").replaceChildren(...parts);
}

function renderStrip() {
  const slots = state.view.slots;
  const weak = state.plan.rules.weakHandoff;
  const bar = h("div", { class: "bar" },
    ...slots.map((s, i) => {
      const next = slots[(i + 1) % slots.length];
      return h("div", {
        class: `block ${dpClass(s.daypart)} h-${strength(s, next, weak)}`,
        style: { flex: `${s.units} 1 0` },
        title: `${s.time} ${s.name} → ${next.name}: ${fmt(s.handoffScore)}`,
      }, h("span", { class: "t" }, s.time), h("span", { class: "n" }, s.name));
    }),
  );
  const ticks = h("div", { class: "ticks" }, ...["06", "09", "12", "15", "18", "21", "00", "03", "06"].map((t) => h("span", {}, t)));
  $("#strip").replaceChildren(bar, ticks);
}

function renderViolations() {
  const v = state.view.violations ?? [];
  $("#violations").replaceChildren(
    ...(v.length ? [h("strong", {}, "This order breaks the channel's rules:"), h("ul", {}, ...v.map((x) => h("li", {}, x)))] : []),
  );
}

let dragFrom = null;
let changedHandoffs = new Set();

function renderGrid() {
  const slots = state.view.slots;
  const weak = state.plan.rules.weakHandoff;
  const items = [];
  slots.forEach((s, i) => {
    const next = slots[(i + 1) % slots.length];
    const card = h("li", {
      class: "slot", draggable: "true", "data-index": i,
      ondragstart: (e) => { dragFrom = i; card.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; },
      ondragend: () => card.classList.remove("dragging"),
      ondragover: (e) => { e.preventDefault(); card.classList.add("drop-target"); },
      ondragleave: () => card.classList.remove("drop-target"),
      ondrop: (e) => { e.preventDefault(); card.classList.remove("drop-target"); if (dragFrom !== null) move(dragFrom, i); dragFrom = null; },
    },
      h("div", { class: "time" }, s.time, h("span", { class: "dp" }, s.daypart)),
      h("div", {},
        h("div", { class: "title", title: s.name }, s.name),
        h("div", { class: "meta" },
          h("span", { title: "Daypart fit: how this show's Qloo audience skew matches who watches at this hour (our read)" },
            "fit ", h("span", { class: "fitbar" }, h("i", { style: { width: `${Math.round(s.fit * 100)}%` } })), " ", h("span", { class: "num" }, fmt(s.fit))),
          h("span", {}, `${s.units * 30} min slot`),
        ),
      ),
      h("div", { class: "moves" },
        h("button", { class: "icon-btn", "aria-label": `Move ${s.name} earlier`, disabled: i === 0, onclick: () => move(i, i - 1) }, "↑"),
        h("button", { class: "icon-btn", "aria-label": `Move ${s.name} later`, disabled: i === slots.length - 1, onclick: () => move(i, i + 1) }, "↓"),
      ),
    );
    items.push(card);
    const kind = strength(s, next, weak);
    const label = kind === "stack" ? "next episode (stacked)" : kind === "weak" ? "weak handoff: this audience mostly leaves" : kind === "strong" ? "strong handoff" : "ok handoff";
    items.push(h("li", { class: `handoff h-${kind}${changedHandoffs.has(i) ? " changed" : ""}`, "aria-label": `${s.name} to ${next.name}: ${label}` },
      h("span", { class: "arrow" }),
      kind === "stack" ? null : h("span", { class: "score" }, fmt(s.handoffScore)),
      h("span", { class: "why" }, i === slots.length - 1 ? `${label} · wraps to the next day` : label),
    ));
  });
  $("#grid").replaceChildren(...items);
}

function renderSchedule() {
  $("#schedule-hint").textContent = "Drag a show (or use ↑ ↓) to try your own order. Every handoff is re-scored. Red means that audience mostly leaves.";
  $("#reset-btn").hidden = state.seq.join() === state.plan.schedule.slots.map((s) => s.showId).join();
  renderFlow();
  renderStrip();
  renderViolations();
  renderGrid();
}

async function move(from, to) {
  if (from === to || to < 0 || to >= state.seq.length) return;
  const seq = [...state.seq];
  const [item] = seq.splice(from, 1);
  seq.splice(to, 0, item);
  await rescore(seq);
}

async function rescore(seq) {
  const before = state.view.slots.map((s) => `${s.showId}>${fmt(s.handoffScore)}`);
  const res = await fetch(`/api/plans/${state.plan.id}/score`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sequence: seq }) });
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`;
    $("#violations").replaceChildren(h("strong", {}, msg));
    return;
  }
  state.seq = seq;
  state.view = await res.json();
  changedHandoffs = new Set(state.view.slots.map((s, i) => (`${s.showId}>${fmt(s.handoffScore)}` !== before[i] ? i : -1)).filter((i) => i >= 0));
  renderSchedule();
  changedHandoffs = new Set();
}

$("#reset-btn").addEventListener("click", () => rescore(state.plan.schedule.slots.map((s) => s.showId)));

// ---------- Insights ----------

for (const tab of document.querySelectorAll('[role="tab"]')) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll('[role="tab"]')) {
      t.setAttribute("aria-selected", String(t === tab));
      $(`#tab-${t.dataset.tab}`).hidden = t !== tab;
    }
  });
}

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
            h("span", { class: "h" }, "License"), h("span", { class: "h" }, "Affinity"), h("span", { class: "h" }, "Fit"),
            ...sugg.flatMap((s) => [h("span", {}, s.title.name), h("span", { class: "num" }, fmt(s.affinity)), h("span", { class: "num" }, fmt(s.fit))]))
        : h("p", { class: "empty" }, "Qloo returned no candidates outside your library."),
      h("p", { class: "empty", style: { margin: "8px 0 0", fontSize: "12px" } }, "Affinity: ", sourceTag(), " · fit for this daypart: ", h("span", { class: "tag ours" }, "Our read")),
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
      const bg = v === null ? "transparent" : `color-mix(in srgb, var(--qloo) ${Math.round(v * 100)}%, #151b2a)`;
      heat.append(h("span", { class: "cell", style: { background: bg }, title: v === null ? "" : `${names.get(from)} → ${names.get(to)}: handoff ${fmt(v)} (Qloo affinity ${raw === null || raw === undefined ? "—" : raw.toFixed(3)})` }, v === null ? "" : Math.round(v * 100)));
    });
  });
  $("#tab-matrix").replaceChildren(
    h("p", {}, "How much of each row show's audience is likely to stay for each column show. Brighter means more overlap. ", sourceTag()),
    h("p", { class: "empty", style: { fontSize: "12px" } }, p.matrix.provenance === "synthetic" ? "Built from synthetic stand-in data." : "Built from Qloo affinities (one-way: fans of the row show, scored on the column show), mapped from 0.86–0.975 to 0–1. Hover a cell for the raw value."),
    heat,
    ...(p.matrix.failures.length ? [h("p", { class: "notaired" }, `${p.matrix.failures.length} lookups failed and count as no overlap.`)] : []),
  );

  // Trace
  const rows = p.trace.map((t, i) =>
    h("tr", {},
      h("td", {}, String(i + 1)),
      h("td", {}, t.tool.replace("qloo_", "")),
      h("td", {}, JSON.stringify(t.params)),
      h("td", { class: `st-${t.status}` }, t.status + (t.cached ? " · cached" : "")),
      h("td", {}, `${t.ms}ms`),
    ));
  $("#tab-trace").replaceChildren(
    h("p", {}, `Every Qloo call behind this plan (${p.trace.length}). Only show titles and entity IDs are sent; no personal data.`),
    h("table", { class: "trace" }, h("thead", {}, h("tr", {}, ...["#", "tool", "params", "status", "time"].map((x) => h("th", {}, x)))), h("tbody", {}, ...rows)),
  );
}

// ---------- Boot ----------

(async () => {
  try {
    state.presets = await (await fetch("/api/presets")).json();
    const first = state.presets[0];
    if (first) { state.presetId = first.id; state.library = first.library.map((s) => ({ ...s })); }
    renderPresets();
    renderLibrary();
  } catch {
    $("#progress").textContent = "Couldn't reach the Lead-In server.";
  }
})();
