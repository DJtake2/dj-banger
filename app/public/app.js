/* ============================================================================
   Frontend logic. Data source: Server-Sent Events from the bridge (bridge.mjs),
   which runs the Phase 1–3 engine and pushes suggestions on every track change.
   Runs identically in a plain browser (for design/dev) and inside the Tauri webview.
   Native file drag-into-Serato is used when running under Tauri; otherwise it's a
   harmless HTML5 drag (visual only) so the layout is fully previewable in a browser.
   ============================================================================ */

const IS_TAURI = typeof window.__TAURI__ !== "undefined";

const el = (id) => document.getElementById(id);
const statusDot = el("statusDot");
const statusText = el("statusText");
const now = el("now");
const list = el("list");
const empty = el("empty");
const nextHead = el("nextHead");
const nextMeta = el("nextMeta");

// ---- Camelot key → identity color (the "wheel") ----------------------------
// Each Camelot number has its own hue (a rainbow ring, like Mixed In Key / the wheel DJs know).
// This is the Banger Button signature: you read the key by colour at a glance.
const CAMELOT_HEX = {
  1: "#6fe06f", 2: "#4fd6a6", 3: "#41c6db", 4: "#4aa2e8", 5: "#6f83e8", 6: "#9a6fe0",
  7: "#c76fd6", 8: "#ea6fae", 9: "#f2776f", 10: "#f2a15b", 11: "#e8c750", 12: "#a6d95b",
};
function camelotColor(camelot) {
  const m = /^(\d{1,2})([AB])$/i.exec(camelot || "");
  if (!m) return null;
  return CAMELOT_HEX[+m[1]] || null;
}
// Inline style for a key badge tinted by its own key colour (falls back to neutral).
function keyBadgeStyle(camelot) {
  const c = camelotColor(camelot);
  if (!c) return "color:var(--text-dim);background:var(--surface-3);border-color:var(--border-soft)";
  return `color:${c};background:color-mix(in srgb, ${c} 15%, transparent);border-color:color-mix(in srgb, ${c} 40%, transparent)`;
}

// ---- key-match quality → color var (used for the left "compatibility" bar) --
function matchVar(band) {
  return {
    perfect: "var(--match-perfect)",
    good: "var(--match-good)",
    boost: "var(--match-boost)",
    ok: "var(--text-faint)",
    clash: "var(--match-clash)",
    unknown: "var(--border)",
  }[band] || "var(--border)";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---- render now-playing ----------------------------------------------------
function renderNow(np, source) {
  if (!np) { now.hidden = true; return; }
  now.hidden = false;
  const prep = source === "prep";
  now.classList.toggle("prep", prep);
  el("npLabel").textContent = prep ? "PREP" : "NOW PLAYING";
  el("backLive").hidden = !prep;
  el("npTitle").textContent = np.title || np.id || "—";
  el("npArtist").textContent = np.artist || "";
  const npKeyColor = camelotColor(np.camelot) || "var(--accent-2)";
  el("npStats").innerHTML = `
    ${np.camelot ? `<span class="chip key"><span class="ring" style="background:${npKeyColor}"></span><span class="lbl">KEY</span><span style="color:${npKeyColor};font-weight:700">${esc(np.camelot)}</span></span>` : ""}
    ${np.bpm ? `<span class="chip"><span class="lbl">BPM</span>${Math.round(np.bpm)}</span>` : ""}
    <span class="chip energy">
      <span class="lbl">EN</span>
      <span class="meter"><i style="width:${(np.energy || 0) * 10}%"></i></span>
      <span class="val">${np.energy ?? "?"}</span>
      ${np.energyReal ? "" : '<span class="est">EST</span>'}
    </span>`;
}

// ---- render one suggestion row --------------------------------------------
function rowHtml(s, i, animate) {
  const q = matchVar(s.match);
  const dz = s.bpmDelta === 0 ? "±0" : (s.bpmDelta > 0 ? `+${s.bpmDelta}` : `${s.bpmDelta}`);
  const bpmMult = s.bpmMult ? `<span class="mult">${s.bpmMult}</span> ` : "";
  const reasonPills = (s.reasons || []).slice(0, 2).map((r) => `<span class="pill">${esc(r)}</span>`).join("");
  const reasons = reasonPills ? `<div class="reasons">${reasonPills}</div>` : "";
  return `
  <div class="row ${animate ? "enter" : ""} ${selected.has(s.id) ? "sel" : ""}" style="--q:${q}"
       draggable="true" data-path="${esc(s.absPath)}" data-id="${esc(s.id)}">
    <div class="check" data-check="${esc(s.id)}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l5 5 9-10" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
    <div class="main">
      <div class="t"><span class="rank">${String(i + 1).padStart(2, "0")}</span>${esc(s.title)}</div>
      <div class="a">${esc(s.artist)}</div>
      ${reasons}
    </div>
    <div class="side">
      <div class="kv">
        ${s.camelot ? `<span class="keybadge" style="${keyBadgeStyle(s.camelot)}">${esc(s.camelot)}</span>` : ""}
        <span class="bpm"><b>${s.bpm ? Math.round(s.bpm) : "–"}</b> ${s.bpm ? bpmMult + dz : ""}</span>
      </div>
      <div class="mini-energy">
        <span class="m"><i style="width:${(s.energy || 0) * 10}%"></i></span>
        <span class="n">${s.energy ?? "?"}</span>
      </div>
      <div class="score">
        <span class="bar"><i style="width:${Math.round((s.score || 0) * 100)}%"></i></span>
        <span class="num">${(s.score || 0).toFixed(2)}</span>
      </div>
    </div>
  </div>`;
}

function renderList(data) {
  const items = data.list || [];
  if (!items.length) {
    empty.hidden = false;
    nextHead.hidden = true;
    el("filters").hidden = true;
    return;
  }
  empty.hidden = true;
  nextHead.hidden = false;
  el("filters").hidden = false;
  nextMeta.textContent = `${items.length} matches · ${Math.round(data.computeMs || 0)}ms`;
  list.innerHTML = items.map((s, i) => rowHtml(s, i, true)).join("");
  wireDrag();
  wireSelect(items);
}

// ---- multi-select → crate --------------------------------------------------
const selected = new Map(); // id → {title, artist}
const selbar = el("selbar");

function refreshSelbar() {
  const n = selected.size;
  selbar.hidden = n === 0;
  if (n) el("selCount").textContent = `${n} selected`;
}

function wireSelect(items) {
  const byId = new Map(items.map((s) => [s.id, s]));
  for (const chk of list.querySelectorAll(".check")) {
    chk.addEventListener("mousedown", (e) => e.stopPropagation());
    chk.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = chk.dataset.check;
      const row = chk.closest(".row");
      if (selected.has(id)) { selected.delete(id); row.classList.remove("sel"); }
      else { selected.set(id, byId.get(id) || {}); row.classList.add("sel"); }
      refreshSelbar();
    });
  }
}

el("selClear").addEventListener("click", () => {
  selected.clear();
  for (const row of list.querySelectorAll(".row.sel")) row.classList.remove("sel");
  refreshSelbar();
});
el("selExport").addEventListener("click", async () => {
  const ids = [...selected.keys()];
  if (!ids.length) return;
  const btn = el("selExport");
  btn.textContent = "Exporting…"; btn.disabled = true;
  try {
    const r = await fetch("/crate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids, name: "Banger Picks" }),
    });
    const j = await r.json();
    btn.textContent = j.ok ? `✓ ${j.count} → crate` : "Failed";
    if (j.ok) { selected.clear(); for (const row of list.querySelectorAll(".row.sel")) row.classList.remove("sel"); }
  } catch { btn.textContent = "Failed"; }
  setTimeout(() => { btn.textContent = "Export crate"; btn.disabled = false; refreshSelbar(); }, 1400);
});

// ---- filters ---------------------------------------------------------------
el("energyFilter").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  for (const b of el("energyFilter").querySelectorAll("button")) b.classList.toggle("on", b === btn);
  fetch("/filter", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ energy: btn.dataset.v }) }).catch(() => {});
});
el("genreFilter").addEventListener("change", (e) => {
  fetch("/filter", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ genre: e.target.value }) }).catch(() => {});
});
function populateGenres(genres) {
  const sel = el("genreFilter");
  if (sel.dataset.filled) return;
  sel.dataset.filled = "1";
  for (const g of genres || []) {
    const o = document.createElement("option");
    o.value = g; o.textContent = g;
    sel.appendChild(o);
  }
}

// ---- streaming (Spotify) ---------------------------------------------------
function renderStreaming(d) {
  const stream = el("stream");
  const sl = el("streamList");
  el("streamMeta").textContent = d.connected ? `${(d.tracks || []).length} picks` : "not connected";
  if (!d.connected) {
    stream.hidden = false;
    sl.innerHTML = `<div class="connect">Connect Spotify to surface tracks beyond your library.
      Set <code>SPOTIFY_CLIENT_ID</code> and <code>SPOTIFY_CLIENT_SECRET</code> and restart.</div>`;
    return;
  }
  const tracks = d.tracks || [];
  if (!tracks.length) { stream.hidden = true; return; }
  stream.hidden = false;
  sl.innerHTML = tracks.map((t) => `
    <div class="srow ${t.owned ? "owned" : ""}" ${t.owned ? `data-id="${esc(t.ownedId)}" title="Prep this owned track"` : ""}>
      <div style="min-width:0">
        <div class="st">${esc(t.title)}</div>
        <div class="sa">${esc(t.artist)}</div>
      </div>
      ${t.owned ? `<span class="tag owned">IN LIBRARY</span>` : `<span class="tag sp">SPOTIFY</span>`}
    </div>`).join("");
  // Owned tracks → click to prep against them (you already have them).
  for (const row of sl.querySelectorAll(".srow.owned")) {
    row.addEventListener("click", () => {
      fetch("/seed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: row.dataset.id }) }).catch(() => {});
    });
  }
}

// ---- drag-out to Serato ----------------------------------------------------
function wireDrag() {
  for (const row of list.querySelectorAll(".row")) {
    row.addEventListener("dragstart", async (e) => {
      row.classList.add("dragging");
      const path = row.dataset.path;
      if (IS_TAURI) {
        // Native OS drag of the real file → Serato accepts it on a deck.
        try {
          e.preventDefault();
          const drag = window.__TAURI__?.drag || window.__TAURI__?.plugins?.drag;
          if (drag?.startDrag) await drag.startDrag({ item: [path] });
          else await window.__TAURI__.core.invoke("start_file_drag", { path });
        } catch (err) { console.warn("native drag failed", err); }
      } else {
        // Browser dev fallback: expose the path so the layout is fully testable.
        e.dataTransfer.setData("text/uri-list", "file://" + path);
        e.dataTransfer.setData("text/plain", path);
        e.dataTransfer.effectAllowed = "copy";
      }
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
  }
}

// ---- connection state ------------------------------------------------------
function setConnected(on, text) {
  statusDot.classList.toggle("off", !on);
  statusText.textContent = text;
}

// ---- energy trajectory toggle ---------------------------------------------
el("energySeg").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  for (const b of el("energySeg").children) b.classList.toggle("on", b === btn);
  fetch("/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ energyDirection: btn.dataset.dir }),
  }).catch(() => {});
});

// ---- SSE stream ------------------------------------------------------------
function connect() {
  const es = new EventSource("/events");
  es.onopen = () => setConnected(true, "watching Serato");
  es.onerror = () => setConnected(false, "reconnecting…");
  es.addEventListener("state", (ev) => {
    const d = JSON.parse(ev.data);
    setConnected(true, `${d.librarySize.toLocaleString()} tracks`);
    populateGenres(d.genres);
    // Sync controls to the server's actual state (survives reconnects / prior changes).
    if (d.filter) {
      for (const b of el("energyFilter").querySelectorAll("button")) b.classList.toggle("on", b.dataset.v === (d.filter.energy || "any"));
      el("genreFilter").value = d.filter.genre && d.filter.genre !== "any" ? d.filter.genre : "any";
    }
    if (d.energyDirection) {
      for (const b of el("energySeg").children) b.classList.toggle("on", b.dataset.dir === d.energyDirection);
    }
    if (d.streaming) renderStreaming({ ...d.streaming, tracks: [] });
  });
  es.addEventListener("suggestions", (ev) => {
    const d = JSON.parse(ev.data);
    renderNow(d.nowPlaying, d.source);
    renderList(d);
  });
  es.addEventListener("streaming", (ev) => {
    renderStreaming(JSON.parse(ev.data));
  });
}

// ---- prep search -----------------------------------------------------------
const searchInput = el("searchInput");
const dropdown = el("dropdown");
const clearBtn = el("clearSearch");
let searchTimer = null;
let matches = [];
let activeIdx = -1;

function hideDropdown() { dropdown.hidden = true; activeIdx = -1; }

function renderDropdown() {
  if (!matches.length) {
    dropdown.innerHTML = `<div class="none">No tracks found</div>`;
    dropdown.hidden = false;
    return;
  }
  dropdown.innerHTML = matches.map((m, i) => `
    <div class="opt ${i === activeIdx ? "active" : ""}" data-i="${i}">
      <div style="min-width:0">
        <div class="ot">${esc(m.title)}</div>
        <div class="oa">${esc(m.artist)}</div>
      </div>
      <div class="ok">
        ${m.camelot ? `<span class="okey" style="${keyBadgeStyle(m.camelot)}">${esc(m.camelot)}</span>` : ""}
        ${m.bpm ? `<span class="obpm">${m.bpm}</span>` : ""}
      </div>
    </div>`).join("");
  dropdown.hidden = false;
  for (const opt of dropdown.querySelectorAll(".opt")) {
    opt.addEventListener("mousedown", (e) => { e.preventDefault(); pickMatch(Number(opt.dataset.i)); });
  }
}

async function runSearch(q) {
  if (q.trim().length < 2) { hideDropdown(); matches = []; return; }
  try {
    const r = await fetch("/search?q=" + encodeURIComponent(q));
    matches = (await r.json()).matches || [];
    activeIdx = -1;
    renderDropdown();
  } catch { hideDropdown(); }
}

function pickMatch(i) {
  const m = matches[i];
  if (!m) return;
  searchInput.value = "";
  clearBtn.hidden = true;
  hideDropdown();
  fetch("/seed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: m.id }),
  }).catch(() => {});
}

searchInput.addEventListener("input", () => {
  const q = searchInput.value;
  clearBtn.hidden = !q;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(q), 180);
});
searchInput.addEventListener("keydown", (e) => {
  if (dropdown.hidden) return;
  if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, matches.length - 1); renderDropdown(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); renderDropdown(); }
  else if (e.key === "Enter") { e.preventDefault(); pickMatch(activeIdx >= 0 ? activeIdx : 0); }
  else if (e.key === "Escape") { hideDropdown(); }
});
searchInput.addEventListener("blur", () => setTimeout(hideDropdown, 120));
clearBtn.addEventListener("click", () => {
  searchInput.value = ""; clearBtn.hidden = true; hideDropdown(); matches = []; searchInput.focus();
});
el("backLive").addEventListener("click", () => {
  fetch("/live", { method: "POST" }).catch(() => {});
});

connect();
