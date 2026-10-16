/* ============================================================================
   On Cue — tonight's plan from the CRM, beside the decks.
   Fed by the bridge's "oncue" SSE event (src/oncue/onCue.ts). Renders:
     • the panel: event picker, must-play progress, what's on each deck, the night's
       sections in order (expand for songs, notes and answers), the do-not-play list;
     • the red banner over every view when a do-not-play is loaded;
     • the collapsed edge pill flashing red for the same reason.
   The panel lives in the On Cue tab, or docks beside the decks on Home when the
   window is wide enough.
   ============================================================================ */
(() => {
  const DOCK_MIN_W = 1000;
  let snap = null;
  let crate = null; // "Send to Serato" status from the bridge
  const open = new Set(JSON.parse(localStorage.getItem("oncue-open") || "[]"));
  let docked = localStorage.getItem("oncue-docked") !== "0";
  let userTouchedOpen = open.size > 0;
  let scrolledFor = null;
  const saveOpen = () => localStorage.setItem("oncue-open", JSON.stringify([...open]));

  const panel = () => el("oncuePanel");
  const fmtDay = (d) => {
    if (!d) return "";
    const dt = new Date(`${d}T12:00:00`);
    return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  };
  const songLine = (g) => `${esc(g.title)}${g.artist ? ` <span class="oc-artist">— ${esc(g.artist)}</span>` : ""}`;

  /** The section happening now: the last timed one that has started (untimed ones ride along). */
  function nowSectionId(plan) {
    const t = Date.now();
    let cur = null;
    for (const s of plan.sections) if (s.at && new Date(s.at).getTime() <= t) cur = s.id;
    return cur;
  }

  function deckRow(d) {
    const state = d.dnp ? "dnp" : d.played ? "playing" : "loaded";
    const sec = d.sectionId && snap.plan ? snap.plan.sections.find((s) => s.id === d.sectionId) : null;
    const tag = d.dnp
      ? `<span class="oc-tag dnp">DO NOT PLAY</span>`
      : d.songId
        ? `<span class="oc-tag ${d.mustPlay ? "must" : "plan"}">${d.mustPlay ? "★ must-play" : "in plan"}${sec ? ` · ${esc(sec.name)}` : ""}</span>`
        : "";
    return `<div class="oc-deck ${state}">
      <span class="oc-decknum">${d.deck}</span>
      <div class="oc-deckmain"><div class="oc-decktitle">${songLine(d)}</div>${tag}</div>
      <span class="oc-state">${d.played ? "PLAYING" : "LOADED"}</span>
    </div>`;
  }

  function songRow(g, dnp) {
    const played = !!snap.played[g.id];
    const onDeck = snap.decks.find((d) => d.songId === g.id);
    return `<li class="oc-song${played ? " played" : ""}${g.mustPlay ? " must" : ""}${onDeck ? " ondeck" : ""}">
      ${dnp ? `<span class="oc-x" aria-hidden="true">⛔</span>` : `<button class="oc-tick" data-tick="${g.id}" data-on="${played ? 0 : 1}" title="${played ? "Played — tap to un-tick" : "Tick as played"}" aria-label="${played ? "Un-tick" : "Tick"}">${played ? "✓" : ""}</button>`}
      <div class="oc-songmain">
        <div class="oc-songtitle">${g.mustPlay ? `<span class="oc-star" title="Must play">★</span>` : ""}${songLine(g)}</div>
        ${g.notes ? `<div class="oc-songnote">${esc(g.notes)}</div>` : ""}
      </div>
      ${g.path ? `<span class="oc-file" title="${esc(g.path)}">●</span>` : `<span class="oc-file none" title="Not matched to a file in Prep yet">○</span>`}
      ${onDeck ? `<span class="oc-ondeck">DECK ${onDeck.deck}</span>` : ""}
    </li>`;
  }

  function sectionHtml(s, nowId) {
    const musts = s.songs.filter((g) => g.mustPlay);
    const mustDone = musts.filter((g) => snap.played[g.id]).length;
    const isOpen = open.has(s.id);
    const extra = [s.description, s.notes].filter(Boolean);
    const body = isOpen
      ? `<div class="oc-secbody">
          ${extra.map((t) => `<p class="oc-note">${esc(t)}</p>`).join("")}
          ${s.answers.map((a) => `<p class="oc-ans"><span>${esc(a.question)}</span>${esc(a.answer)}</p>`).join("")}
          ${s.songs.length ? `<ul class="oc-songs">${[...s.songs].sort((a, b) => Number(b.mustPlay) - Number(a.mustPlay)).map((g) => songRow(g, s.doNotPlay)).join("")}</ul>` : extra.length || s.answers.length ? "" : `<p class="oc-note dim">No songs or notes.</p>`}
        </div>`
      : "";
    return `<div class="oc-sec${s.id === nowId ? " now" : ""}${s.doNotPlay ? " dnpsec" : ""}${isOpen ? " open" : ""}" data-sec="${s.id}">
      <button class="oc-sechead" data-toggle="${s.id}">
        <span class="oc-time">${s.time ? esc(s.time) : s.doNotPlay ? "DNP" : ""}</span>
        <span class="oc-secname">${esc(s.name)}</span>
        ${s.id === nowId ? `<span class="oc-now">NOW</span>` : ""}
        <span class="oc-count">${musts.length ? `<span class="${mustDone === musts.length ? "done" : ""}">★ ${mustDone}/${musts.length}</span> · ` : ""}${s.songs.length || ""}${s.songs.length ? (s.songs.length === 1 ? " song" : " songs") : ""}</span>
        <span class="oc-chev">${isOpen ? "▾" : "▸"}</span>
      </button>
      ${body}
    </div>`;
  }

  function render() {
    const p = panel();
    if (!p || !snap) return;
    const scroller = p.querySelector(".oc-scroll");
    const keepScroll = scroller ? scroller.scrollTop : 0;

    if (!snap.configured) {
      p.innerHTML = `<div class="oc-empty"><div class="big">On Cue</div>
        <p>Keep the client's plan beside your decks: must-plays tick off as you play them, and you're warned the moment a do-not-play is loaded.</p>
        <p class="dim">In the CRM open <b>Settings → Music Planner → On Cue</b>, copy the address and key, and paste them into Banger's settings.</p>
        <button class="primary" id="ocOpenSettings">Open settings</button></div>`;
      el("ocOpenSettings")?.addEventListener("click", () => el("settingsModal").hidden = false);
      return;
    }

    const plan = snap.plan;
    const chosen = snap.events.some((e) => e.id === snap.eventId);
    const evOpts = (chosen ? "" : `<option value="" selected disabled>Pick an event…</option>`) + snap.events.map((e) => `<option value="${e.id}" ${e.id === snap.eventId ? "selected" : ""}>${e.today ? "Tonight · " : `${fmtDay(e.date)} · `}${esc(e.name)}${e.hasPlan ? "" : " (no plan)"}</option>`).join("");
    // A refused key or a wrong address is never "just offline": say so, with the way to fix it.
    const needsSettings = /key|address|settings/i.test(snap.error || "");
    const status = snap.error && (!plan || needsSettings)
      ? `<div class="oc-err">${esc(snap.error)}${needsSettings ? ` <button class="oc-fix" id="ocFix">Open settings</button>` : ""}${plan ? `<br><span class="dim">Showing the copy saved ${esc(snap.planAge || "earlier")}.</span>` : ""}</div>`
      : snap.offline
        ? `<div class="oc-warn">Offline — showing the copy saved ${esc(snap.planAge || "earlier")}.</div>`
        : "";

    let body = "";
    if (!plan) {
      body = `<div class="oc-empty small">${snap.events.length ? "Pick an event above." : snap.error ? "" : "No booked events in the next six weeks."}</div>`;
    } else {
      const nowId = nowSectionId(plan);
      if (!userTouchedOpen && nowId && !open.has(nowId)) open.add(nowId);
      const main = plan.sections.filter((s) => !s.doNotPlay);
      const dnpSecs = plan.sections.filter((s) => s.doNotPlay);
      let lastGroup = null;
      const rows = main.map((s) => {
        const head = s.group !== lastGroup ? `<div class="oc-group">${esc(s.group)}</div>` : "";
        lastGroup = s.group;
        return head + sectionHtml(s, nowId);
      }).join("");
      const dnpSongs = dnpSecs.flatMap((s) => s.songs);
      const dnpBox = dnpSongs.length || plan.doNotPlay.notes.length
        ? `<div class="oc-dnpbox"><div class="oc-dnphead">⛔ Do not play <span>${dnpSongs.length + plan.doNotPlay.notes.length}</span></div>
            <ul>${dnpSongs.map((g) => `<li>${songLine(g)}</li>`).join("")}${plan.doNotPlay.notes.map((n) => `<li class="note">“${esc(n)}”</li>`).join("")}</ul></div>`
        : `<div class="oc-dnpbox empty"><div class="oc-dnphead">⛔ Do not play <span>0</span></div><p class="dim">Nothing on the list.</p></div>`;
      const decks = snap.decks.length ? `<div class="oc-decks">${snap.decks.map(deckRow).join("")}</div>` : "";
      const djNotes = plan.event.djNotes ? `<p class="oc-djnotes">${esc(plan.event.djNotes)}</p>` : "";
      body = `${decks}<div class="oc-scroll">${djNotes}${rows}${dnpBox}</div>`;
    }

    const mp = snap.mustPlay;
    const pct = mp.total ? Math.round((mp.played / mp.total) * 100) : 0;
    p.innerHTML = `
      <div class="oc-head">
        <select id="ocEvent" class="oc-select" ${snap.events.length ? "" : "disabled"}>${evOpts || `<option>No events</option>`}</select>
        ${plan ? `<button class="oc-send" id="ocCrate" title="Write tonight's plan into Serato as crates — the event, then one subcrate per section">${crate?.state === "waiting" ? "Waiting for Serato…" : "Send to Serato"}</button>` : ""}
        <button class="oc-icon" id="ocRefresh" title="Reload the plan from the CRM" aria-label="Reload">↻</button>
        <button class="oc-icon ${docked ? "on" : ""}" id="ocDock" title="${docked ? "Docked beside the decks on Home" : "Dock beside the decks on Home"}" aria-label="Dock">⫷</button>
      </div>
      ${plan ? `<div class="oc-meta">${esc([fmtDay(plan.event.date), plan.event.venue, [plan.event.startTime, plan.event.endTime].filter(Boolean).join("–")].filter(Boolean).join(" · "))}</div>
      <div class="oc-progress" title="Must-plays played"><div class="bar"><i style="width:${pct}%"></i></div><span>★ ${mp.played}/${mp.total} must-plays</span></div>` : ""}
      ${status}
      ${crateLine()}
      ${body}`;

    const sc = p.querySelector(".oc-scroll");
    if (sc) {
      sc.scrollTop = keepScroll;
      // First look at a plan: land on what's happening now.
      if (plan && scrolledFor !== plan.event.id) {
        const nowEl = sc.querySelector(".oc-sec.now");
        if (nowEl) { sc.scrollTop = Math.max(0, nowEl.offsetTop - sc.offsetTop - 40); scrolledFor = plan.event.id; }
      }
    }
    el("ocEvent")?.addEventListener("change", (e) => post("/oncue/select", { eventId: e.target.value }));
    el("ocRefresh")?.addEventListener("click", () => post("/oncue/refresh", {}));
    el("ocFix")?.addEventListener("click", () => { el("settingsModal").hidden = false; el("ocUrl")?.focus(); });
    el("ocCrate")?.addEventListener("click", () => post("/oncue/crate", crate?.state === "waiting" ? { cancel: true } : {}));
    el("ocCrateDismiss")?.addEventListener("click", () => { crate = null; render(); });
    el("ocDock")?.addEventListener("click", () => { docked = !docked; localStorage.setItem("oncue-docked", docked ? "1" : "0"); place(); render(); });
    for (const b of p.querySelectorAll("[data-toggle]")) b.addEventListener("click", () => {
      const id = b.dataset.toggle;
      userTouchedOpen = true;
      open.has(id) ? open.delete(id) : open.add(id);
      saveOpen();
      render();
    });
    for (const b of p.querySelectorAll("[data-tick]")) b.addEventListener("click", (e) => {
      e.stopPropagation();
      post("/oncue/tick", { songId: b.dataset.tick, on: b.dataset.on === "1" });
    });
  }

  function crateLine() {
    if (!crate) return "";
    if (crate.state === "waiting") return `<div class="oc-crate wait">Serato is open — it rewrites crates when it quits, so the crates will be written the moment you quit Serato. Tap the button again to cancel.</div>`;
    if (crate.state === "error") return `<div class="oc-crate err">Couldn't write the crates: ${esc(crate.error)} <button class="oc-x2" id="ocCrateDismiss" aria-label="Dismiss">×</button></div>`;
    const miss = crate.missing?.length ? ` <span class="miss" title="${esc(crate.missing.join("\n"))}">${crate.missing.length} not in your library</span>` : "";
    return `<div class="oc-crate ok">✓ “${esc(crate.parent)}” — ${crate.tracks} tracks in ${crate.crates - 1} section crate${crate.crates === 2 ? "" : "s"}.${miss} Open Serato to see it at the top of your crates. <button class="oc-x2" id="ocCrateDismiss" aria-label="Dismiss">×</button></div>`;
  }

  /** The red banner + flashing pill + tab badge. */
  function renderAlert() {
    const a = snap?.alert;
    const banner = el("dnpBanner");
    banner.hidden = !a;
    if (a) {
      el("dnpBannerHead").textContent = a.played ? "DO-NOT-PLAY IS PLAYING" : "DO NOT PLAY — LOADED";
      el("dnpBannerText").textContent = `${a.title}${a.artist ? ` — ${a.artist}` : ""}${a.how === "note" ? `  (their note: “${a.dnp}”)` : ""}`;
      el("dnpBannerDeck").textContent = `DECK ${a.deck}`;
      banner.classList.toggle("soft", !!a.played);
    }
    el("collapsedPill")?.classList.toggle("dnp", !!a && !a.played);
    const badge = el("oncueTabBadge");
    if (snap?.plan && snap.mustPlay.total) {
      badge.hidden = false;
      badge.textContent = `${snap.mustPlay.played}/${snap.mustPlay.total}`;
    } else badge.hidden = true;
  }

  /** Tab or dock: the dock shows on Home when the window is wide enough. */
  function place() {
    const p = panel();
    const showDock = docked && !!snap?.configured && currentView === "home" && window.innerWidth >= DOCK_MIN_W;
    const dock = el("oncueDock");
    const target = showDock ? dock : el("oncueHome");
    if (p.parentElement !== target) target.appendChild(p);
    dock.hidden = !showDock;
  }

  function syncSettings() {
    if (!snap) return;
    const st = el("ocStatus");
    st.textContent = snap.configured ? (snap.error ? "check settings" : "connected") : "not connected";
    st.classList.toggle("on", snap.configured && !snap.error);
    const url = el("ocUrl");
    if (url && document.activeElement !== url) url.value = snap.crmUrl || "";
    el("ocKey").placeholder = snap.hasKey ? "Key saved — paste a new one to replace it" : "On Cue key — oc1.…";
  }

  window.onOncue = (s) => {
    snap = s;
    place();
    render();
    renderAlert();
    syncSettings();
  };
  window.onViewChange = () => { place(); render(); };
  window.onCrate = (c) => { crate = c; render(); };
  window.addEventListener("resize", () => place());
  // The NOW marker moves with the clock even when nothing else changes.
  setInterval(() => { if (snap?.plan) render(); }, 60000);

  // ---- settings ------------------------------------------------------------------------
  const result = (msg, ok) => {
    const r = el("ocResult");
    r.hidden = !msg;
    r.textContent = msg || "";
    r.classList.toggle("ok", !!ok);
  };
  el("ocSave")?.addEventListener("click", async () => {
    const crmUrl = el("ocUrl").value.trim();
    const key = el("ocKey").value.trim();
    if (!crmUrl) return result("Add the CRM address first.");
    if (!/^https?:\/\//.test(crmUrl)) return result("The address starts with https://");
    if (!key && !snap?.hasKey) return result("Paste the On Cue key from the CRM.");
    result("Connecting…");
    try {
      const r = await fetch(API + "/oncue/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ crmUrl, key }) });
      const j = await r.json();
      el("ocKey").value = "";
      result(j.error ? j.error : "Connected — tonight's plan is in the On Cue tab.", !j.error);
    } catch {
      result("Couldn't reach Banger's engine.");
    }
  });
  el("ocDisconnect")?.addEventListener("click", async () => {
    await post("/oncue/settings", { disconnect: true });
    el("ocUrl").value = "";
    el("ocKey").value = "";
    result("Disconnected.", true);
  });
})();
