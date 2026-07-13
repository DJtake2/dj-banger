# Building a Banger Button clone for Serato — full options map

This maps **every viable way** to build each piece of a Banger Button-style tool on top of
Serato DJ, with tradeoffs, so you can pick a path. The recommendation engine (this repo) is
the easy 20%. The 80% is plumbing into Serato: **read the library**, **know what's playing**,
and **get a track into the deck**. None of these have an official public API, so each is an
"options" problem.

Findings from scanning **your actual library** (70,814 tracks) are folded in throughout.

---

## 0. The shape of the product

```
        ┌─────────────────────────────────────────────────────┐
        │  YOUR APP (menubar / floating window next to Serato) │
        │                                                      │
        │   [now playing] ──► ENGINE ──► [ranked next-up list] │
        │        ▲                              │              │
        └────────┼──────────────────────────────┼─────────────┘
                 │ (2) detect                    │ (3) inject
                 │                               ▼
        ┌────────┴───────┐            ┌──────────────────────┐
        │  SERATO DJ     │◄───────────│  drag file / write   │
        │                │  (1) read  │  crate               │
        └────────────────┘            └──────────────────────┘
         library on disk
```

Three integration surfaces, numbered (1)(2)(3) below. Then engine quality (4), energy (5),
packaging (6), streaming/discovery (7), and a phased plan (8).

---

## 1. Reading the library  — ✅ SOLVED in this prototype

**What we did:** parse `~/Music/_Serato_/database V2` and `Subcrates/*.crate` directly.
Format is `[4-byte tag][uint32 BE length][payload]`; verified against your library.

Your data quality (this matters for the engine):

| Field | Coverage | Notes |
|-------|----------|-------|
| BPM | **94%** | excellent — BPM matching is reliable |
| Key | **67%** | musical notation (`Em`, `Ebm`, `G#m`); parser handles it. 33% unkeyed |
| Genre | **82%** | good for genre affinity |
| Energy | **~0%** | not tagged — biggest gap (see §5). Your *comments* hold Camelot codes, not energy |

Options if you want more than the flat-file read:

| Option | How | Pros | Cons |
|--------|-----|------|------|
| **A. Parse flat files** *(chosen)* | read `database V2` + crates | no deps, fast (0.7s/70k), offline, works today | read-only snapshot; must re-read on change |
| B. Watch for changes | `fs.watch` the `_Serato_` dir | live-ish updates as you edit tags | Serato writes on quit/save, not instantly |
| C. Read tags from the audio files | `music-metadata` npm on each mp3 | ground truth, gets fields Serato omits | slow for 70k, lots of disk I/O |
| D. Third-party lib | `serato-tools` (py), `triseratops` (rust) | battle-tested edge cases | extra runtime; ours already works |

**Recommendation:** keep A, add B (watch) so the app refreshes when you tag in Serato.
Cache parsed results to disk keyed by file mtime so startup is instant after first run.

---

## 2. Knowing what's playing (now-playing detection) — ⚠️ THE HARD ONE

Serato exposes no local "now playing" API. Ranked by robustness:

| Option | Mechanism | Latency | Reliability | Effort |
|--------|-----------|---------|-------------|--------|
| **A. Serato History session file** | Serato writes `History/*.session` (same tag format) as you play; tail it | ~seconds | High — official artifact | Low ⭐ best first move |
| **B. Live Playlists** | Enable Serato's Live Playlists → it POSTs now-playing to serato.com; scrape your own feed | seconds | Medium; needs the feature on + internet | Low |
| C. Serato's `_Serato_` history log watch | `fs.watch` History dir, parse newest entry | seconds | High | Low-Med |
| D. Audio fingerprinting | capture system audio (BlackHole/Loopback) → fingerprint vs your library (chromaprint) | 5–10s | Medium; app-agnostic; survives any DJ app | High |
| E. Screen/OCR the deck | read the track title region off screen | ~1s | Fragile to layout/theme | Med |
| F. MIDI/HID from controller | map your controller's load button through a virtual port | instant | Only knows "a load happened", not *what* | Med |

**The winner for Serato: Option A (History session files). ✅ BUILT (`serato/history.ts`).**
Serato records every played track to `~/Music/_Serato_/History/Sessions/<n>.session`. The
outer envelope is the same tag format (`vrsn` + `oent`), but each `oent` wraps an `adat` blob
that uses a *numeric-TLV* inner encoding — field **2 = absolute path**, 6 = title, 7 = artist,
9 = genre. We tail the newest session, take the last `oent`, normalise the path, and look it
up in the in-memory library for full key/BPM. Verified live against a real session.

**Measured loop latency (70,814-track library, this machine):**

| Stage | Time | When |
|-------|------|------|
| Library load | ~710 ms | once, at startup |
| fs.watch event (FSEvents) | ~12 ms | per change |
| Parse newest session (detect) | ~28 ms | per change |
| Engine pass (score all 70k) | ~57 ms | per change |
| Encode + write crate | ~0.4 ms | per change |
| Debounce (default, tunable) | 75 ms | per change |
| **Serato write → suggestions ready** | **~100–250 ms** | **per change** |

So the tool itself adds a fraction of a second. The real gate is how fast **Serato** commits
the play to its history file — everything downstream of that is ~100 ms. Headroom exists: the
28 ms detect cost is mostly re-scanning 1,787 session files for the newest; caching the current
session path drops it to ~1 ms, and an early-BPM prefilter would cut the 57 ms engine pass.

Fallback stack: A primary, D (fingerprinting) as the app-agnostic safety net for when you
want it to work even outside Serato.

> Reality check: this is exactly why Banger Button leaned into **VirtualDJ** in 2.0 — VDJ has
> a real plugin API that hands you deck state directly. On Serato, history-file tailing is the
> pragmatic equivalent.

---

## 3. Getting the track into the deck (inject) — ⚠️ MEDIUM

You've picked a banger; now load it. Options:

| Option | Mechanism | UX | Effort | Notes |
|--------|-----------|----|--------|-------|
| **A. Native OS drag-and-drop** | app window exposes the file; user drags onto Serato deck | one drag — *exactly Banger Button's UX* | Med | needs native drag source (Tauri/Electron/Swift) |
| **B. Write a "Suggestions" crate** | engine writes top-N to a `.crate` Serato auto-reloads | tracks appear in a Serato crate; you load normally | Low ⭐ easiest real integration | we already parse crates — writing is the inverse |
| C. Reveal-in-Finder + drag | open the file location | clunky | Low | fallback |
| D. Simulated load via controller MIDI | send a load command | risky, controller-specific | High | not recommended |

**Recommendation:** ship **B first** (write a live-updating `Serato Suggestions` crate — zero
native code, works immediately), then add **A** (true drag-and-drop) when you build the
native shell for the polished one-motion feel.

> ⚠️ Safety: only ever **add** a dedicated suggestions crate. Never rewrite `database V2` or
> existing crates from the app — corrupting a 70k library would be catastrophic. Treat Serato's
> own files as read-only; write only your own new crate file, ideally while Serato is closed or
> via its auto-reload.

---

## 4. The engine — quality upgrades beyond this prototype

Current core scores key + BPM + energy + genre with tunable weights and explains itself.
Roadmap of smarter behaviour:

- **De-duplicate versions. ✅ DONE (`dedupe.ts`).** Collapses near-dupes (Clean/Dirty/Intro/
  Acapella/Extended) by a normalised song key so the list isn't 6× "Take It Easy"; keeps real
  remixes/bootlegs distinct; excludes other edits of the track that's currently playing.
- **Set-aware sequencing.** Feed `playedIds` (from §2 history) so it avoids repeats and can
  steer an energy arc across the night, not just the next track.
- **Crowd/context filters.** "Wedding open-dancing" vs "peak club" — filter by crate, genre,
  year, or a custom tag before ranking. You already keep curated crates (e.g. `Connaker Wedding`).
- **Learn from you.** Log which suggestions you actually load; nudge weights toward your real
  transitions. This is the "learns your style" claim, done honestly and locally.
- **Phrase/length awareness.** Prefer tracks whose structure suits the moment (needs cue/beatgrid
  data, which Serato stores in `_Serato_` overrides — parseable later).
- **"Compatible but surprising" mode.** Occasionally surface a harmonically-valid track from a
  different genre/era to avoid a stale, same-y set.

---

## 5. The energy problem — your biggest data gap

Serato has **no energy field**, and your library has essentially none tagged. Options to get
real energy (1–10) instead of the BPM proxy this prototype falls back to:

| Option | How | Quality | Effort |
|--------|-----|---------|--------|
| **A. Offline audio analysis** ✅ DONE | ffmpeg EBU R128 loudness + dynamics + BPM → energy; cached, resumable, lazy | real, offline, ~5/s | built (`analysis/`) |
| **B. Spotify Audio Features** | match track → Spotify → `energy`/`danceability`/`valence` | good, easy, you know this API | needs match + internet + API |
| C. Mixed In Key / Lexicon | run their tools; they write energy you then read from tags | proven; Lexicon you already own | manual step, cost |
| D. Keep proxy | BPM+genre estimate (current) | rough, but non-blocking | none — already done |

**Recommendation:** **A** for accuracy (batch-analyse once, cache to a local sidecar DB), with
**B** as a quick win if you want energy *today* using Spotify features (you've already built
Spotify matching elsewhere — the technique transfers, kept fully separate from that project).
Since you own **Lexicon**, option C is a legitimate shortcut: tag energy there, we read it.

---

## 6. Packaging — turning the engine into "the app"

| Option | Stack | Pros | Cons |
|--------|-------|------|------|
| **A. Tauri** | Rust + web UI | tiny, native drag-and-drop, fast FS; you already ship Tauri | Rust for native bits |
| B. Electron | Node + web UI | all-JS, this engine drops in as-is, huge ecosystem | heavy (~150MB), more RAM |
| C. Swift/AppKit menubar | native macOS | best drag-and-drop + menubar feel, lowest overhead | rewrite engine or bridge to Node |
| D. Headless + local web UI | Node server + browser tab | fastest to a usable UI, reuse engine verbatim | no native drag; use §3-B crate injection |

**Recommendation:** prototype UI as **D** (Node + a local page showing live suggestions —
reuses this engine and §3-B crate writing with zero native code), then graduate to **A (Tauri)**
for the floating always-on-top window + real drag-and-drop, matching Banger Button's feel. A
menubar/floating window that sits beside Serato is the right form factor.

---

## 7. Streaming & discovery (the "beyond your library" layer)

Banger Button advertises Spotify/Apple Music/Tidal and Crate Hackers charts. That's discovery,
not mixing. Options, only if you want it:

- **Suggest from streaming**: match your seed to Spotify, pull *related tracks*, then check which
  you already own (fuzzy match against the library) → surfaces owned tracks you forgot + a
  "buy/download" list for ones you don't. Legally clean (you play your own files).
- **Import curated crates/charts**: ingest a playlist/CSV → write a Serato crate (§3-B).
- **Keep it optional & offline-first**: your gigs are "basement clubs / festival fields" — the
  core must work with no internet, exactly like Banger Button's offline caching claim.

---

## 8. Recommended phased build

**Phase 1 — CLI truth (DONE, this repo).** Parse library, harmonic engine, explainable ranking,
tests. Proven on 70k tracks.

**Phase 2 — Live loop, no UI. ✅ DONE.** History-session tailing (§2-A) → auto-recommend on
every track change → write a live `Serato Suggestions` crate (§3-B). `npm run live`. Usable in
a real set with zero native code. **Measured latency below.**

**Phase 3 — Real energy + de-dupe. ✅ DONE.** Offline audio analysis via ffmpeg (§5-A) —
EBU R128 loudness + dynamics + BPM → energy 1..10, cached in `.cache/energy.json` (size+mtime
keyed, resumable). `npm run analyze` batches it (~5 tracks/s @ concurrency 8); the live loop
also analyses the playing track on the fly (~0.3s) so the cache self-fills as you play. Version
de-dupe (§4) collapses Clean/Dirty/Intro/Extended edits to one per song and excludes other
edits of the currently-playing track, while keeping genuine remixes/bootlegs distinct.
Verified on the real library: the "6× Blessings Remix" flood collapsed to one + distinct songs.

**Phase 4 — The app. ✅ DONE (UI + engine bridge verified; native shell scaffolded).** Floating
window in `app/`: dark, always-on-top, frameless. UI (`app/public/`, no framework) fed by
`app/bridge.mjs` (Node → SSE) running the engine; energy-trajectory toggle, prep-mode manual
seed, semantic color (key-match / energy / score). Verified live in-browser against the real
library. Tauri shell (`app/src-tauri/`, §6-A) adds the native always-on-top window +
`tauri-plugin-drag` one-drag load (§3-A) — scaffolded, needs one on-device `npm run dev` to
confirm (can't compile/drive a GUI headless). Still to add: BPM-tolerance/crate-filter controls,
learn-from-loads.

**Phase 5 — Discovery (optional).** Streaming-based suggestions + chart/crate import (§7).

The moat, as with the real product, is Phases 2–4 (the plumbing + feel) — not the AI. This repo
gets Phase 1 done and de-risks the format parsing that everything else stands on.

---

## Honest effort estimate

| Piece | Status / effort |
|-------|-----------------|
| Recommendation engine | ✅ done |
| Serato library + crate parsing | ✅ done, verified on 70k |
| Now-playing (History tailing) | ~1–2 days (extends existing parser) |
| Suggestions-crate injection | ~1 day |
| Native drag-and-drop | ~2–4 days (Tauri) |
| Real energy (offline analysis) | ~2–3 days incl. batch run |
| Floating UI / tuning | ~1 week |
| **Usable-in-a-set MVP (Phases 1–2)** | **~2–3 days from here** |
