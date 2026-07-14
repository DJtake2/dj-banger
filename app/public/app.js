/* ============================================================================
   Banger frontend — two-column deck split.
   Each Serato deck gets its own column: now-playing + library recs + Spotify recs,
   with a per-deck filter (BPM range / ±3·±5·±10 + compatible keys). Fed by bridge.mjs
   over SSE. Runs the same in a browser (dev) and the Tauri webview.
   ============================================================================ */

const IS_TAURI = typeof window.__TAURI__ !== "undefined";
// In the packaged app the window is served from tauri://localhost, so API calls need the
// sidecar's absolute origin. In the browser (and `tauri dev`) same-origin relative works.
const API = IS_TAURI ? "http://localhost:4177" : "";
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
const SPOTIFY_LOGO = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.6 14.4a.62.62 0 0 1-.86.21c-2.35-1.44-5.3-1.76-8.79-.96a.62.62 0 1 1-.28-1.22c3.8-.87 7.08-.5 9.72 1.11.3.18.39.57.21.86zm1.23-2.73a.78.78 0 0 1-1.07.26c-2.69-1.65-6.79-2.13-9.97-1.17a.78.78 0 1 1-.45-1.49c3.63-1.1 8.15-.56 11.24 1.33.37.23.49.71.25 1.07zm.11-2.85C14.32 8.9 9.1 8.73 6.03 9.66a.94.94 0 1 1-.54-1.8c3.53-1.07 9.29-.86 12.95 1.31a.94.94 0 0 1-.96 1.61z"/></svg>`;
// Official brand logos (the services' own marks — used to identify the source).
const SERATO_LOGO = `<img class="logo-img" src="logos/serato.svg" alt="Serato" draggable="false" />`;
const SPOTIFY_MARK = `<img class="logo-img" src="logos/spotify.png" alt="Spotify" draggable="false" />`;
const BAN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8" stroke-linecap="round"/></svg>`;

// Left cell for a track row / now-playing: album art (local via /art?id, or Spotify image URL)
// layered over the source logo (Serato for library, Spotify for streaming), which shows through
// when there's no art.
function artCell(s, kind, big) {
  const logo = kind === "spotify" ? SPOTIFY_MARK : SERATO_LOGO;
  const src = s.id ? `${API}/art?id=${encodeURIComponent(s.id)}`
    : s.image ? esc(s.image) : "";
  const img = src ? `<img class="art-img" src="${src}" loading="lazy" onerror="this.remove()" alt="" />` : "";
  // The source logo (Serato for library, Spotify for streaming) shows when there's no art; album
  // art covers it when available. Source is also clear from the section header, so no extra badge.
  return `<span class="src-fallback ${kind === "spotify" ? "sp" : "lib"}">${logo}</span>${img}`;
}

// ---- waveform overview + structure markers ---------------------------------
const waveCache = new Map();   // id -> wave data (client-side, avoids re-fetching on re-render)
function fmtTime(s) { if (s == null) return ""; const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`; }
function waveSvg(w, h) {
  const peaks = w.peaks || [], N = peaks.length || 1, W = 600, bw = W / N;
  const drop = (w.markers || []).find((m) => m.label === "DROP");
  const dropX = drop ? drop.pos : -1;
  let bars = "";
  for (let i = 0; i < N; i++) {
    const bh = Math.max(1.5, peaks[i] * h), x = i * bw, t = i / N;
    const hot = dropX >= 0 && Math.abs(t - dropX) < 0.14;   // tint the drop region orange
    bars += `<rect x="${x.toFixed(2)}" y="${((h - bh) / 2).toFixed(2)}" width="${(bw * 0.72).toFixed(2)}" height="${bh.toFixed(2)}" rx="0.5" fill="${hot ? "var(--accent)" : "#7c7c7c"}"/>`;
  }
  let marks = "";
  for (const m of (w.markers || [])) {
    const x = m.pos * W, lw = m.label.length * 4.6 + 7;
    marks += `<line x1="${x.toFixed(1)}" y1="1" x2="${x.toFixed(1)}" y2="${h - 1}" stroke="${m.color}" stroke-width="1.4"/>`
      + `<rect x="${x.toFixed(1)}" y="0" width="${lw.toFixed(1)}" height="10" rx="2" fill="${m.color}"/>`
      + `<text x="${(x + lw / 2).toFixed(1)}" y="7.6" font-size="7" font-weight="700" fill="#0b0b0b" text-anchor="middle">${m.label}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${h}" width="100%" height="${h}" preserveAspectRatio="none" style="display:block">${bars}${marks}</svg>`;
}
function structureCaption(w) {
  if (w.cueSource === "serato") {
    const n = (w.markers || []).length;
    return `<span style="color:var(--accent)">●</span> ${n} Serato hot cue${n === 1 ? "" : "s"} · ${fmtTime(w.duration)}`;
  }
  const parts = (w.markers || []).map((m) => `<span style="color:${m.color}">●</span> ${m.label === "IN" ? "intro" : m.label === "DROP" ? "drop" : "outro"} ${fmtTime(m.pos * w.duration)}`);
  return parts.join(" &nbsp; ") || `${fmtTime(w.duration)} track`;
}
async function renderWave(container, id, h, withCaption) {
  if (!id) { container.innerHTML = ""; return; }
  let w = waveCache.get(id);
  if (!w) {
    try { const r = await fetch(API + "/wave?id=" + encodeURIComponent(id)); w = r.ok ? await r.json() : null; }
    catch { w = null; }
    if (w) waveCache.set(id, w);
  }
  if (!w) { container.innerHTML = `<div class="wave-empty">Waveform unavailable</div>`; return; }
  container.innerHTML = (withCaption ? `<div class="wave-cap">${structureCaption(w)}</div>` : "") + waveSvg(w, h);
}
// Tap a suggestion to expand its waveform inline; tap again (or another row) to collapse.
function toggleRowWave(row) {
  const next = row.nextElementSibling;
  if (next && next.classList.contains("wave-row")) { next.remove(); row.classList.remove("wave-open"); return; }
  const list = row.closest(".reclist") || row.parentElement;
  list.querySelectorAll(".wave-row").forEach((p) => { p.previousElementSibling?.classList.remove("wave-open"); p.remove(); });
  row.classList.add("wave-open");
  const panel = document.createElement("div");
  panel.className = "wave-row";
  panel.innerHTML = `<div class="wave-strip"></div>`;
  row.after(panel);
  renderWave(panel.querySelector(".wave-strip"), row.dataset.id, 38, true);
}

// ---- state -----------------------------------------------------------------
let lastDecks = null;             // last "decks" payload
const streamingByDeck = {};       // deck -> { connected, tracks }
let streamingStatusGlobal = { connected: false };
let openFilterDeck = null;        // which deck's filter popover is open
let activeTabDeck = null;         // in narrow mode, which deck is shown
let currentView = "home";
const mql = window.matchMedia("(max-width: 700px)");
let narrow = mql.matches;
mql.addEventListener("change", (e) => { narrow = e.matches; render(); });

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
      ? `<span class="shift">${s.owned ? "OWN" : ({ apple: "AM", tidal: "TIDAL", spotify: "SP" }[activeStreaming] || "SP")}</span>`
      : `<span class="shift"></span>`;
  // left cell: album art (with the source logo — Serato / Spotify — showing through when there's
  // no art). Library rows are click-to-select for crate export (a check overlays on select).
  const check = kind !== "spotify"
    ? `<svg class="chk" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l5 5 9-10" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : "";
  const left = `<span class="rsrc ${kind === "spotify" ? "sp" : "lib"}" ${kind !== "spotify" ? `data-check="${esc(id)}"` : ""}>${artCell(s, kind)}${check}</span>`;
  const cls = kind !== "spotify" && selected.has(id) ? "drow sel" : "drow";
  return `<div class="${cls}" ${draggable} data-id="${esc(id)}">
    ${left}
    <div class="rmain"><div class="rt">${esc(s.title)}</div><div class="ra">${esc(s.artist || "")}</div></div>
    <button class="banbtn" data-ban-artist="${esc(s.artist || "")}" data-ban-title="${esc(s.title || "")}" title="Add to Do Not Play" aria-label="Do Not Play">${BAN_ICON}</button>
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
  const label = kind === "library" ? "RECOMMENDATIONS FROM YOUR LIBRARY" : `RECOMMENDATIONS FROM ${STREAM_LABEL[activeStreaming] || "STREAMING"}`;
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
  if (activeStreaming === "local") {
    spSection = ""; // local library only — no streaming section
  } else if (stream && stream.connected) {
    spSection = sectionHtml(dk, "spotify", stream.tracks || [], (stream.tracks || []).length, "No streaming picks.");
  } else if (streamingStatusGlobal.connected) {
    spSection = `<div class="recsec spotify"><div class="rechead"><span class="sp-dot"></span> ${streamSectionLabel()}</div><div class="connect">Loading…</div></div>`;
  } else {
    spSection = `<div class="recsec spotify"><div class="rechead"><span class="sp-dot"></span> ${streamSectionLabel()}</div><div class="connect">${streamConnectPrompt()}</div></div>`;
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
    <div class="npcard${np.dnp ? " dnp" : ""}">
      <div class="art">${artCell(np, "library", true)}</div>
      <div class="npmain"><div class="npt">${esc(np.title)}</div><div class="npa">${esc(np.artist || "")}</div></div>
      ${np.dnp
        ? `<span class="dnp-badge" title="On your Do-Not-Play list: ${esc(np.dnp)}">DO NOT PLAY</span>`
        : `<button class="banbtn np" data-ban-artist="${esc(np.artist || "")}" data-ban-title="${esc(np.title || "")}" title="Add to Do Not Play" aria-label="Do Not Play">${BAN_ICON}</button>`}
    </div>
    ${np.id ? `<div class="wave-np" data-wave-id="${esc(np.id)}"></div>` : ""}
    <div class="reccol">
      ${sectionHtml(dk, "library", dk.library || [], (dk.library || []).length)}
      ${spSection}
    </div>
  </div>`;
}

function render() {
  if (!lastDecks || !lastDecks.decks?.length) return;
  const wrap = el("decksWrap");
  const tabs = el("deckTabs");
  const prep = lastDecks.source === "prep";
  const decks = prep ? lastDecks.decks.filter((d) => d.deck === 0) : lastDecks.decks.filter((d) => d.deck !== 0);
  const all = decks.length ? decks : lastDecks.decks;

  // Narrow window → deck tabs + a single active column; wide → both columns side by side.
  let shown = all;
  if (narrow && all.length > 1 && !prep) {
    if (activeTabDeck == null || !all.some((d) => d.deck === activeTabDeck)) activeTabDeck = all[0].deck;
    shown = all.filter((d) => d.deck === activeTabDeck);
    tabs.hidden = false;
    tabs.innerHTML = all.map((d) => `<button class="${d.deck === activeTabDeck ? "on" : ""}" data-tab="${d.deck}">Deck ${d.deck}</button>`).join("");
    for (const b of tabs.querySelectorAll("button")) b.addEventListener("click", () => { activeTabDeck = Number(b.dataset.tab); render(); });
  } else {
    tabs.hidden = true;
  }

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
  // now-playing waveforms (overview + structure), fetched once per track and client-cached
  for (const c of wrap.querySelectorAll(".wave-np[data-wave-id]")) renderWave(c, c.dataset.waveId, 44, true);
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
  const html = activeStreaming === "local" ? ""
    : d.connected
      ? sectionHtml(dk, "spotify", d.tracks || [], (d.tracks || []).length, "No streaming picks.")
      : `<div class="recsec spotify"><div class="rechead"><span class="sp-dot"></span> ${streamSectionLabel()}</div><div class="connect">${streamConnectPrompt()}</div></div>`;
  if (existingSp) existingSp.outerHTML = html;
  else if (html) reccol.insertAdjacentHTML("beforeend", html);
  wireDecks();
}

// ---- interactions ----------------------------------------------------------
// Drag-to-Serato + crate-select wiring, reusable for the deck columns AND the charts view.
function wireRows(root) {
  for (const row of root.querySelectorAll('.drow[draggable="true"]')) {
    row.addEventListener("dragstart", async (e) => {
      row.classList.add("dragging");
      const path = row.dataset.path;
      if (IS_TAURI) {
        // In the packaged app, hand off to a native OS file-drag (drop target = Serato).
        // The HTML5 drag can't carry a real file out of the webview, so cancel it and
        // start the native drag via our Rust command.
        try {
          e.preventDefault();
          await window.__TAURI__.core.invoke("start_file_drag", { path });
        } catch (err) { console.warn("native drag failed", err); }
      } else {
        e.dataTransfer.setData("text/uri-list", "file://" + path);
        e.dataTransfer.setData("text/plain", path);
      }
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
  }
  for (const chk of root.querySelectorAll(".rsrc.lib[data-check]")) {
    chk.addEventListener("mousedown", (e) => e.stopPropagation());
    chk.addEventListener("click", (e) => {
      e.stopPropagation(); e.preventDefault();
      const id = chk.dataset.check;
      const row = chk.closest(".drow");
      if (selected.has(id)) { selected.delete(id); row.classList.remove("sel"); }
      else { selected.set(id, true); row.classList.add("sel"); }
      refreshSelbar();
    });
  }
  // Tap a row's title area to expand its waveform preview (structure at a glance).
  for (const main of root.querySelectorAll(".drow .rmain")) {
    main.style.cursor = "pointer";
    main.addEventListener("click", (e) => { e.stopPropagation(); toggleRowWave(main.closest(".drow")); });
  }
  // Quick "Do Not Play" — the ban button on rows / now-playing cards (front-facing).
  for (const b of root.querySelectorAll(".banbtn")) {
    b.setAttribute("draggable", "false");
    b.addEventListener("mousedown", (e) => e.stopPropagation());
    b.addEventListener("dragstart", (e) => { e.preventDefault(); e.stopPropagation(); });
    b.addEventListener("click", (e) => {
      e.stopPropagation(); e.preventDefault();
      banTrack(b.dataset.banArtist || "", b.dataset.banTitle || "");
    });
  }
}

function wireDecks() {
  const wrap = el("decksWrap");
  wireRows(wrap);
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
  return fetch(API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
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
    const r = await fetch(API + "/crate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids, name: "Banger Picks" }) });
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

// ---- nav (Home / Charts) ---------------------------------------------------
el("nav").addEventListener("click", (e) => {
  const btn = e.target.closest(".navtab");
  if (!btn) return;
  for (const b of el("nav").children) b.classList.toggle("on", b === btn);
  currentView = btn.dataset.view;
  el("homeView").hidden = currentView !== "home";
  el("chartsView").hidden = currentView !== "charts";
  if (currentView === "charts") { el("deckTabs").hidden = true; loadCharts(); }
  else render(); // home → render() re-establishes deck tabs if narrow
});

async function loadCharts() {
  const scroll = el("chartsScroll");
  scroll.innerHTML = `<div class="empty"><div class="big">Loading charts…</div></div>`;
  try {
    const d = await (await fetch(API + "/charts")).json();
    if (!d.connected) {
      scroll.innerHTML = `<div class="empty"><div class="big">Connect Spotify to see charts</div>
        <div>Open Settings (gear, top-right) and add your Spotify credentials.<br>Charts pull Spotify's Top 50 &amp; Viral playlists — owned tracks are draggable to a deck.</div></div>`;
      return;
    }
    if (!d.charts?.length) { scroll.innerHTML = `<div class="empty"><div class="big">No charts available right now</div></div>`; return; }
    scroll.innerHTML = `<div class="charts-cols">` + d.charts.map((c) => `
      <div class="chart">
        <h3>${SPOTIFY_LOGO} ${esc(c.name)} <span style="color:var(--text-faint);font-weight:600;margin-left:auto">${c.tracks.length}</span></h3>
        <div class="reclist">${c.tracks.map((t) => rowHtml(t, t.owned ? "library" : "spotify")).join("")}</div>
      </div>`).join("") + `</div>`;
    wireRows(scroll);
  } catch { scroll.innerHTML = `<div class="empty"><div class="big">Charts unavailable</div></div>`; }
}

// ---- settings modal --------------------------------------------------------
const modal = el("settingsModal");
el("settingsClose").addEventListener("click", () => { modal.hidden = true; });

// ---- settings menu + display modes (matches the reference app's gear menu) --
const menu = el("settingsMenu");
function tauriWin() { return IS_TAURI ? window.__TAURI__?.window?.getCurrentWindow?.() : null; }
async function monitorLogical() {
  const T = window.__TAURI__?.window, win = tauriWin();
  if (!T || !win) return null;
  let mon = null;
  try { mon = await win.currentMonitor(); } catch {}
  if (!mon) { try { mon = await T.primaryMonitor(); } catch {} }
  if (!mon) { try { mon = (await T.availableMonitors())?.[0]; } catch {} }
  if (!mon) return null;
  const sf = mon.scaleFactor || 1;
  return { w: mon.size.width / sf, h: mon.size.height / sf, x: mon.position.x / sf, y: mon.position.y / sf };
}
// Expanded window geometry per display mode (from the reference app).
const DISPLAY_MODES = {
  "bottom-bar":   (s) => { const w = Math.min(1380, s.w);            return { w, h: 280, x: s.x + (s.w - w) / 2, y: s.y + s.h - 280 }; },
  "bottom-right": (s) => { const h = Math.min(600, s.h);            return { w: 400, h, x: s.x + s.w - 400, y: s.y + s.h - h }; },
  "side-panel":   (s) => { const h = Math.min(600, s.h);            return { w: 400, h, x: s.x + s.w - 400, y: s.y + (s.h - h) / 2 }; },
  "side-wide":    (s) => { const h = Math.min(800, s.h);            return { w: 450, h, x: s.x + s.w - 450, y: s.y + (s.h - h) / 2 }; },
};
let currentMode = localStorage.getItem("display-mode") || "side-wide";
function updateModeChecks() { for (const b of menu.querySelectorAll("[data-mode]")) b.classList.toggle("on", b.dataset.mode === currentMode); }
async function applyDisplayMode() {
  if (!IS_TAURI || !DISPLAY_MODES[currentMode]) return;
  const s = await monitorLogical(); if (!s) return;
  const g = DISPLAY_MODES[currentMode](s);
  const { LogicalSize, LogicalPosition } = window.__TAURI__.window, win = tauriWin();
  try {
    await win.setResizable(true);
    await win.setSize(new LogicalSize(Math.round(g.w), Math.round(g.h)));
    await win.setPosition(new LogicalPosition(Math.round(g.x), Math.round(g.y)));
  } catch (e) { console.warn("applyDisplayMode", e); }
}
function setDisplayMode(mode) { if (!DISPLAY_MODES[mode]) return; currentMode = mode; localStorage.setItem("display-mode", mode); updateModeChecks(); applyDisplayMode(); }

// Always-on-top, shared between the pin button and the menu toggle.
let pinned = false;
async function applyPinned(v) {
  pinned = v;
  const win = tauriWin();
  if (win) { try { await win.setAlwaysOnTop(v); } catch {} }
  el("pinBtn")?.classList.toggle("on", pinned);
  el("aotSwitch")?.classList.toggle("on", pinned);
  const pb = el("pinBtn"); if (pb) pb.title = pinned ? "Keep on top" : "Not on top";
}

// gear → toggle menu; click-away closes it
el("settingsBtn").addEventListener("click", (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
document.addEventListener("click", (e) => {
  if (!menu.hidden && !menu.contains(e.target) && !el("settingsBtn").contains(e.target)) menu.hidden = true;
});
menu.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => { setDisplayMode(b.dataset.mode); menu.hidden = true; }));
el("aotToggle")?.addEventListener("click", () => applyPinned(!pinned));
// streaming source selector (Local / Spotify / Apple Music / TIDAL)
let activeStreaming = "spotify";
const streamConnected = { spotify: false, tidal: false };
const STREAM_LABEL = { local: "LOCAL LIBRARY", spotify: "SPOTIFY", apple: "APPLE MUSIC", tidal: "TIDAL" };
function streamSectionLabel() { return `RECOMMENDATIONS FROM ${STREAM_LABEL[activeStreaming] || "STREAMING"}`; }
function streamConnectPrompt() {
  if (activeStreaming === "apple") return "Loading Apple Music picks…";
  if (activeStreaming === "tidal") return "Add your <b>TIDAL</b> developer app credentials in Settings to enable.";
  return "Connect Spotify in <b>Settings</b> (gear, top-right) to surface tracks beyond your library.";
}
function updateStreamChecks() { for (const b of menu.querySelectorAll("[data-stream]")) b.classList.toggle("on", b.dataset.stream === activeStreaming); }
async function setStreamingService(svc) {
  activeStreaming = svc; updateStreamChecks(); menu.hidden = true;
  await post("/settings", { streamingService: svc });
  if (lastDecks) render();
  // Spotify / Tidal need credentials — open Settings if not connected yet.
  if ((svc === "spotify" || svc === "tidal") && !streamConnected[svc]) modal.hidden = false;
}
menu.querySelectorAll("[data-stream]").forEach((b) => b.addEventListener("click", () => setStreamingService(b.dataset.stream)));
el("menuUpdate")?.addEventListener("click", () => { menu.hidden = true; modal.hidden = false; checkForUpdate(true); });
el("menuExit")?.addEventListener("click", () => tauriWin()?.close().catch(() => {}));
updateModeChecks();
if (!IS_TAURI) for (const b of menu.querySelectorAll("[data-tauri-only]")) b.style.display = "none";
modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });
let dnpDirty = false; // don't clobber an in-progress edit when a state event arrives
function syncSettings(s) {
  if (!s) return;
  if (s.spotify) {
    if (s.spotify.clientId && !el("spClientId").value) el("spClientId").value = s.spotify.clientId;
    streamConnected.spotify = !!(s.spotify.clientId && s.spotify.hasSecret);
    const st = el("spotifyStatus");
    st.textContent = streamConnected.spotify ? "connected" : "not connected";
    st.classList.toggle("on", streamConnected.spotify);
  }
  if (s.tidal) {
    if (s.tidal.clientId && el("tdClientId") && !el("tdClientId").value) el("tdClientId").value = s.tidal.clientId;
    streamConnected.tidal = !!(s.tidal.clientId && s.tidal.hasSecret);
    const st = el("tidalStatus");
    if (st) { st.textContent = streamConnected.tidal ? "connected" : "not connected"; st.classList.toggle("on", streamConnected.tidal); }
  }
  if (typeof s.streamingService === "string") { activeStreaming = s.streamingService; updateStreamChecks(); }
  if (typeof s.doNotPlay === "string") {
    currentDnp = s.doNotPlay;
    if (!dnpDirty) { el("dnpText").value = s.doNotPlay; updateDnpCount(); }
  }
}

// ---- quick "Do Not Play" (front-facing) ------------------------------------
let currentDnp = "";
function toast(msg) {
  let t = el("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2200);
}
async function banTrack(artist, title) {
  const entry = (artist && title) ? `${artist} - ${title}` : (artist || title);
  if (!entry) return;
  const lines = currentDnp.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.some((l) => l.toLowerCase() === entry.toLowerCase())) { toast(`Already on Do Not Play`); return; }
  lines.push(entry);
  currentDnp = lines.join("\n");
  el("dnpText").value = currentDnp; updateDnpCount();
  await post("/settings", { doNotPlay: currentDnp });
  toast(`🚫 Do Not Play: ${entry}`);
}
function updateDnpCount() {
  const n = el("dnpText").value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length;
  el("dnpCount").textContent = n ? `${n} entr${n === 1 ? "y" : "ies"}` : "";
}
el("dnpText").addEventListener("input", () => { dnpDirty = true; updateDnpCount(); });
// ---- waveform pre-warm (optional full-library) -----------------------------
let prewarmPoll = null;
function showPrewarm(s) {
  const st = el("prewarmStatus"), btn = el("prewarmBtn");
  if (s.running) {
    const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
    st.textContent = `${s.done.toLocaleString()} / ${s.total.toLocaleString()} (${pct}%)`;
    btn.textContent = "Building…"; btn.disabled = true;
    if (!prewarmPoll) prewarmPoll = setInterval(pollPrewarm, 1500);
  } else {
    btn.textContent = "Pre-load all waveforms"; btn.disabled = false;
    if (s.total && s.done >= s.total) st.textContent = "✓ all cached";
    if (prewarmPoll) { clearInterval(prewarmPoll); prewarmPoll = null; }
  }
}
async function pollPrewarm() { try { showPrewarm(await (await fetch(API + "/wave/prewarm")).json()); } catch {} }
el("prewarmBtn").addEventListener("click", async () => {
  try { showPrewarm(await (await fetch(API + "/wave/prewarm", { method: "POST" })).json()); } catch {}
});
// world-popularity pre-load (Deezer)
let popPoll = null;
function showPop(s) {
  const st = el("popStatus"), btn = el("popBtn");
  if (s.running) {
    const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
    st.textContent = `${s.done.toLocaleString()} / ${s.total.toLocaleString()} (${pct}%)`;
    btn.textContent = "Building…"; btn.disabled = true;
    if (!popPoll) popPoll = setInterval(async () => { try { showPop(await (await fetch(API + "/pop/prewarm")).json()); } catch {} }, 2000);
  } else {
    btn.textContent = "Pre-load all popularity"; btn.disabled = false;
    if (s.total && s.done >= s.total) st.textContent = "✓ done";
    if (popPoll) { clearInterval(popPoll); popPoll = null; }
  }
}
el("popBtn").addEventListener("click", async () => {
  try { showPop(await (await fetch(API + "/pop/prewarm", { method: "POST" })).json()); } catch {}
});
el("dnpSave").addEventListener("click", async () => {
  const btn = el("dnpSave");
  btn.textContent = "Saving…"; btn.disabled = true;
  try {
    await fetch(API + "/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ doNotPlay: el("dnpText").value }) });
    btn.textContent = "✓ Saved"; dnpDirty = false;
  } catch { btn.textContent = "Failed"; }
  setTimeout(() => { btn.textContent = "Save list"; btn.disabled = false; }, 1400);
});
el("spTest").addEventListener("click", async () => {
  const btn = el("spTest"), out = el("spResult");
  btn.textContent = "Testing…"; btn.disabled = true;
  out.hidden = true; out.className = "sp-result";
  try {
    const r = await fetch(API + "/spotify/test", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: el("spClientId").value, clientSecret: el("spClientSecret").value }),
    });
    const j = await r.json();
    out.hidden = false;
    out.classList.add(j.ok ? "ok" : "bad");
    out.textContent = j.ok ? "✓ Credentials valid — Spotify reachable." : `✗ ${j.error || "connection failed"}`;
  } catch {
    out.hidden = false; out.classList.add("bad"); out.textContent = "✗ Could not reach the server.";
  }
  btn.textContent = "Test connection"; btn.disabled = false;
});
el("spSave").addEventListener("click", async () => {
  const btn = el("spSave");
  btn.textContent = "Saving…"; btn.disabled = true;
  try {
    const r = await fetch(API + "/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ spotify: { clientId: el("spClientId").value, clientSecret: el("spClientSecret").value } }) });
    const j = await r.json();
    const ok = j.ok && j.streaming?.connected;
    btn.textContent = ok ? "✓ Connected" : "Saved";
    el("spotifyStatus").textContent = ok ? "connected" : "check credentials";
    el("spotifyStatus").classList.toggle("on", ok);
    el("spClientSecret").value = "";
  } catch { btn.textContent = "Failed"; }
  setTimeout(() => { btn.textContent = "Save & Connect"; btn.disabled = false; }, 1600);
});
el("tdTest")?.addEventListener("click", async () => {
  const btn = el("tdTest"), out = el("tdResult");
  btn.textContent = "Testing…"; btn.disabled = true; out.hidden = true; out.className = "sp-result";
  try {
    const r = await fetch(API + "/tidal/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: el("tdClientId").value, clientSecret: el("tdClientSecret").value }) });
    const j = await r.json();
    out.hidden = false; out.classList.add(j.ok ? "ok" : "bad");
    out.textContent = j.ok ? "✓ Credentials valid — TIDAL reachable." : `✗ ${j.error || "connection failed"}`;
  } catch { out.hidden = false; out.classList.add("bad"); out.textContent = "✗ Could not reach the server."; }
  btn.textContent = "Test connection"; btn.disabled = false;
});
el("tdSave")?.addEventListener("click", async () => {
  const btn = el("tdSave");
  btn.textContent = "Saving…"; btn.disabled = true;
  try {
    await fetch(API + "/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tidal: { clientId: el("tdClientId").value, clientSecret: el("tdClientSecret").value }, streamingService: "tidal" }) });
    btn.textContent = "✓ Saved"; el("tdClientSecret").value = "";
  } catch { btn.textContent = "Failed"; }
  setTimeout(() => { btn.textContent = "Save & Connect"; btn.disabled = false; }, 1600);
});

// ---- self-update (installed app only) --------------------------------------
async function checkForUpdate(manual) {
  const out = el("updateResult");
  const show = (msg, cls) => { out.hidden = false; out.className = "sp-result" + (cls ? " " + cls : ""); out.textContent = msg; };
  if (!IS_TAURI) { if (manual) show("Updates apply to the installed app.", ""); return; }
  const updater = window.__TAURI__?.updater;
  if (!updater?.check) { if (manual) show("Updater unavailable in this build.", "bad"); return; }
  try {
    if (manual) show("Checking…", "");
    const update = await updater.check();
    if (!update || update.available === false) { if (manual) show("✓ You're on the latest version.", "ok"); return; }
    el("settingsBtn").classList.add("has-update");
    show(`Downloading v${update.version}…`, "");
    await update.downloadAndInstall();
    show("✓ Updated — quit & reopen Banger to apply.", "ok");
  } catch (e) { if (manual) show("Update check failed: " + (e?.message || e), "bad"); }
}
el("updateBtn").addEventListener("click", () => checkForUpdate(true));
(async () => {
  try { const v = await window.__TAURI__?.app?.getVersion?.(); if (v) el("appVersion").textContent = "v" + v; } catch {}
  if (IS_TAURI) checkForUpdate(false); // silent auto-check on launch
})();

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
  try { matches = (await (await fetch(API + "/search?q=" + encodeURIComponent(q))).json()).matches || []; activeIdx = -1; renderDropdown(); }
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

// ---- window controls (frameless Tauri window) ------------------------------
// The window has no native title bar (decorations:false), so we provide our own
// move / minimize / close / pin controls. In a plain browser these do nothing, so
// the control cluster stays hidden there.
(function setupWindowControls() {
  if (!IS_TAURI) return;
  const win = window.__TAURI__?.window?.getCurrentWindow?.();
  if (!win) return;

  el("winctl").hidden = false;

  const TAURI = window.__TAURI__;
  const PILL_W = 34, PILL_H = 140;      // matches Banger Button's 32×140 'closed' pill

  // Collapse the window to a thin pill docked to the right screen edge (like the reference
  // app's minimize-to-side-button), or expand back to the chosen display-mode layout.
  async function setCollapsed(on) {
    const { LogicalSize, LogicalPosition } = TAURI.window;
    try {
      if (on) {
        el("collapsedPill").hidden = false;
        document.querySelector(".app").style.display = "none";
        await win.setResizable(false);
        await win.setSize(new LogicalSize(PILL_W, PILL_H));
        await dockRight(PILL_W, PILL_H);
      } else {
        el("collapsedPill").hidden = true;
        document.querySelector(".app").style.display = "";
        await win.setResizable(true);
        await applyDisplayMode();   // restore to the selected display mode's size + position
        await win.setFocus().catch(() => {});
      }
    } catch (err) { console.warn("collapse toggle failed", err); }

    async function dockRight(w, h) {
      try {
        // currentMonitor() can be null for a frameless/transparent window; fall back to the
        // primary monitor, then the first available one, so the pill always finds the edge.
        let mon = null;
        try { mon = await win.currentMonitor(); } catch {}
        if (!mon) { try { mon = await TAURI.window.primaryMonitor(); } catch {} }
        if (!mon) { try { mon = (await TAURI.window.availableMonitors())?.[0]; } catch {} }
        if (!mon) return;
        const sf = mon.scaleFactor || 1;
        const screenW = mon.size.width / sf, screenH = mon.size.height / sf;
        const originX = mon.position.x / sf, originY = mon.position.y / sf;
        const x = Math.round(originX + screenW - w);
        const y = Math.round(originY + (screenH - h) / 2);
        await win.setPosition(new LogicalPosition(x, y));
      } catch (err) { console.warn("dockRight failed", err); }
    }
  }

  // Standard window functions (behave like any other app) + the extra edge-pill collapse.
  el("minBtn")?.addEventListener("click", () => win.minimize().catch(() => {}));      // → Dock
  el("maxBtn")?.addEventListener("click", async () => {                                // expand / restore
    try { await win.toggleMaximize(); }
    catch { try { (await win.isMaximized()) ? await win.unmaximize() : await win.maximize(); } catch {} }
  });
  el("closeBtn")?.addEventListener("click", () => win.close().catch(() => {}));        // quit
  el("pillBtn")?.addEventListener("click", () => setCollapsed(true));                   // collapse to edge
  el("collapsedPill")?.addEventListener("click", () => setCollapsed(false));

  // Pin toggle — NOT always-on-top by default (so Serato/other apps can cover it); the pin
  // button and the menu's "Always on Top" toggle share state via applyPinned().
  win.isAlwaysOnTop?.().then((v) => applyPinned(!!v)).catch(() => {});
  el("pinBtn")?.addEventListener("click", () => applyPinned(!pinned));

  // Drag the whole title bar (except interactive controls). This is more reliable than
  // -webkit-app-region alone for a frameless window.
  const titlebar = document.querySelector(".titlebar");
  titlebar?.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("button, input, a, .nav, .winctl, .status, .menu")) return;
    win.startDragging().catch(() => {});
  });

  // Open in the last-used display mode.
  applyDisplayMode();
})();

// ---- connection ------------------------------------------------------------
function setConnected(on, text) { el("statusDot").classList.toggle("off", !on); el("statusText").textContent = text; }
function connect() {
  const es = new EventSource(API + "/events");
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
