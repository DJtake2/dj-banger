/**
 * Batch audio-energy analyzer.  npm run analyze
 *
 * Fills the energy cache by running ffmpeg over your library. Incremental + resumable:
 * re-running only analyzes what's new. Analysis is cached in ~/dj-banger/.cache/energy.json.
 *
 *   npm run analyze                 # analyze the whole library (uncached only)
 *   node src/analyzeCli.ts --limit 500        # just the first 500 uncached
 *   node src/analyzeCli.ts --crate "D-BACKS"  # only tracks in a crate
 *   node src/analyzeCli.ts --concurrency 12
 */

import { loadLibrary, loadCrates, defaultSeratoDir } from "./serato/library.ts";
import { EnergyStore } from "./analysis/energyStore.ts";
import { analyzeLibrary } from "./analysis/applyEnergy.ts";
import type { Track } from "./types.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const dir = arg("--dir") ?? defaultSeratoDir();
  const limit = arg("--limit") ? Number(arg("--limit")) : undefined;
  const concurrency = arg("--concurrency") ? Number(arg("--concurrency")) : 8;
  const crateName = arg("--crate");

  console.log("Loading library…");
  let tracks = await loadLibrary(dir);

  if (crateName) {
    const crates = await loadCrates(dir);
    const crate = crates.find((c) => c.name.toLowerCase().includes(crateName.toLowerCase()));
    if (!crate) return console.log(`No crate matching "${crateName}".`);
    const ids = new Set(crate.paths);
    tracks = tracks.filter((t: Track) => ids.has(t.id));
    console.log(`Scoped to crate "${crate.name}": ${tracks.length} tracks`);
  }

  const store = await new EnergyStore().load();
  console.log(`Cache has ${store.size} entries. Analyzing (concurrency ${concurrency})…\n`);

  const t0 = Date.now();
  let lastLine = 0;
  const res = await analyzeLibrary(tracks, store, {
    limit,
    concurrency,
    onProgress: (p) => {
      const now = Date.now();
      if (now - lastLine < 250 && p.done !== p.total) return; // throttle output
      lastLine = now;
      const pctDone = p.total ? Math.round((p.done / p.total) * 100) : 100;
      process.stdout.write(`\r  ${p.done}/${p.total} (${pctDone}%)  ${p.ok ? "✓" : "✗"} ${basename(p.path)}`.padEnd(90).slice(0, 90));
    },
  });

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n\nDone in ${secs}s`);
  console.log(`  analyzed: ${res.analyzed}`);
  console.log(`  already cached: ${res.skippedCached}`);
  console.log(`  failed: ${res.failed}`);
  console.log(`  missing files: ${res.missing}`);
  console.log(`  cache total: ${store.size}`);
  if (res.analyzed) {
    const rate = (res.analyzed / Number(secs)).toFixed(1);
    console.log(`  rate: ${rate} tracks/s`);
  }
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
