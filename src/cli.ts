/**
 * Demo CLI. Two modes:
 *   node src/cli.ts --scan            → data-quality report on your real Serato library
 *   node src/cli.ts [--seed "text"]   → pick a seed track and print next-track suggestions
 *
 * Read-only. Never writes to the Serato library.
 */

import { loadLibrary, loadCrates, defaultSeratoDir } from "./serato/library.ts";
import { getNowPlaying } from "./serato/history.ts";
import { recommend } from "./engine.ts";
import { EnergyStore } from "./analysis/energyStore.ts";
import { applyCachedEnergy } from "./analysis/applyEnergy.ts";
import type { Track } from "./types.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

function pct(n: number, d: number): string {
  return d ? `${Math.round((n / d) * 100)}%` : "0%";
}

async function main() {
  const dir = arg("--dir") ?? defaultSeratoDir();
  console.log(`Serato dir: ${dir}\n`);
  const t0 = Date.now();
  const lib = await loadLibrary(dir);
  const ms = Date.now() - t0;
  console.log(`Loaded ${lib.length} tracks in ${ms}ms\n`);

  // Upgrade with real audio energy where cached.
  const upgraded = applyCachedEnergy(lib, await new EnergyStore().load());
  if (upgraded) console.log(`Real audio energy applied to ${upgraded} tracks\n`);

  if (has("--scan")) {
    return scan(lib, dir);
  }

  // Pick a seed: --nowplaying (read Serato History), --seed substring, else first keyed track.
  const seedQ = arg("--seed");
  let seed: Track | undefined;
  if (has("--nowplaying")) {
    const np = await getNowPlaying(dir);
    if (!np) return console.log("Nothing in Serato History yet — play a track first.");
    const byId = new Map(lib.map((t) => [t.id, t]));
    seed = byId.get(np.id);
    if (!seed) return console.log(`Now playing "${np.title ?? np.id}" isn't in the parsed library.`);
    console.log(`(from Serato History: ${np.sessionFile.split("/").pop()})`);
  } else if (seedQ) {
    const q = seedQ.toLowerCase();
    seed = lib.find((t) => `${t.artist} ${t.title}`.toLowerCase().includes(q));
    if (!seed) return console.log(`No track matched "${seedQ}".`);
  } else {
    seed = lib.find((t) => t.key && t.bpm) ?? lib[0];
  }

  console.log("SEED:");
  printTrack(seed);
  console.log("\nNEXT UP:");
  const suggestions = recommend({ seed }, lib, { limit: 10 });
  suggestions.forEach((s, i) => {
    console.log(
      `${String(i + 1).padStart(2)}. [${s.score.toFixed(3)}] ${label(s.track)}`,
    );
    console.log(`      ${s.reasons.join(" · ")}`);
  });
}

function label(t: Track): string {
  const k = t.key?.camelot ?? "?";
  const b = t.bpm ? `${t.bpm}bpm` : "?bpm";
  const e = t.energy != null ? `E${t.energy}` : "E?";
  return `${t.artist ? t.artist + " – " : ""}${t.title}  (${k} · ${b} · ${e})`;
}

function printTrack(t: Track) {
  console.log("  " + label(t));
  console.log(`  genre: ${t.genre ?? "—"}  |  ${t.absPath}`);
}

async function scan(lib: Track[], dir: string) {
  const n = lib.length;
  const withKey = lib.filter((t) => t.key).length;
  const withBpm = lib.filter((t) => t.bpm).length;
  const taggedEnergy = lib.filter((t) => t.raw?.energySource && !String(t.raw.energySource).startsWith("proxy")).length;
  const withGenre = lib.filter((t) => t.genre).length;

  console.log("=== LIBRARY DATA QUALITY ===");
  console.log(`Tracks:          ${n}`);
  console.log(`Has key:         ${withKey} (${pct(withKey, n)})`);
  console.log(`Has BPM:         ${withBpm} (${pct(withBpm, n)})`);
  console.log(`Tagged energy:   ${taggedEnergy} (${pct(taggedEnergy, n)})  ← rest is proxy-estimated`);
  console.log(`Has genre:       ${withGenre} (${pct(withGenre, n)})`);

  // Key format sample: show what raw key strings look like.
  const rawKeys = new Map<string, number>();
  for (const t of lib) {
    const rk = t.raw?.rawKey ? String(t.raw.rawKey) : "";
    if (rk) rawKeys.set(rk, (rawKeys.get(rk) ?? 0) + 1);
  }
  const topKeys = [...rawKeys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log(`\nRaw key formats seen (top): ${topKeys.map(([k, c]) => `${k}×${c}`).join(", ") || "none"}`);

  // A couple of example comments to see if energy is hiding in there.
  const sampleComments = lib.filter((t) => t.raw?.comment).slice(0, 5).map((t) => t.raw!.comment);
  if (sampleComments.length) {
    console.log(`\nSample comments (energy may live here):`);
    sampleComments.forEach((c) => console.log(`  • ${c}`));
  }

  const crates = await loadCrates(dir);
  console.log(`\nCrates: ${crates.length}`);
  crates.slice(0, 8).forEach((c) => console.log(`  • ${c.name} (${c.paths.length})`));
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
