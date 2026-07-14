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
import { readFile, writeFile, mkdir, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { startLiveLoop } from "../src/live.ts";
import { recommend } from "../src/engine.ts";
import { loadArtistAffinity, EMPTY_AFFINITY } from "../src/affinity.ts";
import { parseDoNotPlay, matchDoNotPlay, isDoNotPlay } from "../src/dnp.ts";
import { keyCompatibility } from "../src/camelot.ts";
import { writeSuggestionsCrate } from "../src/serato/crateWriter.ts";
import { streamingRecommend, streamingStatus, streamingCharts, setSpotifyCreds, testSpotifyCreds, setTidalCreds, testTidalCreds, setActiveService, getActiveService } from "../src/streaming/index.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = process.env.BANGER_PUBLIC || join(__dir, "public");
const PORT = Number(process.env.PORT || 4177);

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon" };

// Shared, mutable engine config the loop reads on each evaluate().
const engineConfig = { limit: 21, energyDirection: "flat" }; // up to 21 library suggestions (matches the reference app)

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
  // Clean / dirty — STRICT: only tracks explicitly labelled as such. If a track isn't clearly
  // marked clean or dirty, it is excluded whenever one of these filters is active.
  if (f.clean === "clean" && !/\bclean\b/i.test(t.title)) return false;
  if (f.clean === "dirty" && !/\b(dirty|explicit)\b/i.test(t.title)) return false;
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
const CONFIG_PATH = process.env.BANGER_CONFIG || join(__dirname_root(), ".config.json");
function __dirname_root() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}
let appConfig = { spotify: { clientId: "", clientSecret: "" }, tidal: { clientId: "", clientSecret: "" }, streamingService: "spotify", doNotPlay: "" };
let dnpEntries = [];               // parsed Do-Not-Play list (one entry per line)
let artistAffinity = EMPTY_AFFINITY; // co-play index; rebuilt from history on startup
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
  const td = appConfig.tidal || {};
  if (td.clientId && td.clientSecret) setTidalCreds(td.clientId, td.clientSecret);
  if (appConfig.streamingService) setActiveService(appConfig.streamingService);
  dnpEntries = parseDoNotPlay(appConfig.doNotPlay);
}

// ---- album art: extract embedded cover art from local files (ffmpeg), cached to disk --------
const FFMPEG = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
const CACHE_ROOT = process.env.BANGER_CACHE ? dirname(process.env.BANGER_CACHE) : join(__dirname_root(), ".cache");
const ART_DIR = join(CACHE_ROOT, "art");
const artMisses = new Set(); // ids we've already found to have no embedded art (skip re-running ffmpeg)

/** Extract the first embedded image from `absPath` to `out` (jpeg, ~200px). Resolves true on success. */
function extractArt(absPath, out) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ["-v", "error", "-y", "-i", absPath, "-an", "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=200:-1", "-f", "image2", out], { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0 && existsSync(out)));
  });
}

/** Strip DJ-edit noise from a title so online lookups match the real release. */
function cleanTitle(t) {
  return String(t || "")
    .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, " ")            // (Clean) (Intro - Dirty) [Remix] …
    .replace(/\s*-\s*(intro|outro|clean|dirty|acap+ella|quick ?hitter|edit|transition|mixshow).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fallback: fetch official cover art from Apple's public iTunes Search API (no key). Their app
 *  pulls art from an online source too — this covers tracks whose files have no embedded art. */
async function fetchOnlineArt(track, out) {
  const artist = (track.artist || "").split(/,|&|feat\.?|ft\.?/i)[0].trim();
  const term = `${artist} ${cleanTitle(track.title)}`.trim();
  if (!term) return false;
  try {
    const r = await fetch(`https://itunes.apple.com/search?media=music&entity=song&limit=1&term=${encodeURIComponent(term)}`, { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    const url = j?.results?.[0]?.artworkUrl100;
    if (!url) return false;
    const img = await fetch(url.replace("100x100bb", "400x400bb"), { signal: AbortSignal.timeout(6000) });
    if (!img.ok) return false;
    await writeFile(out, Buffer.from(await img.arrayBuffer()));
    return existsSync(out);
  } catch { return false; }
}

/** Return a cached art file path for a library track id: embedded cover first (instant, offline),
 *  then an online lookup (like the reference app). null if neither yields art. */
async function artFor(id) {
  if (!loopHandle || artMisses.has(id)) return null;
  const track = loopHandle.pool.find((t) => t.id === id);
  if (!track) return null;
  const out = join(ART_DIR, createHash("sha1").update(id).digest("hex") + ".jpg");
  if (existsSync(out)) return out;
  await mkdir(ART_DIR, { recursive: true });
  if (track.absPath && existsSync(track.absPath) && await extractArt(track.absPath, out)) return out;
  if (await fetchOnlineArt(track, out)) return out;
  artMisses.add(id);
  return null;
}

// ---- waveform overview + structure markers (ffmpeg peaks), cached to disk -------------------
const WAVE_DIR = join(CACHE_ROOT, "wave");
const waveMem = new Map(); // id -> data, in-process cache

/** Decode `absPath` to 1 kHz mono PCM and return the raw buffer (null on failure). */
function decodePcm(absPath) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ["-v", "error", "-i", absPath, "-ac", "1", "-ar", "1000", "-f", "s16le", "-"], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks = []; let bytes = 0;
    p.stdout.on("data", (c) => { chunks.push(c); bytes += c.length; if (bytes > 6_000_000) p.kill(); }); // cap ~50 min
    p.on("error", () => resolve(null));
    p.on("close", () => resolve(chunks.length ? Buffer.concat(chunks) : null));
  });
}

/** Reduce PCM to `buckets` normalized peak values (0..1) + duration in seconds. */
function peaksFromPcm(pcm, buckets = 480) {
  const n = Math.floor(pcm.length / 2);
  const per = Math.max(1, Math.floor(n / buckets));
  const peaks = [];
  for (let b = 0; b < buckets; b++) {
    let max = 0;
    const start = b * per, end = Math.min(n, start + per);
    for (let i = start; i < end; i++) { const v = Math.abs(pcm.readInt16LE(i * 2)); if (v > max) max = v; }
    peaks.push(+(max / 32768).toFixed(3));
  }
  return { peaks, duration: +(n / 1000).toFixed(1) };
}

/** Read just the ID3v2 tag region of a file (where Serato writes its cue markers). */
async function readId3Region(absPath) {
  const fh = await open(absPath, "r");
  try {
    const head = Buffer.alloc(10);
    await fh.read(head, 0, 10, 0);
    if (head.toString("latin1", 0, 3) !== "ID3") {
      const b = Buffer.alloc(262144); const { bytesRead } = await fh.read(b, 0, b.length, 0); return b.subarray(0, bytesRead);
    }
    const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
    const total = Math.min(10 + size, 8_000_000);
    const b = Buffer.alloc(total);
    await fh.read(b, 0, total, 0);
    return b;
  } finally { await fh.close(); }
}

/** Parse the DJ's real Serato hot-cues (Serato Markers2 GEOB frame) → markers with real colors. */
function parseSeratoCues(buf, durationSec) {
  const marker = Buffer.from("Serato Markers2\0", "latin1");
  const at = buf.indexOf(marker);
  if (at < 0) return [];
  let p = at + marker.length;
  if (buf[p] === 0x01 && buf[p + 1] === 0x01) p += 2;
  let b64 = "";
  for (; p < buf.length; p++) {
    const c = buf[p];
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2f || c === 0x3d) b64 += String.fromCharCode(c);
    else if (c === 0x0a || c === 0x0d) continue;
    else break;
  }
  let data;
  try { data = Buffer.from(b64, "base64"); } catch { return []; }
  let i = 0;
  if (data[i] === 0x01 && data[i + 1] === 0x01) i += 2;
  const durMs = (durationSec || 0) * 1000;
  const cues = [];
  while (i < data.length - 5) {
    let end = i; while (end < data.length && data[end] !== 0x00) end++;
    const name = data.toString("latin1", i, end);
    if (!name) break;
    i = end + 1;
    if (i + 4 > data.length) break;
    const len = data.readUInt32BE(i); i += 4;
    const body = data.subarray(i, i + len); i += len;
    if (name === "CUE" && body.length >= 12) {
      const index = body[1], posMs = body.readUInt32BE(2), color = `#${body.subarray(7, 10).toString("hex")}`;
      cues.push({ pos: durMs ? +Math.min(1, posMs / durMs).toFixed(4) : 0, label: String(index + 1), color });
    }
  }
  return cues.sort((a, b) => a.pos - b.pos);
}
async function seratoCues(absPath, durationSec) {
  try { return parseSeratoCues(await readId3Region(absPath), durationSec); } catch { return []; }
}

/** Detect rough song structure from the energy envelope — intro / drop / outro. Works on any
 *  track (no Serato hot-cues needed). Positions are 0..1 across the track. */
function autoMarkers(peaks) {
  const N = peaks.length;
  const sm = peaks.map((_, i) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - 6); j <= Math.min(N - 1, i + 6); j++) { s += peaks[j]; c++; }
    return s / c;
  });
  const max = Math.max(...sm, 0.001), thr = max * 0.5, out = [];
  const intro = sm.findIndex((v, i) => v >= thr && (sm[i + 1] ?? 0) >= thr * 0.9);
  if (intro > 3) out.push({ pos: +(intro / N).toFixed(3), label: "IN", color: "#22c55e" });
  const win = Math.max(4, Math.round(N * 0.04));
  let bestJump = 0, dropIdx = -1;
  for (let i = win; i < N * 0.7; i++) { const j = sm[i] - sm[i - win]; if (j > bestJump) { bestJump = j; dropIdx = i; } }
  if (dropIdx > 0 && bestJump > max * 0.12) out.push({ pos: +(dropIdx / N).toFixed(3), label: "DROP", color: "#f59e0b" });
  let outro = -1;
  for (let i = N - 3; i > N * 0.6; i--) { if (sm[i] < thr && sm[i - 1] >= thr) { outro = i; break; } }
  if (outro > 0) out.push({ pos: +(outro / N).toFixed(3), label: "OUT", color: "#ef4444" });
  return out;
}

/** Waveform data for a track (peaks + duration + structure markers), cached to disk + memory. */
async function waveForTrack(track) {
  if (!track?.absPath) return null;
  if (waveMem.has(track.id)) return waveMem.get(track.id);
  const out = join(WAVE_DIR, createHash("sha1").update(track.id).digest("hex") + ".json");
  if (existsSync(out)) {
    try {
      const d = JSON.parse(await readFile(out, "utf8"));
      if (!d.cueSource && existsSync(track.absPath)) {
        // Upgrade a pre-cue cache: add real Serato cues WITHOUT re-decoding the audio.
        const cues = await seratoCues(track.absPath, d.duration);
        if (cues.length) { d.markers = cues; d.cueSource = "serato"; } else d.cueSource = "auto";
        await writeFile(out, JSON.stringify(d));
      }
      waveMem.set(track.id, d);
      return d;
    } catch {}
  }
  if (!existsSync(track.absPath)) return null;
  await mkdir(WAVE_DIR, { recursive: true });
  const pcm = await decodePcm(track.absPath);
  if (!pcm) return null;
  const { peaks, duration } = peaksFromPcm(pcm);
  const cues = await seratoCues(track.absPath, duration); // the DJ's real hot cues
  const data = { peaks, duration, markers: cues.length ? cues : autoMarkers(peaks), cueSource: cues.length ? "serato" : "auto" };
  await writeFile(out, JSON.stringify(data));
  waveMem.set(track.id, data);
  return data;
}
async function waveFor(id) {
  if (!loopHandle) return null;
  const t = loopHandle.pool.find((x) => x.id === id);
  return t ? waveForTrack(t) : null;
}

// Optional full-library pre-warm — background, resumable (waveForTrack skips cached files).
let prewarm = { running: false, done: 0, total: 0 };
async function runPrewarm() {
  if (prewarm.running || !loopHandle) return;
  const todo = loopHandle.pool.filter((t) => t.absPath);
  prewarm = { running: true, done: 0, total: todo.length };
  let idx = 0;
  const worker = async () => { while (idx < todo.length) { const t = todo[idx++]; try { await waveForTrack(t); } catch {} prewarm.done++; } };
  await Promise.all(Array.from({ length: 4 }, worker)); // 4 concurrent ffmpegs
  prewarm.running = false;
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
    // Non-null when the playing track is on the Do-Not-Play list (the matched entry).
    dnp: dnpEntries.length ? matchDoNotPlay(dnpEntries, seed) : null,
  };
}

let deckSeeds = {}; // deck number -> current seed Track (for streaming + filter re-rank)

/** Compute one deck's library suggestions + its compatible-key breakdown + filter. */
function rankDeck(deck, seed) {
  const f = filterFor(deck);
  const t0 = performance.now();
  // Never suggest a track on the Do-Not-Play list.
  const cands = loopHandle.pool.filter(
    (tt) => passesDeckFilter(tt, seed, f) && !(dnpEntries.length && isDoNotPlay(dnpEntries, tt)),
  );
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
// ---- world popularity (Deezer global rank), cached to disk ---------------------------------
const POP_CACHE_FILE = join(CACHE_ROOT, "popularity.json");
const popCache = new Map(); // "artist|title" -> Deezer rank (0 = looked-up-but-not-found)
let popDirty = false;
let popPrewarm = { running: false, done: 0, total: 0 };
const popKey = (t) => `${popNormStr(t.artist)}|${popNormStr(t.title)}`;
function popNormStr(s) { return (s || "").toLowerCase().replace(/\([^)]*\)/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
// found on Deezer → 0..1 by global rank; not found (custom edit/mashup) → neutral, don't penalize.
const popNorm = (rank) => (rank > 0 ? Math.min(1, rank / 900000) : 0.5);

async function loadPopCache() {
  try { const j = JSON.parse(await readFile(POP_CACHE_FILE, "utf8")); for (const [k, v] of Object.entries(j)) popCache.set(k, v); } catch {}
}
async function savePopCache() { if (!popDirty) return; popDirty = false; try { await mkdir(CACHE_ROOT, { recursive: true }); await writeFile(POP_CACHE_FILE, JSON.stringify(Object.fromEntries(popCache))); } catch {} }

/** Deezer global rank for a track. Returns rank (≥0) or -1 on fetch failure (don't cache -1). */
async function deezerRank(artist, title) {
  const a = (artist || "").split(/,|&|feat\.?|ft\.?/i)[0].trim();
  const t = (title || "").replace(/\([^)]*\)/g, "").replace(/\s*-\s*.*$/, "").trim() || title || "";
  if (!a && !t) return 0;
  try {
    const r = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(`artist:"${a}" track:"${t}"`)}&limit=1`, { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    if (d?.error) return -1; // rate-limited / quota — try again later, don't poison the cache
    return d?.data?.[0]?.rank ?? 0;
  } catch { return -1; }
}

function applyCachedPop(t) { const r = popCache.get(popKey(t)); if (r !== undefined) t.popularity = popNorm(r); }
function applyPopToPool() { if (loopHandle) for (const t of loopHandle.pool) applyCachedPop(t); }

/** Fetch + cache popularity for uncached tracks (concurrency-limited). Returns true if anything changed. */
async function fillPop(tracks, conc = 4) {
  const todo = tracks.filter((t) => t && !popCache.has(popKey(t)));
  if (!todo.length) return false;
  let idx = 0, changed = false;
  const worker = async () => {
    while (idx < todo.length) {
      const t = todo[idx++];
      const rank = await deezerRank(t.artist, t.title);
      if (rank >= 0) { popCache.set(popKey(t), rank); popDirty = true; applyCachedPop(t); changed = true; }
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  if (changed) await savePopCache();
  return changed;
}

/** After a broadcast, lazily fetch popularity for the shown library picks, then re-rank once. */
async function fillPopForDecks(decks, source) {
  const ids = new Set();
  for (const dk of decks) for (const s of dk.library || []) if (s.id) ids.add(s.id);
  const tracks = [...ids].map((id) => loopHandle.pool.find((t) => t.id === id)).filter(Boolean);
  if (await fillPop(tracks)) broadcastDecks(source, true); // re-rank with popularity; no further fill
}

function broadcastDecks(source = "live", skipPopFill = false) {
  if (!loopHandle) return []; // library not ready yet (initial startup event)
  const decks = Object.entries(deckSeeds)
    .map(([d, seed]) => rankDeck(Number(d), seed))
    .sort((a, b) => a.deck - b.deck);
  lastPayload = { source, decks };
  broadcast("decks", lastPayload);
  if (!skipPopFill) void fillPopForDecks(decks, source); // fill world popularity, then re-rank
  return decks;
}

/** Optional full-library popularity pre-warm — background, resumable (skips cached), gentle on Deezer. */
async function runPopPrewarm() {
  if (popPrewarm.running || !loopHandle) return;
  const todo = loopHandle.pool.filter((t) => !popCache.has(popKey(t)));
  popPrewarm = { running: true, done: 0, total: todo.length };
  let idx = 0;
  const worker = async () => {
    while (idx < todo.length) {
      const t = todo[idx++];
      const rank = await deezerRank(t.artist, t.title);
      if (rank >= 0) { popCache.set(popKey(t), rank); popDirty = true; applyCachedPop(t); }
      popPrewarm.done++;
      if (popPrewarm.done % 200 === 0) await savePopCache();
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker)); // gentle — Deezer rate-limits
  await savePopCache();
  popPrewarm.running = false;
  broadcastDecks("live", true); // re-rank the whole pool with fresh popularity
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
      image: st.image ?? null, // Spotify cover; owned rows can also fall back to local art via id
    };
  }
  return { title: st.title, artist: st.artist, owned: false, spotifyUrl: st.url || st.spotifyUrl, image: st.image ?? null };
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

  // Build the artist co-play index from play history, then wire it into the scorer so
  // suggestions favor artists this DJ actually mixes together. Non-fatal if history is absent.
  try {
    const t = performance.now();
    artistAffinity = await loadArtistAffinity(loopHandle.pool);
    engineConfig.artistAffinity = (a, b) => artistAffinity.score(a, b);
    console.log(`Artist affinity: ${artistAffinity.size} artists (${Math.round(performance.now() - t)}ms)`);
    await loopHandle.rerun(); // re-rank now that affinity is live
  } catch (e) {
    console.log("Artist affinity unavailable:", e?.message || e);
    await loopHandle.rerun();
  }

  // World popularity: load the cached Deezer ranks and apply to the pool (on-demand fill + an
  // optional full pre-warm build the cache further).
  await loadPopCache();
  applyPopToPool();
  console.log(`World popularity: ${popCache.size} tracks cached.`);

  emitAllStreaming();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // CORS: the packaged app's window is served from tauri://localhost and talks to this
    // sidecar cross-origin, so allow it (and answer preflight requests).
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

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
        settings: {
          spotify: { clientId: appConfig.spotify.clientId || "", hasSecret: !!appConfig.spotify.clientSecret },
          tidal: { clientId: appConfig.tidal.clientId || "", hasSecret: !!appConfig.tidal.clientSecret },
          streamingService: getActiveService(),
          doNotPlay: appConfig.doNotPlay || "",
        },
      });
      if (lastPayload) sse(res, "decks", lastPayload);
      req.on("close", () => clients.delete(res));
      return;
    }

    // Album art for a library track (embedded cover, extracted + cached). 404 → UI shows icon.
    if (url.pathname === "/art" && req.method === "GET") {
      try {
        const id = url.searchParams.get("id") || "";
        const file = await artFor(id);
        if (!file) { res.writeHead(404).end(); return; }
        const buf = await readFile(file);
        res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "max-age=86400" }).end(buf);
      } catch { res.writeHead(404).end(); }
      return;
    }

    // Waveform + structure markers for a track (generated on-demand, cached).
    if (url.pathname === "/wave" && req.method === "GET") {
      try {
        const w = await waveFor(url.searchParams.get("id") || "");
        if (!w) { res.writeHead(404).end(); return; }
        res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=86400" }).end(JSON.stringify(w));
      } catch { res.writeHead(404).end(); }
      return;
    }
    // Full-library waveform pre-warm: POST starts it, GET reports progress.
    if (url.pathname === "/wave/prewarm") {
      if (req.method === "POST") { void runPrewarm(); }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(prewarm));
      return;
    }
    // Full-library world-popularity pre-warm (Deezer): POST starts it, GET reports progress.
    if (url.pathname === "/pop/prewarm") {
      if (req.method === "POST") { void runPopPrewarm(); }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(popPrewarm));
      return;
    }

    // Test Spotify credentials without saving.
    if (url.pathname === "/spotify/test" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { clientId, clientSecret } = JSON.parse(body || "{}");
          const r = await testSpotifyCreds(clientId, clientSecret);
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(r));
        } catch (e) {
          res.writeHead(400).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      });
      return;
    }
    // Test TIDAL credentials without saving.
    if (url.pathname === "/tidal/test" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { clientId, clientSecret } = JSON.parse(body || "{}");
          const r = await testTidalCreds(clientId, clientSecret);
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(r));
        } catch (e) {
          res.writeHead(400).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      });
      return;
    }

    // Save settings (Spotify credentials) → persist + apply + refresh streaming.
    if (url.pathname === "/settings" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { spotify, tidal, streamingService, doNotPlay } = JSON.parse(body || "{}");
          if (spotify) {
            if (typeof spotify.clientId === "string") appConfig.spotify.clientId = spotify.clientId.trim();
            if (typeof spotify.clientSecret === "string" && spotify.clientSecret) appConfig.spotify.clientSecret = spotify.clientSecret.trim();
          }
          if (tidal) {
            if (typeof tidal.clientId === "string") appConfig.tidal.clientId = tidal.clientId.trim();
            if (typeof tidal.clientSecret === "string" && tidal.clientSecret) appConfig.tidal.clientSecret = tidal.clientSecret.trim();
          }
          const svcChanged = typeof streamingService === "string" && streamingService !== appConfig.streamingService;
          if (svcChanged) appConfig.streamingService = streamingService;
          const dnpChanged = typeof doNotPlay === "string" && doNotPlay !== appConfig.doNotPlay;
          if (dnpChanged) appConfig.doNotPlay = doNotPlay;
          await saveConfig();
          applyConfig();
          emitAllStreaming(); // re-query the (possibly new) active service for every deck
          // Re-rank so newly do-not-played tracks drop out of suggestions immediately.
          if (dnpChanged && loopHandle) broadcastDecks("live");
          res.writeHead(200).end(JSON.stringify({ ok: true, service: getActiveService(), streaming: streamingStatus() }));
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

    // Charts (Spotify Top 50 / Viral) — needs Spotify connected.
    if (url.pathname === "/charts") {
      try {
        const charts = await streamingCharts(loopHandle.pool);
        const wired = charts.map((c) => ({ name: c.name, tracks: c.tracks.map((st) => streamWire(st, null)) }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...streamingStatus(), charts: wired }));
      } catch (e) {
        res.writeHead(200).end(JSON.stringify({ connected: false, charts: [], error: String(e.message || e) }));
      }
      return;
    }

    // Extensive search across the WHOLE library. Token-based: every word in the query must
    // appear somewhere in "artist title" (order-independent), so it pulls in anything related
    // rather than only exact phrases. Ranks phrase/prefix hits first.
    if (url.pathname === "/search") {
      const q = (url.searchParams.get("q") || "").toLowerCase().trim();
      let matches = [];
      if (q.length >= 2) {
        const tokens = q.split(/\s+/).filter(Boolean);
        for (const t of loopHandle.pool) {
          const hay = `${t.artist} ${t.title}`.toLowerCase();
          if (!tokens.every((tok) => hay.includes(tok))) continue; // all words present, any order
          // rank: exact phrase > title/artist prefix > all-words-anywhere
          let rank = 2;
          if (hay.includes(q)) rank = 1;
          if (t.title.toLowerCase().startsWith(q) || t.artist.toLowerCase().startsWith(q)) rank = 0;
          matches.push({
            id: t.id, title: t.title, artist: t.artist,
            camelot: t.key?.camelot ?? null, bpm: t.bpm ? Math.round(t.bpm) : null,
            _rank: rank,
          });
          if (matches.length > 400) break; // scan cap (keeps it fast on 70k)
        }
        matches.sort((a, b) => a._rank - b._rank);
        matches = matches.slice(0, 30).map(({ _rank, ...m }) => m);
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
