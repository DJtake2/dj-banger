/* ============================================================================
   Banger frontend — two-column deck split.
   Each Serato deck gets its own column: now-playing + library recs + Spotify recs,
   with a per-deck filter (BPM range / ±3·±5·±10 + compatible keys). Fed by bridge.mjs
   over SSE. Runs the same in a browser (dev) and the Tauri webview.
   ============================================================================ */

const IS_TAURI = typeof window.__TAURI__ !== "undefined";
const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---- Camelot key colours (the wheel) --------------------------------------
const CAMELOT_HEX = {
  1: "#6fe06f", 2: "#4fd6a6", 3: "#41c6db", 4: "#4aa2e8", 5: "#6f83e8", 6: "#9a6fe0",
  7: "#c76fd6", 8: "#ea6fae", 9: "#f2776f", 10: "#f2a15b", 11: "#e8c750", 12: "#a6d95b",
};
function camelotColor(camelot) {
  const m = /^(\d{1,2})([AB])$/i.exec(camelot || "");
  return m ? CAMELOT_HEX[+m[1]] || null : null;
}
function keyBadgeStyle(camelot) {
  const c = camelotColor(camelot);
  if (!c) return "color:var(--text-dim);background:var(--surface-3);border-color:var(--border-soft)";
  return `color:${c};background:color-mix(in srgb, ${c} 15%, transparent);border-color:color-mix(in srgb, ${c} 40%, transparent)`;
}
function shiftLabel(n) {
  if (n == null) return "";
  return n === 0 ? "±0" : n > 0 ? `+${n}` : `${n}`;
}

const SNOWFLAKE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2v20M4 6l16 12M20 6 4 18" stroke-linecap="round"/></svg>`;

// ---- state -----------------------------------------------------------------
let lastDecks = null;             // last "decks" payload
const streamingByDeck = {};       // deck -> { connected, tracks }
let streamingStatusGlobal = { connected: false };
let openFilterDeck = null;        // which deck's filter popover is open

// ---- multi-select → crate --------------------------------------------------
const selected = new Map();
function refreshSelbar() {
  const n = selected.size;
  el("selbar").hidden = n === 0;
  if (n) el("selCount").textContent = `${n} selected`;
}

// ---- render ----------------------------------------------------------------
function deckName(deck) { return deck === 0 ? "PREP" : `Deck ${deck}`; }

function rowHtml(s, kind) {
  const path = s.absPath || "";                       // present for library + owned-spotify
  const id = s.id || "";
  const draggable = path ? `draggable="true" data-path="${esc(path)}"` : "";
  const bpm = s.bpm ? Math.round(s.bpm) : "";
  const mult = s.bpmMult ? `<span class="rmult">${s.bpmMult}</span>` : "";
  const key = s.camelot ? `<span class="keybadge" style="${keyBadgeStyle(s.camelot)}">${esc(s.camelot)}</span>` : `<span></span>`;
  // right cell: harmonic shift when we know the key, else a source tag
  const right = s.keyShift != null
    ? `<span class="shift">${shiftLabel(s.keyShift)}</span>`
    : kind === "spotify"
      ? `<span class="shift">${s.owned ? "OWN" : "SP"}</span>`
      : `<span class="shift"></span>`;
  // left cell: a checkbox for real files (crate-exportable), a source dot for streaming-only
  const left = path
    ? `<span class="rcheck" data-check="${esc(id)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l5 5 9-10" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`
    : `<span class="src sp"></span>`;
  const cls = path && selected.has(id) ? "drow sel" : "drow";
  return `<div class="${cls}" ${draggable} data-id="${esc(id)}">
    ${left}
    <div class="rmain"><div class="rt">${esc(s.title)}</div><div class="ra">${esc(s.artist || "")}</div></div>
    <span class="rbpm">${bpm}${mult}</span>
    ${key}
    ${right}
  </div>`;
}

function keyGroupHtml(label, keys, selKeys) {
  if (!keys || !keys.length) return "";
  const chips = keys.map((k) => {
    const c = camelotColor(k) || "var(--text-dim)";
    const on = selKeys.includes(k) ? "sel" : "";
    return `<span class="kchip ${on}" data-key="${esc(k)}" style="color:${c};background:color-mix(in srgb, ${c} 16%, transparent)">${esc(k)}</span>`;
  }).join("");
  return `<div class="keygroup"><div class="kglabel">${label}</div><div class="kgkeys">${chips}</div></div>`;
}

function filterPopHtml(dk) {
  const f = dk.filter || {};
  const compat = dk.compat;
  const q = (v, lbl) => `<button data-bpm="${v}" class="${f.bpm === v ? "on" : ""}">${lbl}</button>`;
  const keysBlock = compat
    ? keyGroupHtml("PERFECT MATCH", compat.perfect, f.keys || []) +
      keyGroupHtml("ENERGY BOOST", compat.boost, f.keys || []) +
      keyGroupHtml("ENERGY DROP", compat.drop, f.keys || []) +
      keyGroupHtml("MOOD CHANGE", compat.mood, f.keys || [])
    : `<div class="connect">No key on this track — key filter unavailable.</div>`;
  return `<div class="filterpop" data-pop="${dk.deck}">
    <div class="fh">BPM RANGE</div>
    <div class="rangeRow">
      <input class="fmin" type="number" inputmode="numeric" placeholder="Min" value="${f.bpmMin ?? ""}" />
      <span style="color:var(--text-faint)">to</span>
      <input class="fmax" type="number" inputmode="numeric" placeholder="Max" value="${f.bpmMax ?? ""}" />
    </div>
    <div class="quick">${q("3", "±3 BPM")}${q("5", "±5 BPM")}${q("10", "±10 BPM")}</div>
    <div class="fh">COMPATIBLE KEYS</div>
    ${keysBlock}
    <div class="fh">MIX</div>
    <div class="quick">
      <button data-clean="any" class="${(f.clean || "any") === "any" ? "on" : ""}">Any</button>
      <button data-clean="clean" class="${f.clean === "clean" ? "on" : ""}">Clean</button>
      <button data-clean="dirty" class="${f.clean === "dirty" ? "on" : ""}">Dirty</button>
    </div>
  </div>`;
}

function sectionHtml(dk, kind, tracks, meta, hint) {
  const rows = tracks.length ? tracks.map((s) => rowHtml(s, kind)).join("") : `<div class="connect">${hint || "No matches."}</div>`;
  const icon = kind === "library" ? SNOWFLAKE : `<span class="sp-dot"></span>`;
  const label = kind === "library" ? "RECOMMENDATIONS FROM YOUR LIBRARY" : "RECOMMENDATIONS FROM SPOTIFY";
  const dragHint = kind === "library" ? `<span class="drag-hint">Drag to load in Serato</span>` : "";
  return `<div class="recsec ${kind}">
    <div class="rechead">${icon} ${label} (${meta})${dragHint}</div>
    <div class="reclist">${rows}</div>
  </div>`;
}

function deckColumnHtml(dk, prep) {
  const np = dk.nowPlaying;
  const activeFilters = (dk.filter?.keys?.length ? 1 : 0) + (dk.filter?.bpm && dk.filter.bpm !== "any" ? 1 : 0) + (dk.filter?.clean && dk.filter.clean !== "any" ? 1 : 0);
  const fcount = activeFilters ? `<span class="fc">${activeFilters}</span>` : "";
  const stream = streamingByDeck[dk.deck];
  let spSection;
  if (stream && stream.connected) {
    spSection = sectionHtml(dk, "spotify", stream.tracks || [], (stream.tracks || []).length, "No streaming picks.");
  } else if (streamingStatusGlobal.connected) {
    spSection = `<div class="recsec spotify"><div class="rechead"><span class="sp-dot"></span> RECOMMENDATIONS FROM SPOTIFY</div><div class="connect">Loading…</div></div>`;
  } else {
    spSection = `<div class="recsec spotify"><div class="rechead"><span class="sp-dot"></span> RECOMMENDATIONS FROM SPOTIFY</div><div class="connect">Connect Spotify in <b>Settings</b> (gear, top-right) to surface tracks beyond your library.</div></div>`;
  }
  return `<div class="deckcol" data-deck="${dk.deck}">
    <div class="deckhead ${prep ? "prep" : ""}">
      <span class="deckname">${deckName(dk.deck)}</span>
      <div class="hmeta">
        ${prep ? `<button class="livebtn2" data-live="1">● BACK TO LIVE</button>` : ""}
        ${np.bpm ? `<span class="bpmbig">${Math.round(np.bpm)}</span>` : ""}
        ${np.camelot ? `<span class="keybadge" style="${keyBadgeStyle(np.camelot)}">${esc(np.camelot)}</span>` : ""}
        <button class="filterbtn ${openFilterDeck === dk.deck ? "on" : ""}" data-filter="${dk.deck}">Filter ${fcount} ▾</button>
      </div>
      ${openFilterDeck === dk.deck ? filterPopHtml(dk) : ""}
    </div>
    <div class="npcard">
      <div class="art">${SNOWFLAKE}</div>
      <div class="npmain"><div class="npt">${esc(np.title)}</div><div class="npa">${esc(np.artist || "")}</div></div>
    </div>
    <div class="reccol">
      ${sectionHtml(dk, "library", dk.library || [], (dk.library || []).length)}
      ${spSection}
    </div>
  </div>`;
}

function render() {
  if (!lastDecks || !lastDecks.decks?.length) return;
  const wrap = el("decksWrap");
  const prep = lastDecks.source === "prep";
  const decks = prep ? lastDecks.decks.filter((d) => d.deck === 0) : lastDecks.decks.filter((d) => d.deck !== 0);
  const shown = decks.length ? decks : lastDecks.decks;

  // preserve scroll positions
  const scrolls = {};
  for (const col of wrap.querySelectorAll(".deckcol")) {
    const rc = col.querySelector(".reccol");
    if (rc) scrolls[col.dataset.deck] = rc.scrollTop;
  }

  wrap.classList.toggle("single", shown.length === 1);
  wrap.innerHTML = shown.map((dk) => deckColumnHtml(dk, prep && dk.deck === 0)).join("");

  // restore scroll
  for (const col of wrap.querySelectorAll(".deckcol")) {
    const rc = col.querySelector(".reccol");
    if (rc && scrolls[col.dataset.deck] != null) rc.scrollTop = scrolls[col.dataset.deck];
  }
  wireDecks();
}

// ---- streaming patch (arrives async, per deck) -----------------------------
function renderStreaming(d) {
  streamingByDeck[d.deck] = d;
  streamingStatusGlobal = { connected: d.connected };
  // patch just this deck's column instead of a full re-render
  const col = el("decksWrap").querySelector(`.deckcol[data-deck="${d.deck}"]`);
  if (!col || !lastDecks) { render(); return; }
  const dk = lastDecks.decks.find((x) => x.deck === d.deck);
  const reccol = col.querySelector(".reccol");
  const existingSp = reccol.querySelector(".recsec.spotify");
  const html = d.connected
    ? sectionHtml(dk, "spotify", d.tracks || [], (d.tracks || []).length, "No streaming picks.")
    : `<div class="recsec spotify"><div class="rechead"><span class="sp-dot"></span> RECOMMENDATIONS FROM SPOTIFY</div><div class="connect">Connect Spotify in <b>Settings</b> (gear, top-right).</div></div>`;
  if (existingSp) existingSp.outerHTML = html;
  else reccol.insertAdjacentHTML("beforeend", html);
  wireDecks();
}

// ---- interactions ----------------------------------------------------------
function wireDecks() {
  const wrap = el("decksWrap");
  // drag library rows to Serato
  for (const row of wrap.querySelectorAll('.drow[draggable="true"]')) {
    row.addEventListener("dragstart", async (e) => {
      row.classList.add("dragging");
      const path = row.dataset.path;
      if (IS_TAURI) {
        try {
          e.preventDefault();
          const drag = window.__TAURI__?.drag;
          if (drag?.startDrag) await drag.startDrag({ item: [path] });
          else await window.__TAURI__.core.invoke("start_file_drag", { path });
        } catch (err) { console.warn("native drag failed", err); }
      } else {
        e.dataTransfer.setData("text/uri-list", "file://" + path);
        e.dataTransfer.setData("text/plain", path);
      }
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
  }
  // checkbox select (crate)
  for (const chk of wrap.querySelectorAll(".rcheck")) {
    chk.addEventListener("mousedown", (e) => e.stopPropagation());
    chk.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = chk.dataset.check;
      const row = chk.closest(".drow");
      if (selected.has(id)) { selected.delete(id); row.classList.remove("sel"); }
      else { selected.set(id, true); row.classList.add("sel"); }
      refreshSelbar();
    });
  }
  // owned spotify rows → prep
  for (const row of wrap.querySelectorAll(".drow[data-prep]")) {
    row.addEventListener("click", () => post("/seed", { id: row.dataset.prep }));
  }
  // filter button + popover
  for (const btn of wrap.querySelectorAll(".filterbtn")) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const deck = Number(btn.dataset.filter);
      openFilterDeck = openFilterDeck === deck ? null : deck;
      render();
    });
  }
  for (const btn of wrap.querySelectorAll("[data-live]")) {
    btn.addEventListener("click", () => post("/live", {}));
  }
  wireFilterPop();
}

function wireFilterPop() {
  const pop = el("decksWrap").querySelector(".filterpop");
  if (!pop) return;
  const deck = Number(pop.dataset.pop);
  pop.addEventListener("click", (e) => e.stopPropagation());
  pop.querySelectorAll("[data-bpm]").forEach((b) => b.addEventListener("click", () => {
    const cur = lastDecks.decks.find((x) => x.deck === deck)?.filter?.bpm;
    post("/deckfilter", { deck, bpm: cur === b.dataset.bpm ? "any" : b.dataset.bpm });
  }));
  pop.querySelectorAll("[data-clean]").forEach((b) => b.addEventListener("click", () => {
    post("/deckfilter", { deck, clean: b.dataset.clean });
  }));
  pop.querySelectorAll(".kchip").forEach((c) => c.addEventListener("click", () => {
    const dk = lastDecks.decks.find((x) => x.deck === deck);
    const keys = new Set(dk?.filter?.keys || []);
    const k = c.dataset.key;
    if (keys.has(k)) keys.delete(k); else keys.add(k);
    post("/deckfilter", { deck, keys: [...keys] });
  }));
  const applyRange = () => post("/deckfilter", { deck, bpm: "range", bpmMin: pop.querySelector(".fmin").value, bpmMax: pop.querySelector(".fmax").value });
  pop.querySelector(".fmin").addEventListener("change", applyRange);
  pop.querySelector(".fmax").addEventListener("change", applyRange);
}

// close popover when clicking elsewhere
document.addEventListener("click", () => { if (openFilterDeck != null) { openFilterDeck = null; render(); } });

function post(path, body) {
  return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
}

// ---- crate export ----------------------------------------------------------
el("selClear").addEventListener("click", () => {
  selected.clear();
  for (const row of el("decksWrap").querySelectorAll(".drow.sel")) row.classList.remove("sel");
  refreshSelbar();
});
el("selExport").addEventListener("click", async () => {
  const ids = [...selected.keys()];
  if (!ids.length) return;
  const btn = el("selExport");
  btn.textContent = "Exporting…"; btn.disabled = true;
  try {
    const r = await fetch("/crate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids, name: "Banger Picks" }) });
    const j = await r.json();
    btn.textContent = j.ok ? `✓ ${j.count} → crate` : "Failed";
    if (j.ok) { selected.clear(); for (const row of el("decksWrap").querySelectorAll(".drow.sel")) row.classList.remove("sel"); }
  } catch { btn.textContent = "Failed"; }
  setTimeout(() => { btn.textContent = "Export crate"; btn.disabled = false; refreshSelbar(); }, 1400);
});

// ---- energy trajectory -----------------------------------------------------
el("energySeg").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  for (const b of el("energySeg").children) b.classList.toggle("on", b === btn);
  post("/config", { energyDirection: btn.dataset.dir });
});

// ---- settings modal --------------------------------------------------------
const modal = el("settingsModal");
el("settingsBtn").addEventListener("click", () => { modal.hidden = false; });
el("settingsClose").addEventListener("click", () => { modal.hidden = true; });
modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });
function syncSettings(s) {
  if (!s?.spotify) return;
  if (s.spotify.clientId && !el("spClientId").value) el("spClientId").value = s.spotify.clientId;
  const connected = !!(s.spotify.clientId && s.spotify.hasSecret);
  const st = el("spotifyStatus");
  st.textContent = connected ? "connected" : "not connected";
  st.classList.toggle("on", connected);
}
el("spSave").addEventListener("click", async () => {
  const btn = el("spSave");
  btn.textContent = "Saving…"; btn.disabled = true;
  try {
    const r = await fetch("/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ spotify: { clientId: el("spClientId").value, clientSecret: el("spClientSecret").value } }) });
    const j = await r.json();
    const ok = j.ok && j.streaming?.connected;
    btn.textContent = ok ? "✓ Connected" : "Saved";
    el("spotifyStatus").textContent = ok ? "connected" : "check credentials";
    el("spotifyStatus").classList.toggle("on", ok);
    el("spClientSecret").value = "";
  } catch { btn.textContent = "Failed"; }
  setTimeout(() => { btn.textContent = "Save & Connect"; btn.disabled = false; }, 1600);
});

// ---- prep search -----------------------------------------------------------
const searchInput = el("searchInput");
const dropdown = el("dropdown");
const clearBtn = el("clearSearch");
let searchTimer = null, matches = [], activeIdx = -1;
function hideDropdown() { dropdown.hidden = true; activeIdx = -1; }
function renderDropdown() {
  if (!matches.length) { dropdown.innerHTML = `<div class="none">No tracks found</div>`; dropdown.hidden = false; return; }
  dropdown.innerHTML = matches.map((m, i) => `
    <div class="opt ${i === activeIdx ? "active" : ""}" data-i="${i}">
      <div style="min-width:0"><div class="ot">${esc(m.title)}</div><div class="oa">${esc(m.artist)}</div></div>
      <div class="ok">${m.camelot ? `<span class="okey" style="${keyBadgeStyle(m.camelot)}">${esc(m.camelot)}</span>` : ""}${m.bpm ? `<span class="obpm">${m.bpm}</span>` : ""}</div>
    </div>`).join("");
  dropdown.hidden = false;
  for (const opt of dropdown.querySelectorAll(".opt")) opt.addEventListener("mousedown", (e) => { e.preventDefault(); pickMatch(Number(opt.dataset.i)); });
}
async function runSearch(q) {
  if (q.trim().length < 2) { hideDropdown(); matches = []; return; }
  try { matches = (await (await fetch("/search?q=" + encodeURIComponent(q))).json()).matches || []; activeIdx = -1; renderDropdown(); }
  catch { hideDropdown(); }
}
function pickMatch(i) {
  const m = matches[i];
  if (!m) return;
  searchInput.value = ""; clearBtn.hidden = true; hideDropdown();
  post("/seed", { id: m.id });
}
searchInput.addEventListener("input", () => { const q = searchInput.value; clearBtn.hidden = !q; clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(q), 180); });
searchInput.addEventListener("keydown", (e) => {
  if (dropdown.hidden) return;
  if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, matches.length - 1); renderDropdown(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); renderDropdown(); }
  else if (e.key === "Enter") { e.preventDefault(); pickMatch(activeIdx >= 0 ? activeIdx : 0); }
  else if (e.key === "Escape") hideDropdown();
});
searchInput.addEventListener("blur", () => setTimeout(hideDropdown, 120));
clearBtn.addEventListener("click", () => { searchInput.value = ""; clearBtn.hidden = true; hideDropdown(); matches = []; searchInput.focus(); });

// ---- connection ------------------------------------------------------------
function setConnected(on, text) { el("statusDot").classList.toggle("off", !on); el("statusText").textContent = text; }
function connect() {
  const es = new EventSource("/events");
  es.onopen = () => setConnected(true, "watching Serato");
  es.onerror = () => setConnected(false, "reconnecting…");
  es.addEventListener("state", (ev) => {
    const d = JSON.parse(ev.data);
    setConnected(true, `${d.librarySize.toLocaleString()} tracks`);
    if (d.energyDirection) for (const b of el("energySeg").children) b.classList.toggle("on", b.dataset.dir === d.energyDirection);
    if (d.streaming) streamingStatusGlobal = d.streaming;
    syncSettings(d.settings);
    if (lastDecks) render();
  });
  es.addEventListener("decks", (ev) => { lastDecks = JSON.parse(ev.data); render(); });
  es.addEventListener("streaming", (ev) => renderStreaming(JSON.parse(ev.data)));
}
connect();
