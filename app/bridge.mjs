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
import { readFile } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { startLiveLoop } from "../src/live.ts";
import { recommend } from "../src/engine.ts";
import { writeSuggestionsCrate } from "../src/serato/crateWriter.ts";
import { streamingRecommend, streamingStatus } from "../src/streaming/spotify.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dir, "public");
const PORT = Number(process.env.PORT || 4177);

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

// Shared, mutable engine config the loop reads on each evaluate().
const engineConfig = { limit: 10, energyDirection: "flat" };

// Filter state (energy band + genre), applied to candidates before ranking.
const filterState = { energy: "any", genre: "any" };
function passesFilter(t) {
  if (filterState.energy !== "any") {
    const e = t.energy ?? 5;
    if (filterState.energy === "chill" && e > 4) return false;
    if (filterState.energy === "mid" && (e < 5 || e > 6)) return false;
    if (filterState.energy === "hot" && e < 7) return false;
  }
  if (filterState.genre !== "any") {
    if (!t.genre || !t.genre.toLowerCase().includes(filterState.genre.toLowerCase())) return false;
  }
  return true;
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
  // If either track has no key we can't judge harmony → "unknown" (neutral), not a clash.
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
    energy: s.track.energy ?? null,
    energyReal: s.track.raw?.energySource === "audio",
    score: s.score,
    match: band,
    reasons: cleanReasons(s.reasons),
  };
}

/** Build a suggestions payload for an arbitrary seed track (now-playing OR manual prep). */
function buildPayload(seed, suggestions, computeMs, source = "live") {
  return {
    source, // "live" (Serato now-playing) | "prep" (manual seed)
    computeMs,
    nowPlaying: {
      id: seed.id,
      title: seed.title,
      artist: seed.artist,
      camelot: seed.key?.camelot ?? null,
      bpm: seed.bpm ?? null,
      energy: seed.energy ?? null,
      energyReal: seed.raw?.energySource === "audio",
    },
    list: suggestions.map((s) => toWire(s, seed)),
  };
}

let currentSeed = null; // last seed (live or prep), for streaming lookups

/** Fire off a streaming (Spotify) lookup for a seed and broadcast when it returns. */
async function emitStreaming(seed) {
  if (!seed) return;
  try {
    const tracks = await streamingRecommend(seed, loopHandle.pool);
    // only broadcast if this is still the current seed (avoid stale results)
    if (currentSeed && currentSeed.id === seed.id) {
      broadcast("streaming", { seedId: seed.id, ...streamingStatus(), tracks });
    }
  } catch (e) {
    broadcast("streaming", { seedId: seed.id, connected: false, error: String(e.message || e), tracks: [] });
  }
}

/** Top genres in the library, for the filter dropdown. */
function topGenres(pool, n = 14) {
  const counts = new Map();
  for (const t of pool) {
    if (!t.genre) continue;
    const g = t.genre.trim();
    if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([g]) => g);
}

async function main() {
  console.log("Starting engine…");
  loopHandle = await startLiveLoop({
    config: engineConfig,
    writeCrate: false, // the floating window is the UI; crate write is opt-in elsewhere
    candidateFilter: passesFilter,
    log: (m) => console.log("·", m),
    onEvent: (e) => {
      const seed = e.seed ?? {
        id: e.nowPlaying.id, title: e.nowPlaying.title, artist: e.nowPlaying.artist,
      };
      currentSeed = seed;
      lastPayload = buildPayload(seed, e.suggestions, e.computeMs, "live");
      broadcast("suggestions", lastPayload);
      void emitStreaming(seed);
    },
  });
  console.log(`Engine ready: ${loopHandle.librarySize} tracks.`);
  const genres = topGenres(loopHandle.pool);

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
        genres,
        filter: filterState,
        energyDirection: engineConfig.energyDirection,
        streaming: streamingStatus(),
      });
      if (lastPayload) sse(res, "suggestions", lastPayload);
      req.on("close", () => clients.delete(res));
      return;
    }

    // Energy / genre filter change → re-rank the current seed.
    if (url.pathname === "/filter" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { energy, genre } = JSON.parse(body || "{}");
          if (typeof energy === "string") filterState.energy = energy;
          if (typeof genre === "string") filterState.genre = genre;
          await loopHandle.rerun();
          res.writeHead(200).end(JSON.stringify({ ok: true, filter: filterState }));
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
            await loopHandle.rerun(); // recompute current track with the new trajectory
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

    // Manual seed / prep mode: rank against a library track by exact id or substring query.
    if (url.pathname === "/seed" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { id, query } = JSON.parse(body || "{}");
          const seed = id
            ? loopHandle.pool.find((t) => t.id === id)
            : loopHandle.pool.find((t) => `${t.artist} ${t.title}`.toLowerCase().includes(String(query || "").toLowerCase()));
          if (!seed) return res.writeHead(404).end('{"ok":false}');
          currentSeed = seed;
          const t0 = performance.now();
          const cands = loopHandle.pool.filter(passesFilter);
          const suggestions = recommend({ seed }, cands, engineConfig);
          lastPayload = buildPayload(seed, suggestions, performance.now() - t0, "prep");
          broadcast("suggestions", lastPayload);
          void emitStreaming(seed);
          res.writeHead(200).end('{"ok":true}');
        } catch {
          res.writeHead(400).end('{"ok":false}');
        }
      });
      return;
    }

    // Return to live now-playing (leave prep mode).
    if (url.pathname === "/live" && req.method === "POST") {
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
