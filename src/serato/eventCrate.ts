/**
 * Event crates — tonight's plan, written straight into Serato.
 *
 *   <Event>                  every planned song, in plan order
 *   <Event> › 01 First Dance  one subcrate per section that has songs
 *   <Event> › 02 Open Dancing …
 *
 * Safety rules (Serato owns these files):
 *   • Never while Serato is running — it rewrites crates and neworder.pref when it quits, so a
 *     write made while it's open is lost or, worse, half-kept. The caller queues instead.
 *   • Back up first: every crate file about to be replaced or removed, plus neworder.pref, is
 *     copied to a timestamped folder.
 *   • Only ever touch this event's own crates: the parent and the "NN Section" subcrates this
 *     writer names. A subcrate the DJ added by hand under the same parent is left alone.
 *   • Atomic writes (temp + rename).
 */

import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { encodeCrate } from "./crateWriter.ts";
import { defaultSeratoDir } from "./library.ts";

/** A crate name Serato can store as a file name: no path or nesting separators. */
export function sanitizeCrateName(s: string, fallback = "Event"): string {
  const clean = s
    .replace(/%%/g, " ")
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return clean || fallback;
}

const SERATO_PROCESSES = ["Serato DJ Pro", "Serato DJ Lite", "Serato DJ", "Serato DJ Suite"];

/** Is Serato DJ open? (macOS process names.) */
export function isSeratoRunning(): Promise<boolean> {
  return Promise.all(
    SERATO_PROCESSES.map((name) => new Promise<boolean>((res) => execFile("pgrep", ["-x", name], (err) => res(!err)))),
  ).then((r) => r.some(Boolean));
}

export interface EventCrateSection {
  name: string;
  /** Absolute (or volume-relative) paths, in order. */
  paths: string[];
}

export interface EventCrateResult {
  parent: string;
  crates: string[];
  tracks: number;
  backupDir: string;
}

const OUR_SUB_RE = /^\d{2} /; // "01 First Dance" — the subcrates this writer names

/** neworder.pref (UTF-16 BE text, one "[crate]Name%%Sub" per line): put this event's crates at the top. */
export function updateNeworder(text: string, parent: string, crateNames: string[], keepSubs: string[]): string {
  const lines = text.split("\n");
  const ours = (l: string) => {
    if (!l.startsWith("[crate]")) return false;
    const name = l.slice(7);
    if (name === parent) return true;
    if (!name.startsWith(parent + "%%")) return false;
    const sub = name.slice(parent.length + 2);
    return OUR_SUB_RE.test(sub) && !keepSubs.includes(name);
  };
  const kept = lines.filter((l) => !ours(l));
  const begin = kept.findIndex((l) => l.trim() === "[begin record]");
  const insertAt = begin >= 0 ? begin + 1 : 0;
  kept.splice(insertAt, 0, ...crateNames.map((n) => `[crate]${n}`));
  return kept.join("\n");
}

export async function writeEventCrates(
  eventName: string,
  sections: EventCrateSection[],
  opts: { seratoDir?: string; backupRoot: string; now?: Date },
): Promise<EventCrateResult> {
  const seratoDir = opts.seratoDir ?? defaultSeratoDir();
  const dir = join(seratoDir, "Subcrates");
  await mkdir(dir, { recursive: true });
  const parent = sanitizeCrateName(eventName);

  // Every planned song once, in plan order, for the parent crate.
  const seen = new Set<string>();
  const all: string[] = [];
  for (const s of sections) for (const p of s.paths) if (!seen.has(p)) { seen.add(p); all.push(p); }

  const used = sections.filter((s) => s.paths.length);
  const subNames = used.map((s, i) => `${parent}%%${String(i + 1).padStart(2, "0")} ${sanitizeCrateName(s.name, "Section")}`);
  const crateNames = [parent, ...subNames];

  // Back up whatever we're about to replace, plus our own stale subcrates (renamed/removed sections).
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const backupDir = join(opts.backupRoot, stamp);
  await mkdir(backupDir, { recursive: true });
  const existing = (await readdir(dir)).filter((f) => f.endsWith(".crate"));
  const stale = existing.filter((f) => {
    const name = f.slice(0, -6);
    return name.startsWith(parent + "%%") && OUR_SUB_RE.test(name.slice(parent.length + 2)) && !subNames.includes(name);
  });
  const targets = crateNames.map((n) => `${n}.crate`);
  for (const f of [...targets.filter((t) => existing.includes(t)), ...stale]) await copyFile(join(dir, f), join(backupDir, f));
  const prefPath = join(seratoDir, "neworder.pref");
  const hasPref = existsSync(prefPath);
  if (hasPref) await copyFile(prefPath, join(backupDir, "neworder.pref"));

  // Write the crates.
  const write = async (name: string, paths: string[]) => {
    const tmp = join(dir, `.${name}.crate.tmp`);
    await writeFile(tmp, encodeCrate(paths));
    await rename(tmp, join(dir, `${name}.crate`));
  };
  await write(parent, all);
  for (let i = 0; i < used.length; i++) await write(subNames[i], used[i].paths);
  for (const f of stale) await unlink(join(dir, f)).catch(() => {});

  // Keep Serato's crate order: this event at the top, sections in plan order.
  if (hasPref) {
    const text = (await readFile(prefPath)).swap16().toString("utf16le");
    const keepSubs = existing
      .map((f) => f.slice(0, -6))
      .filter((n) => n.startsWith(parent + "%%") && !OUR_SUB_RE.test(n.slice(parent.length + 2)));
    const next = updateNeworder(text, parent, crateNames, keepSubs);
    const tmp = join(seratoDir, ".neworder.pref.tmp");
    await writeFile(tmp, Buffer.from(next, "utf16le").swap16());
    await rename(tmp, prefPath);
  }

  return { parent, crates: crateNames, tracks: all.length, backupDir };
}
