# Banger — DJ next-track app for Serato

A standalone **next-track recommendation app for Serato DJ** — a Banger Button-style
"what do I play next?" tool. Pure TypeScript engine (zero runtime deps) + a dark floating UI.

> Lives completely separate from the CRM. Nothing here touches that project.

## ▶ Run it now

```bash
cd ~/dj-banger
./start.sh                 # starts the app + opens http://localhost:4177 in your browser
```

That's it. Open Serato, play a track, and Banger shows ranked next-track suggestions live —
color-coded keys, energy, half/double-time BPM, de-duped versions, search/prep mode,
energy & genre filters, and multi-select → export a Serato crate.

First run analyses the playing track's energy on the fly (~0.3s). To pre-warm real energy for
your whole library in the background: `npm run analyze` (optional; ~5 tracks/s, resumable).

## What it does

Give it the track that's playing (the *seed*) and your library; it returns a ranked,
**explained** list of what to mix next — scored on harmonic key compatibility (Camelot
wheel), BPM proximity (with half/double-time), energy, and genre.

It also reads your real Serato library directly from `~/Music/_Serato_`:
the binary `database V2` and `.crate` files, fully reverse-engineered and verified against
a 70,000-track library (parses in ~0.7s).

## Command-line tools (optional)

The app above is the main way to use it. These CLIs are handy for testing / scripting:

```bash
cd ~/dj-banger
export PATH="$HOME/.local/node/bin:$PATH"   # your node install

npm test                 # 26 tests (engine + Serato I/O + de-dupe + energy)
npm run scan             # data-quality report on YOUR real Serato library
npm run demo             # pick a seed, print next-track suggestions
npm run nowplaying       # read what's playing from Serato History → suggest
npm run live             # live loop in the terminal (also writes a Serato crate)
npm run analyze          # batch audio-analyse real energy (ffmpeg)
node src/cli.ts --seed "hamilton"   # seed by title/artist substring
```

### Live loop (Phase 2)

```bash
npm run live               # watch Serato, print suggestions on every track change,
                           #   and publish a "Banger Suggestions" crate
node src/liveCli.ts --build     # build the energy across the set
node src/liveCli.ts --no-crate  # console only, never write to Serato
node src/liveCli.ts --once      # evaluate the current track once and exit
```

It loads your library once (~0.7s), then reacts to each track you play by tailing
`~/Music/_Serato_/History/Sessions/`. **Measured end-to-end latency from Serato's disk
write to suggestions ready: ~120–300ms** (fs event ~12ms + compute ~90ms + debounce). The
binding constraint is Serato's own history-write cadence, not this tool.

### Real energy (Phase 3)

Serato has no energy field and your library has ~0% tagged, so energy is measured from the
audio with ffmpeg (EBU R128 loudness + dynamics, combined with BPM). Results are cached in
`.cache/energy.json` (never in Serato), keyed by file size+mtime — analyse once, instant after.

```bash
npm run analyze                          # whole library (uncached only), resumable
node src/analyzeCli.ts --crate "D-BACKS" # just one crate
node src/analyzeCli.ts --limit 500 --concurrency 12
```

~5 tracks/s at concurrency 8. You don't have to batch everything: the **live loop analyses the
currently-playing track on the fly** (~0.3s) and caches it, so your active library fills in as
you play. Until a track is analysed, it falls back to a BPM+genre proxy (flagged `derived`).

### Floating window (Phase 4)

A native, always-on-top, frameless dark window that sits next to Serato — see [app/](app/).

```bash
node app/bridge.mjs      # → http://localhost:4177 (works in any browser, no Tauri needed)
cd app && npm install && npm run dev    # the real Tauri floating window
```

The UI (`app/public/`, pure HTML/CSS/JS) is fed by `app/bridge.mjs`, a tiny Node server that
runs this engine and streams suggestions over SSE. Color is used only where it means something:
key-match (green/amber/rose), energy (cool→hot gradient, `EST` = still proxy), score (violet).
Includes **prep mode** (`POST /seed`) to rank against a track you're about to play. The Tauri
shell adds the native window + drag-into-deck (`tauri-plugin-drag`). The UI + engine are
verified live; the native shell is scaffolded (needs one on-device `npm run dev`).

### De-dupe (Phase 3)

Near-duplicate versions (Clean / Dirty / Intro / Extended Mix / "…- Quick Hit Edit") are
collapsed to one suggestion per song, and other edits of the *currently-playing* song are
excluded. Genuine remixes / bootlegs / flips are kept as distinct options. On by default;
disable with `dedupeVersions: false`.

Requires Node ≥ 22 (uses native TypeScript execution — no build step).

## Layout

```
src/
  types.ts          Domain model (Track, EngineConfig, Suggestion) — Serato-agnostic
  camelot.ts        Key parsing (Camelot / OpenKey / musical) + harmonic scoring
  energy.ts         Energy: read from tags, else proxy-estimate (Serato has no energy field)
  engine.ts         ⭐ the recommendation core — pure, deterministic, reusable
  dedupe.ts         ⭐ Phase 3 version de-dupe (songKey normalisation)
  live.ts           ⭐ Phase 2 live loop — watch → detect → recommend → publish
  serato/
    parser.ts       Serato binary format reader (database V2 + .crate)
    library.ts      Load Serato → Track[]
    history.ts      Now-playing detection (tail History session files)
    crateWriter.ts  Publish suggestions back as a Serato crate (safe, atomic)
  analysis/
    analyze.ts      ⭐ Phase 3 real energy via ffmpeg (loudness + dynamics)
    energyStore.ts  Persistent energy cache (.cache/energy.json)
    applyEnergy.ts  Apply cache to tracks + batch analyser (concurrency pool)
  cli.ts            Demo + scanner + --nowplaying (read-only)
  liveCli.ts        Live loop runner (npm run live)
  analyzeCli.ts     Batch analyser runner (npm run analyze)
test/
  engine.test.ts    Engine unit tests
  serato.test.ts    Crate round-trip + history parsing
  phase3.test.ts    De-dupe + energy parsing/mapping
OPTIONS.md          Full map of how to build the complete Banger Button clone
```

## The engine in one call

```ts
import { recommend } from "./src/engine.ts";
import { loadLibrary } from "./src/serato/library.ts";

const lib = await loadLibrary();                 // your Serato library
const seed = lib.find(t => t.title.includes("Helpless"))!;
const nextUp = recommend({ seed }, lib, {
  energyDirection: "build",   // "flat" | "build" | "cool"
  bpmTolerancePct: 6,
  weights: { key: 0.4, bpm: 0.3, energy: 0.2, genre: 0.1 },
  limit: 10,
});
// → [{ track, score, breakdown, reasons: ["Perfect key (7B)", "+1 BPM", "Energy +1"] }, ...]
```

The engine only ever sees `Track` — so the same core works for rekordbox/Traktor/VirtualDJ
once you add a loader for those. See **OPTIONS.md** for the full build-out.

## What this prototype is / isn't

- ✅ Real Serato library parsing at scale, harmonic engine, explainable ranking, tuning knobs.
- ⛔ Not yet: live now-playing detection, drag-into-deck, a UI, real audio-analysed energy.
  Those are the "make it feel like the product" pieces — all mapped in **OPTIONS.md**.
