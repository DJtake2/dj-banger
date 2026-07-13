# Banger — floating window (Phase 4)

An always-on-top, frameless, dark floating window that sits next to Serato, shows what's
playing, and streams ranked next-track suggestions you drag straight onto a deck.

Two layers:
- **UI** (`public/`) — the design. Pure HTML/CSS/JS, no framework, no build step.
- **Bridge** (`bridge.mjs`) — a tiny Node server that runs the Phase 1–3 engine (library load,
  now-playing detection, de-dupe, real energy) and pushes suggestions to the UI over SSE.
- **Tauri shell** (`src-tauri/`) — the native window (always-on-top / transparent / drag-out).

## Run it in a browser (no Tauri needed — this is how the design was built & verified)

```bash
cd ~/dj-banger && export PATH="$HOME/.local/node/bin:$PATH"
node app/bridge.mjs           # → http://localhost:4177
```

Open the URL. It connects to the live engine and updates as you play tracks in Serato.
Everything works here except the *native* drag-into-Serato (browsers can't start an OS file
drag) — the layout, colors, live updates, de-dupe, energy, and prep mode are all fully live.

### Prep mode (suggest for a track you're *about* to play)

Use the **search box** at the top of the window: type a title/artist, pick from the live
dropdown (↑/↓/Enter or click), and the panel ranks against that track. The header switches to
an amber **PREP** state with a **BACK TO LIVE** button that returns to Serato's now-playing.
Handy for cueing your next move, and it's the clearest way to see the harmonic color system
(green = perfect/adjacent key, amber = energy boost, rose = clash).

Endpoints behind it (also scriptable):
```bash
curl "http://localhost:4177/search?q=levitating"                      # typeahead matches
curl -X POST http://localhost:4177/seed -d '{"id":"Users/.../track.mp3"}'  # prep a track
curl -X POST http://localhost:4177/live                                # back to now-playing
curl -X POST http://localhost:4177/filter -d '{"energy":"hot","genre":"House"}'  # filter
curl -X POST http://localhost:4177/crate -d '{"ids":["..."],"name":"My Picks"}'  # export crate
```

## Banger Button-style features

- **Deck 1 / Deck 2 split** — reads Serato's per-deck state from the history (adat field 31) and
  shows what's loaded on each deck (key/BPM/energy). The active deck drives suggestions; tap the
  other deck to get suggestions for it. Both decks' energy is analysed live.
- **Settings** (gear, top-right) — connect **Spotify** (your app's Client ID/Secret, saved locally
  to `.config.json`), plus placeholders for other syncs (Apple Music / Tidal / Beatport / folders).
- **Filters** (funnel, in NEXT UP) — a collapsible panel:
  - **Key**: Any · Match (same key) · Compatible (adjacent/relative) · Boost (energy-boost keys)
  - **BPM**: Any · ±3 · ±5 · Range (min/max) — all half/double-time aware
  - **Energy**: All · Chill · Mid · Hot   ·   **Mix**: Any · Clean · Dirty   ·   **Genre** dropdown
  - A badge shows how many filters are active; they survive deck focus changes.
- **Color-coded Camelot keys** — every key badge is tinted by its key identity (the wheel).
- **Multi-select → crate** — tick the checkbox on any suggestions, then **Export crate** writes
  them to a Serato crate (reuses the Phase 2 writer; only ever creates its own new file).
- **Energy / genre filters** — the `EN` pills (All/Chill/Mid/Hot) and genre dropdown constrain
  candidates before ranking (via the engine's candidate filter).
- **From Spotify** — a "beyond your library" section. Set `SPOTIFY_CLIENT_ID` /
  `SPOTIFY_CLIENT_SECRET` (a free Spotify app, client-credentials — no user login) to enable.
  It surfaces the seed artist's + related artists' top tracks and flags which you already own
  (owned tracks are click-to-prep). ⚠️ Spotify removed the Recommendations & Audio-Features
  endpoints for new apps (Nov 2024), so this is discovery-by-artist, without Spotify-provided
  key/BPM. Without creds the section shows a Connect prompt.

## Run it as the real floating app (Tauri)

Prereqs: Rust (`cargo`), and the Tauri CLI (`npm i` in this folder installs it).

```bash
cd ~/dj-banger/app
npm install
npm run dev        # starts the bridge (beforeDevCommand) + opens the floating window
# or:
npm run build      # produces a .app / .dmg
```

`tauri dev` launches `bridge.mjs` automatically and points the window at it.

### Drag-into-Serato

Uses `tauri-plugin-drag`: on `dragstart`, the frontend calls `window.__TAURI__.drag.startDrag`
with the track's absolute path, and the OS performs a real file drag Serato's deck accepts.
> ⚠️ The native window (always-on-top / transparent) and drag-out are scaffolded but need one
> `npm run dev` pass on your Mac to confirm/adjust — they can't be compiled or driven in a
> headless environment. Everything upstream (UI + engine) is verified.

## Design notes

Dark, glanceable, club-friendly. Color is used **only where it means something**:
- **Key identity** → every key badge is tinted by its Camelot colour (the rainbow "wheel"
  DJs know — 1 green → 10 orange → 12 lime), so you read the key at a glance. Banger Button's
  signature, applied to now-playing, suggestions, and the search dropdown.
- **Key-match** → the left bar per row: green (perfect/adjacent) · amber (energy boost) ·
  rose (clash) · neutral (unknown). So each row shows *which* key (badge colour) AND *how well
  it mixes* (bar colour).
- **Energy** → a cool→hot gradient meter; `EST` tag when energy is still proxy-estimated
- **Score** → the violet accent bar
- **Tempo** → the BPM shows a `2×` / `½×` tag on half/double-time matches with the *effective*
  offset (a 60-BPM seed vs a 119-BPM track reads `119 · 2× · ±0`, not a misleading `+59`).
- Everything else is neutral slate so nothing competes for attention.

Window chrome is hidden; drag the top bar to move it, the bottom-right segmented control sets
the energy trajectory (Cool / Flat / Build).
