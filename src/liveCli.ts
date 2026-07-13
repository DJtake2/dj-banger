/**
 * Live loop runner.  npm run live
 *
 * Watches Serato, prints next-track suggestions on every track change, and (unless
 * --no-crate) publishes a "Banger Suggestions" crate. Ctrl-C to stop.
 *
 *   node src/liveCli.ts                 # flat energy, writes crate
 *   node src/liveCli.ts --build         # build energy across the set
 *   node src/liveCli.ts --no-crate      # console only, never write to Serato
 *   node src/liveCli.ts --once          # evaluate current track once and exit
 */

import { startLiveLoop } from "./live.ts";
import type { LiveEvent } from "./live.ts";
import type { Track, EngineConfig } from "./types.ts";

const argv = process.argv;
const has = (f: string) => argv.includes(f);

const config: Partial<EngineConfig> = {
  limit: 8,
  energyDirection: has("--build") ? "build" : has("--cool") ? "cool" : "flat",
};

function label(t: Track): string {
  const k = t.key?.camelot ?? "?";
  const b = t.bpm ? `${Math.round(t.bpm)}` : "?";
  const e = t.energy != null ? `E${t.energy}` : "E?";
  return `${t.artist ? t.artist + " – " : ""}${t.title}  [${k} · ${b}bpm · ${e}]`;
}

function render(e: LiveEvent) {
  const np = e.nowPlaying;
  const seedLabel = e.seed ? label(e.seed) : `${np.artist ? np.artist + " – " : ""}${np.title ?? np.id}`;
  console.log("\n" + "━".repeat(72));
  console.log(`▶ NOW PLAYING  ${seedLabel}`);
  if (!e.seed) console.log("  (not found in library — suggestions may be limited)");
  console.log(`  suggestions in ${e.computeMs.toFixed(1)}ms${e.cratePath ? "  ·  crate updated" : ""}`);
  console.log("─".repeat(72));
  e.suggestions.forEach((s, i) => {
    console.log(`${String(i + 1).padStart(2)}. [${s.score.toFixed(3)}] ${label(s.track)}`);
    console.log(`      ${s.reasons.join(" · ")}`);
  });
}

async function main() {
  console.log("dj-banger live loop — watching Serato History. Ctrl-C to stop.\n");
  const handle = await startLiveLoop({
    config,
    writeCrate: !has("--no-crate"),
    onEvent: render,
    log: (m) => console.log(`· ${m}`),
  });

  console.log(
    `\nReady. ${handle.librarySize} tracks · engine ${handle.warmupMs.toFixed(1)}ms/pass · ` +
      `energy=${config.energyDirection}${has("--no-crate") ? " · crate disabled" : ""}`,
  );

  if (has("--once")) {
    handle.stop();
    return;
  }
  // Keep the process alive.
  process.on("SIGINT", () => {
    console.log("\nStopping.");
    handle.stop();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
