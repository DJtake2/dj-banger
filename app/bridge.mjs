/**
 * Bridge: runs the Phase 1–3 engine (the live loop) and exposes it to the floating-window
 * UI over HTTP + Server-Sent Events. No extra deps — Node's http only.
 *
 *   node app/bridge.mjs            # serves the UI at http://localhost:4177
 *
 * Endpoints:
 *   GET  /            → the UI (public/index.html + assets)
 *   GET  /events      → SSE stream: "state" once, then "suggestions" on every track change
 *   POST /config      → { energyDirection: "flat"|"build"|"cool" } → re-rank live
 *
 * In the packaged app this same process is launched by Tauri as a sidecar; the webview
 * connects to it exactly as the browser does during development.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { startLiveLoop } from "../src/live.ts";
import { recommend } from "../src/engine.ts";
import { keyCompatibility } from "../src/camelot.ts";
import { writeSuggestionsCrate } from "../src/serato/crateWriter.ts";
import { streamingRecommend, streamingStatus, setSpotifyCreds } from "../src/streaming/spotify.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dir, "public");
const PORT = Number(process.env.PORT || 4177);

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

// Shared, mutable engine config the loop reads on each evaluate().
const engineConfig = { limit: 10, energyDirection: "flat" };

// PER-DECK filter state. Each Serato deck has its own BPM range + clean/dirty + key selection.
const DEFAULT_DECK_FILTER = () => ({ bpm: "any", bpmMin: null, bpmMax: null, clean: "any", keys: [] });
const deckFilters = {}; // deck -> filter
function filterFor(deck) {
  if (!deckFilters[deck]) deckFilters[deck] = DEFAULT_DECK_FILTER();
  return deckFilters[deck];
}

// Effective BPM offset honouring half/double time (mirrors the display logic).
function effectiveBpmDelta(seedBpm, candBpm) {
  if (!seedBpm || !candBpm) return null;
  const variants = [candBpm, candBpm / 2, candBpm * 2];
  return Math.min(...variants.map((v) => Math.abs(v - seedBpm)));
}

/** Compatible-key groups for a seed key, as Camelot codes (for the filter breakdown). */
function compatibleKeys(key) {
  if (!key) return null;
  const n = key.camelotNumber, L = key.camelotLetter, other = L === "A" ? "B" : "A";
  const wrap = (x) => ((x - 1 + 12) % 12) + 1;
  const cam = (num, let_) => `${num}${let_}`;
  return {
    perfect: [cam(n, L), cam(n, other)],                 // same key + relative major/minor
    boost: [cam(wrap(n + 1), L), cam(wrap(n + 2), L)],   // +1, +2 (raise energy)
    drop: [cam(wrap(n - 1), L), cam(wrap(n - 2), L)],    // -1, -2 (lower energy)
    mood: [cam(wrap(n + 1), other), cam(wrap(n - 1), other)], // diagonals (mood change)
  };
}

/** Signed shortest Camelot-number shift from seed→candidate, for the "+N" pill. */
function keyShift(seedKey, candKey) {
  if (!seedKey || !candKey) return null;
  let d = ((candKey.camelotNumber - seedKey.camelotNumber) % 12 + 12) % 12;
  if (d > 6) d -= 12;
  return d;
}

/** Does a candidate pass a deck's filter (relative to that deck's seed)? */
function passesDeckFilter(t, seed, f) {
  // Clean / dirty
  if (f.clean === "clean" && /\b(dirty|explicit)\b/i.test(t.title)) return false;
  if (f.clean === "dirty" && /\bclean\b/i.test(t.title)) return false;
  // BPM
  if (f.bpm === "3" || f.bpm === "5" || f.bpm === "10") {
    const d = effectiveBpmDelta(seed?.bpm, t.bpm);
    if (d == null || d > Number(f.bpm) + 0.5) return false;
  } else if (f.bpm === "range") {
    if (t.bpm == null) return false;
    if (f.bpmMin != null && t.bpm < f.bpmMin) return false;
    if (f.bpmMax != null && t.bpm > f.bpmMax) return false;
  }
  // Compatible keys — when specific keys are selected, restrict to them.
  if (f.keys && f.keys.length) {
    if (!t.key || !f.keys.includes(t.key.camelot)) return false;
  }
  return true;
}

// ---- local settings (Spotify creds + future syncs), persisted outside git ----
const CONFIG_PATH = join(__dirname_root(), ".config.json");
function __dirname_root() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}
let appConfig = { spotify: { clientId: "", clientSecret: "" } };
async function loadConfig() {
  if (existsSync(CONFIG_PATH)) {
    try {
      appConfig = { ...appConfig, ...JSON.parse(await readFile(CONFIG_PATH, "utf8")) };
    } catch { /* ignore corrupt config */ }
  }
  applyConfig();
}
async function saveConfig() {
  await writeFile(CONFIG_PATH, JSON.stringify(appConfig, null, 2));
}
function applyConfig() {
  const sp = appConfig.spotify || {};
  if (sp.clientId && sp.clientSecret) setSpotifyCreds(sp.clientId, sp.clientSecret);
}

/** SSE clients. */
const clients = new Set();
let lastPayload = null; // most recent suggestions, replayed to new clients
let loopHandle = null;

function sse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event, data) {
  for (const res of clients) {
    try { sse(res, event, data); } catch { clients.delete(res); }
  }
}

// Reasons that just echo the side-column stats add noise — keep only the meaningful ones
// (harmonic relationship + genre), drop key-unknown / raw BPM / raw energy deltas.
function cleanReasons(reasons) {
  return (reasons || []).filter(
    (r) => !/unknown/i.test(r) && !/bpm/i.test(r) && !/^(same )?energy [+\-\d]/i.test(r) && !/^same energy$/i.test(r),
  );
}

/**
 * Tempo relationship for display. DJs mix at half/double time, so a 60 BPM seed and a 119 BPM
 * track are a match (119 ≈ 60×2) — the effective offset is −1, not +59. Returns the small
 * effective delta plus a "2×" / "½×" tag when the match is via a tempo octave.
 */
function bpmRelation(seedBpm, candBpm) {
  if (!seedBpm || !candBpm) return { delta: 0, mult: "" };
  const variants = [
    { bpm: candBpm, mult: "" },       // same octave
    { bpm: candBpm / 2, mult: "2×" }, // candidate is double-time
    { bpm: candBpm * 2, mult: "½×" }, // candidate is half-time
  ];
  let best = variants[0];
  let bestAbs = Math.abs(candBpm - seedBpm);
  for (const v of variants.slice(1)) {
    const a = Math.abs(v.bpm - seedBpm);
    if (a < bestAbs) { bestAbs = a; best = v; }
  }
  return { delta: Math.round(best.bpm - seedBpm), mult: best.mult };
}

/** Map an engine Suggestion to the compact shape the UI wants. */
function toWire(s, seed) {
  const k = s.breakdown.key;
  const keyKnown = !!(seed?.key && s.track.key);
  const band = !keyKnown
    ? "unknown"
    : k >= 0.99 ? "perfect" : k >= 0.85 ? "good" : k >= 0.68 ? "boost" : k >= 0.45 ? "ok" : "clash";
  const rel = bpmRelation(seed?.bpm, s.track.bpm);
  return {
    id: s.track.id,
    absPath: s.track.absPath,
    title: s.track.title,
    artist: s.track.artist,
    camelot: s.track.key?.camelot ?? null,
    bpm: s.track.bpm ?? null,
    bpmDelta: rel.delta,
    bpmMult: rel.mult,
    keyShift: keyShift(seed?.key, s.track.key),
    energy: s.track.energy ?? null,
    energyReal: s.track.raw?.energySource === "audio",
    score: s.score,
    match: band,
    reasons: cleanReasons(s.reasons),
  };
}

/** Compact "track head" shape for a deck's now-playing display. */
function seedInfo(seed) {
  return {
    id: seed.id,
    title: seed.title,
    artist: seed.artist,
    camelot: seed.key?.camelot ?? null,
    bpm: seed.bpm ?? null,
    energy: seed.energy ?? null,
    energyReal: seed.raw?.energySource === "audio",
  };
}

let deckSeeds = {}; // deck number -> current seed Track (for streaming + filter re-rank)

/** Compute one deck's library suggestions + its compatible-key breakdown + filter. */
function rankDeck(deck, seed) {
  const f = filterFor(deck);
  const t0 = performance.now();
  const cands = loopHandle.pool.filter((tt) => passesDeckFilter(tt, seed, f));
  const suggestions = recommend({ seed }, cands, engineConfig);
  return {
    deck,
    nowPlaying: seedInfo(seed),
    library: suggestions.map((s) => toWire(s, seed)),
    compat: compatibleKeys(seed.key),
    filter: f,
    computeMs: performance.now() - t0,
  };
}

/** Build + broadcast the full dual-deck payload from the current deck seeds. */
function broadcastDecks(source = "live") {
  if (!loopHandle) return []; // library not ready yet (initial startup event)
  const decks = Object.entries(deckSeeds)
    .map(([d, seed]) => rankDeck(Number(d), seed))
    .sort((a, b) => a.deck - b.deck);
  lastPayload = { source, decks };
  broadcast("decks", lastPayload);
  return decks;
}

/** Wire a streaming pick for the UI. Owned tracks borrow key/BPM/shift from the library. */
function streamWire(st, seed) {
  const t = st.ownedTrack;
  if (t) {
    const rel = bpmRelation(seed?.bpm, t.bpm);
    return {
      title: st.title, artist: st.artist, owned: true, id: t.id, absPath: t.absPath,
      camelot: t.key?.camelot ?? null, bpm: t.bpm ?? null, bpmMult: rel.mult,
      keyShift: keyShift(seed?.key, t.key), energy: t.energy ?? null,
    };
  }
  return { title: st.title, artist: st.artist, owned: false, spotifyUrl: st.spotifyUrl };
}

/** Per-deck streaming (Spotify) lookup → broadcast tagged with the deck. */
async function emitStreamingForDeck(deck, seed) {
  if (!seed) return;
  try {
    const raw = await streamingRecommend(seed, loopHandle.pool);
    const tracks = raw.map((st) => streamWire(st, seed));
    if (deckSeeds[deck] && deckSeeds[deck].id === seed.id) {
      broadcast("streaming", { deck, seedId: seed.id, ...streamingStatus(), tracks });
    }
  } catch (e) {
    broadcast("streaming", { deck, seedId: seed.id, connected: false, error: String(e.message || e), tracks: [] });
  }
}
function emitAllStreaming() {
  if (!loopHandle) return;
  for (const [d, seed] of Object.entries(deckSeeds)) void emitStreamingForDeck(Number(d), seed);
}

async function main() {
  await loadConfig(); // apply saved Spotify creds before anything queries streaming
  console.log("Starting engine…");
  loopHandle = await startLiveLoop({
    config: engineConfig,
    writeCrate: false,
    log: (m) => console.log("·", m),
    onEvent: (e) => {
      deckSeeds = {};
      for (const d of e.decks || []) if (d.seed) deckSeeds[d.deck] = d.seed;
      if (!Object.keys(deckSeeds).length && e.seed) deckSeeds[e.activeDeck || 1] = e.seed;
      broadcastDecks("live");
      emitAllStreaming();
    },
  });
  console.log(`Engine ready: ${loopHandle.librarySize} tracks.`);
  await loopHandle.rerun(); // emit the first decks payload now that loopHandle is set
  emitAllStreaming();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      clients.add(res);
      sse(res, "state", {
        librarySize: loopHandle.librarySize,
        energyDirection: engineConfig.energyDirection,
        streaming: streamingStatus(),
        settings: { spotify: { clientId: appConfig.spotify.clientId || "", hasSecret: !!appConfig.spotify.clientSecret } },
      });
      if (lastPayload) sse(res, "decks", lastPayload);
      req.on("close", () => clients.delete(res));
      return;
    }

    // Save settings (Spotify credentials) → persist + apply + refresh streaming.
    if (url.pathname === "/settings" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { spotify } = JSON.parse(body || "{}");
          if (spotify) {
            if (typeof spotify.clientId === "string") appConfig.spotify.clientId = spotify.clientId.trim();
            if (typeof spotify.clientSecret === "string" && spotify.clientSecret) appConfig.spotify.clientSecret = spotify.clientSecret.trim();
          }
          await saveConfig();
          applyConfig();
          emitAllStreaming();
          res.writeHead(200).end(JSON.stringify({ ok: true, streaming: streamingStatus() }));
        } catch (e) {
          res.writeHead(400).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      });
      return;
    }

    // Per-deck filter change → re-rank that deck (and refresh the whole payload).
    if (url.pathname === "/deckfilter" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const p = JSON.parse(body || "{}");
          const f = filterFor(p.deck);
          if (typeof p.bpm === "string") f.bpm = p.bpm;
          if (typeof p.clean === "string") f.clean = p.clean;
          if ("bpmMin" in p) f.bpmMin = p.bpmMin === null || p.bpmMin === "" ? null : Number(p.bpmMin);
          if ("bpmMax" in p) f.bpmMax = p.bpmMax === null || p.bpmMax === "" ? null : Number(p.bpmMax);
          if (Array.isArray(p.keys)) f.keys = p.keys;
          broadcastDecks("live");
          res.writeHead(200).end(JSON.stringify({ ok: true, filter: f }));
        } catch {
          res.writeHead(400).end('{"ok":false}');
        }
      });
      return;
    }

    // Export selected suggestions as a Serato crate (multi-select → crate).
    if (url.pathname === "/crate" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { ids, name } = JSON.parse(body || "{}");
          const wanted = new Set(ids || []);
          const tracks = loopHandle.pool.filter((t) => wanted.has(t.id));
          if (!tracks.length) return res.writeHead(400).end('{"ok":false,"error":"no tracks"}');
          const path = await writeSuggestionsCrate(tracks, { name: name || "Banger Picks" });
          res.writeHead(200).end(JSON.stringify({ ok: true, count: tracks.length, path }));
        } catch (e) {
          res.writeHead(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      });
      return;
    }

    if (url.pathname === "/config" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { energyDirection } = JSON.parse(body || "{}");
          if (["flat", "build", "cool"].includes(energyDirection)) {
            engineConfig.energyDirection = energyDirection;
            broadcastDecks("live"); // re-rank both decks with the new trajectory
          }
          res.writeHead(200).end('{"ok":true}');
        } catch {
          res.writeHead(400).end('{"ok":false}');
        }
      });
      return;
    }

    // Typeahead search over the library for the prep-mode box.
    if (url.pathname === "/search") {
      const q = (url.searchParams.get("q") || "").toLowerCase().trim();
      let matches = [];
      if (q.length >= 2) {
        const seen = new Set();
        for (const t of loopHandle.pool) {
          const hay = `${t.artist} ${t.title}`.toLowerCase();
          if (!hay.includes(q)) continue;
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          // rank: prefix hits first
          const starts = t.title.toLowerCase().startsWith(q) || t.artist.toLowerCase().startsWith(q);
          matches.push({
            id: t.id, title: t.title, artist: t.artist,
            camelot: t.key?.camelot ?? null, bpm: t.bpm ? Math.round(t.bpm) : null,
            _rank: starts ? 0 : 1,
          });
          if (matches.length > 60) break; // cap scan cost
        }
        matches.sort((a, b) => a._rank - b._rank);
        matches = matches.slice(0, 8).map(({ _rank, ...m }) => m);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ matches }));
      return;
    }

    // Manual seed / prep mode: load a track onto a deck slot (default: a "prep" deck 0).
    if (url.pathname === "/seed" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { id, query, deck } = JSON.parse(body || "{}");
          const seed = id
            ? loopHandle.pool.find((t) => t.id === id)
            : loopHandle.pool.find((t) => `${t.artist} ${t.title}`.toLowerCase().includes(String(query || "").toLowerCase()));
          if (!seed) return res.writeHead(404).end('{"ok":false}');
          const target = deck ?? 0; // deck 0 = prep slot
          deckSeeds[target] = seed;
          broadcastDecks(target === 0 ? "prep" : "live");
          void emitStreamingForDeck(target, seed);
          res.writeHead(200).end('{"ok":true}');
        } catch {
          res.writeHead(400).end('{"ok":false}');
        }
      });
      return;
    }

    // Return to live decks (drop any prep slot).
    if (url.pathname === "/live" && req.method === "POST") {
      delete deckSeeds[0];
      await loopHandle.rerun();
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }

    // static files
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    try {
      const buf = await readFile(join(PUBLIC, path));
      res.writeHead(200, { "content-type": MIME[extname(path)] || "application/octet-stream" });
      res.end(buf);
    } catch {
      res.writeHead(404).end("not found");
    }
  });

  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n  ▶ Banger is running — open ${url}\n`);
    // Auto-open the browser when launched via start.sh (never under Tauri, never fatal).
    if (process.env.BANGER_OPEN) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      try {
        spawn(opener, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
      } catch {
        /* opening the browser is best-effort */
      }
    }
  });
}

main().catch((e) => {
  console.error("bridge error:", e);
  process.exit(1);
});
