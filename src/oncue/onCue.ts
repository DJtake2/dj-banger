/**
 * On Cue — the client's plan beside the decks.
 *
 * Pulls tonight's music plan from the CRM (DJ Take2 CRM → /api/oncue, key-gated), watches what
 * Serato loads and plays, and keeps three things true:
 *   • must-plays tick themselves off when they PLAY (Serato's played flag, not a mere load),
 *     including ones that went out before On Cue was opened (tonight's history is replayed);
 *   • a do-not-play LOADED on a deck raises an alert before it goes out;
 *   • the CRM hears about it — the played song is stamped on the plan, and the iPhone's
 *     Live Activity shows the track (and the alert) on the lock screen.
 *
 * The plan is cached on disk, so a venue with no signal still has last night's copy.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeckState, NowPlaying } from "../serato/history.ts";
import { readRecentEntries } from "../serato/history.ts";
import { findAllSongs, findSong, matchNote, noteFragments, type MatchHow } from "./match.ts";

export interface OnCueEvent {
  id: string;
  name: string;
  date: string;
  venue: string | null;
  startTime: string | null;
  endTime: string | null;
  hasPlan: boolean;
  today: boolean;
}

export interface PlanSong {
  id: string;
  title: string;
  artist: string;
  isrc: string | null;
  mustPlay: boolean;
  flagged: boolean;
  notes: string | null;
  addedBy: string | null;
  path: string | null;
  playedAt: string | null;
}

export interface PlanSection {
  id: string;
  name: string;
  group: string;
  time: string | null;
  at: string | null;
  doNotPlay: boolean;
  notes: string | null;
  description: string | null;
  songs: PlanSong[];
  answers: { question: string; answer: string }[];
}

export interface Plan {
  generatedAt: string;
  event: OnCueEvent & { arrival: string | null; djNotes: string | null };
  libraryDir: string | null;
  sections: PlanSection[];
  doNotPlay: { songs: (PlanSong & { sectionId: string })[]; notes: string[] };
}

export interface OnCueSettings {
  crmUrl: string;
  key: string;
  eventId: string;
}

export interface DeckMatch {
  deck: number;
  title: string;
  artist: string;
  absPath: string;
  /** True once it has really gone out (see confirmedPlay); false while it may only be loaded. */
  played: boolean;
  /** The plan song it is, if any. */
  songId: string | null;
  sectionId: string | null;
  how: MatchHow | "note" | null;
  /** Set when it's on the do-not-play list: the entry it matched. */
  dnp: string | null;
  mustPlay: boolean;
  startTime: number | null;
}

export interface OnCueSnapshot {
  configured: boolean;
  crmUrl: string;
  hasKey: boolean;
  events: OnCueEvent[];
  eventId: string | null;
  plan: Plan | null;
  /** Plan came from the disk cache (CRM unreachable). */
  offline: boolean;
  planAge: string | null;
  error: string | null;
  decks: DeckMatch[];
  /** songId → ISO time it was played tonight (or earlier, per the CRM). */
  played: Record<string, string>;
  /** The do-not-play that's loaded right now, if any — the red banner. */
  alert: DeckMatch | null;
  mustPlay: { total: number; played: number };
}

type Fetch = typeof fetch;

export interface OnCueOptions {
  cacheDir: string;
  seratoDir?: string;
  onChange: (s: OnCueSnapshot) => void;
  log?: (m: string) => void;
  fetch?: Fetch;
  now?: () => Date;
}

/**
 * How often the plan is re-read from the CRM: every 5 minutes on event day only. Any other day
 * Banger may sit open for a week — polling would keep the CRM's database (Neon, billed by compute
 * time) awake around the clock — so then it's a local check every 30 minutes that only calls the
 * CRM once a new day starts (to pick up that day's event). ↻ in the panel still reloads any time.
 */
const PLAN_REFRESH_MS = 5 * 60 * 1000;
const IDLE_CHECK_MS = 30 * 60 * 1000;
/** How often tonight's history is re-read (Serato rewrites older entries' played flags in place). */
const TICK_MS = 15 * 1000;
/**
 * When does a track count as played? Serato 3 writes the entry the moment a track is LOADED and
 * marks it played=1 right away; only later — when it leaves the deck without really playing —
 * does it rewrite the flag to 0. So "played" means: still flagged played AND either it finished
 * after at least MIN_PLAY_SEC on the deck, or it has been on the deck for ON_AIR_SEC already
 * (both a minute: the real set showed a 41-second load-and-swap still flagged played).
 */
const MIN_PLAY_SEC = 60; // same bar as on air: Serato can leave a 41s load-and-swap flagged played for minutes
const ON_AIR_SEC = 60;

export function confirmedPlay(e: Pick<NowPlaying, "played" | "startTime" | "endTime">, nowSec: number): boolean {
  if (e.played === false || !e.startTime) return false;
  if (e.endTime) return e.endTime - e.startTime >= MIN_PLAY_SEC;
  return nowSec - e.startTime >= ON_AIR_SEC;
}

/** "2026-10-17" in the Mac's own time zone. */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class OnCue {
  private settings: OnCueSettings;
  private events: OnCueEvent[] = [];
  private plan: Plan | null = null;
  private offline = false;
  private error: string | null = null;
  private decks: DeckMatch[] = [];
  /** songId → when played: the merge of what the CRM knew, tonight's history and the DJ's ticks. */
  private played = new Map<string, string>();
  private crmPlayed = new Map<string, string>();
  private autoPlayed = new Map<string, string>();
  private manualOn = new Map<string, string>();
  /** Songs the DJ un-ticked by hand — tonight's history doesn't re-tick them. */
  private manualOff = new Set<string>();
  private reported = new Set<string>(); // songIds the CRM has stamped as played
  private tonight: NowPlaying[] = [];
  /** The Mac-local day the event list was last fetched — a new day fetches it again. */
  private eventsDay = "";
  private tickTimer: NodeJS.Timeout | null = null;
  private lastReportKey = "";
  private refreshTimer: NodeJS.Timeout | null = null;
  private lastDeckState: DeckState | null = null;

  private opts: OnCueOptions;

  constructor(settings: Partial<OnCueSettings>, opts: OnCueOptions) {
    this.opts = opts;
    this.settings = { crmUrl: "", key: "", eventId: "", ...settings };
  }

  private get fetch(): Fetch {
    return this.opts.fetch ?? fetch;
  }
  private now() {
    return this.opts.now ? this.opts.now() : new Date();
  }
  private log(m: string) {
    this.opts.log?.(`[on cue] ${m}`);
  }

  get configured() {
    return !!(this.settings.crmUrl && this.settings.key);
  }

  // ---- settings + CRM ----------------------------------------------------------------

  async configure(next: Partial<OnCueSettings>): Promise<void> {
    const changedConn =
      (next.crmUrl !== undefined && next.crmUrl !== this.settings.crmUrl) || (next.key !== undefined && next.key !== this.settings.key);
    this.settings = { ...this.settings, ...next };
    this.settings.crmUrl = this.settings.crmUrl.trim().replace(/\/+$/, "");
    if (changedConn) {
      this.error = null;
      await this.loadEvents();
    }
  }

  getSettings(): OnCueSettings {
    return { ...this.settings };
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.configured) throw new Error("Add your CRM address and On Cue key in Settings.");
    const res = await this.fetch(`${this.settings.crmUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.settings.key}`, "content-type": "application/json", ...(init?.headers || {}) },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) throw new Error("The CRM didn't accept the On Cue key — copy it again from Settings → Music Planner.");
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(body?.error || `CRM answered ${res.status}`);
    return body;
  }

  private cacheFile(name: string) {
    return join(this.opts.cacheDir, "oncue", name);
  }
  private async writeCache(name: string, data: unknown) {
    try {
      await mkdir(join(this.opts.cacheDir, "oncue"), { recursive: true });
      await writeFile(this.cacheFile(name), JSON.stringify(data));
    } catch { /* cache is best-effort */ }
  }
  private async readCache<T>(name: string): Promise<T | null> {
    try { return JSON.parse(await readFile(this.cacheFile(name), "utf8")) as T; } catch { return null; }
  }

  /** The booked events; picks today's on its own when nothing is chosen yet. */
  async loadEvents(): Promise<void> {
    this.eventsDay = localDay(this.now());
    try {
      const { events } = await this.api<{ events: OnCueEvent[] }>("/api/oncue/events");
      this.events = events;
      this.error = null;
      await this.writeCache("events.json", events);
    } catch (e) {
      this.error = (e as Error).message;
      this.events = (await this.readCache<OnCueEvent[]>("events.json")) ?? this.events;
    }
    // A remembered event that isn't in the list any more (another CRM, cancelled, long past)
    // is dropped — otherwise the picker shows the first event as chosen while On Cue still
    // follows the old one, and choosing that first event does nothing.
    const keep = !!this.settings.eventId && this.events.some((e) => e.id === this.settings.eventId);
    if (!keep && this.settings.eventId && this.events.length) {
      this.settings.eventId = "";
      this.plan = null;
    }
    // Tonight's gig first; otherwise the next one that has a plan.
    const todays = this.events.find((e) => e.today && e.hasPlan);
    const next = this.events.find((e) => e.hasPlan && e.date >= localDay(this.now()));
    if (todays && this.settings.eventId !== todays.id) await this.select(todays.id);
    else if (this.settings.eventId) await this.refreshPlan();
    else if (next) await this.select(next.id);
    else {
      this.emit();
      this.scheduleRefresh();
    }
  }

  async select(eventId: string): Promise<void> {
    if (eventId !== this.settings.eventId) {
      this.settings.eventId = eventId;
      this.plan = null;
      this.played.clear();
      this.crmPlayed.clear();
      this.autoPlayed.clear();
      this.manualOn.clear();
      this.manualOff.clear();
      this.reported.clear();
      this.lastReportKey = "";
    }
    await this.refreshPlan();
  }

  async refreshPlan(): Promise<void> {
    const id = this.settings.eventId;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (!id) return this.emit();
    try {
      this.plan = await this.api<Plan>(`/api/oncue/events/${encodeURIComponent(id)}`);
      this.offline = false;
      this.error = null;
      await this.writeCache(`plan-${id}.json`, this.plan);
    } catch (e) {
      this.error = (e as Error).message;
      const cached = await this.readCache<Plan>(`plan-${id}.json`);
      if (cached && (!this.plan || this.plan.event.id !== id)) this.plan = cached;
      this.offline = !!this.plan;
    }
    if (this.plan) {
      this.crmPlayed.clear();
      for (const s of this.allSongs()) if (s.playedAt) {
        this.crmPlayed.set(s.id, s.playedAt);
        this.reported.add(s.id);
      }
    }
    this.scheduleRefresh();
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => { if (this.plan) void this.update(); }, TICK_MS);
      this.tickTimer.unref?.();
    }
    await this.update();
  }

  /** The wait before the next CRM read (see PLAN_REFRESH_MS). */
  get refreshDelayMs(): number {
    return this.isEventNight() ? PLAN_REFRESH_MS : IDLE_CHECK_MS;
  }

  private scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (!this.configured) return;
    this.refreshTimer = setTimeout(() => void this.wake(), this.refreshDelayMs);
    this.refreshTimer.unref?.();
  }

  /** Timer fired: a new day re-reads the event list; event day re-reads the plan; else nothing. */
  async wake(): Promise<void> {
    if (localDay(this.now()) !== this.eventsDay) return this.loadEvents();
    if (this.isEventNight()) return this.refreshPlan();
    this.scheduleRefresh();
  }

  stop() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  // ---- matching ----------------------------------------------------------------------

  private allSongs(): (PlanSong & { sectionId: string; dnpSection: boolean })[] {
    return (this.plan?.sections ?? []).flatMap((s) => s.songs.map((g) => ({ ...g, sectionId: s.id, dnpSection: s.doNotPlay })));
  }

  private classify(np: NowPlaying, deck: number): DeckMatch {
    const songs = this.allSongs();
    const base: DeckMatch = {
      deck,
      title: np.title ?? "",
      artist: np.artist ?? "",
      absPath: np.absPath,
      played: confirmedPlay(np, Math.floor(this.now().getTime() / 1000)),
      songId: null,
      sectionId: null,
      how: null,
      dnp: null,
      mustPlay: false,
      startTime: np.startTime ?? null,
    };
    if (!this.plan) return base;
    // A do-not-play match wins over the same song sitting in another section.
    const dnpHit = findSong(np, songs.filter((s) => s.dnpSection));
    if (dnpHit) {
      const s = dnpHit.song;
      return { ...base, songId: s.id, sectionId: s.sectionId, how: dnpHit.how, dnp: s.artist ? `${s.title} — ${s.artist}` : s.title };
    }
    const note = matchNote(np, noteFragments(this.plan.doNotPlay.notes));
    if (note) return { ...base, how: "note", dnp: note };
    // Same song more than once in the plan: show the must-play one.
    const plain = songs.filter((s) => !s.dnpSection);
    const hit = findSong(np, [...plain.filter((s) => s.mustPlay), ...plain.filter((s) => !s.mustPlay)]);
    if (hit) return { ...base, songId: hit.song.id, sectionId: hit.song.sectionId, how: hit.how, mustPlay: hit.song.mustPlay };
    return base;
  }

  /** Tonight's history (On Cue opened mid-set, restarted, or Serato rewrote a flag) + the decks. */
  private async readTonight(): Promise<NowPlaying[]> {
    const since = Math.floor(this.now().getTime() / 1000) - 14 * 3600;
    let entries: NowPlaying[] = [];
    try { entries = await readRecentEntries(since, this.opts.seratoDir); } catch { /* no history */ }
    // The live deck entries are the freshest copy of their own rows.
    const key = (e: NowPlaying) => `${e.id}|${e.startTime ?? ""}|${e.deck ?? ""}`;
    const byKey = new Map(entries.map((e) => [key(e), e]));
    for (const e of Object.values(this.lastDeckState?.decks ?? {})) byKey.set(key(e), e);
    return [...byKey.values()];
  }

  /** Re-derive the ticks from tonight's history; fold in the CRM's and the DJ's own. */
  private recompute() {
    const nowSec = Math.floor(this.now().getTime() / 1000);
    const songs = this.allSongs().filter((s) => !s.dnpSection);
    this.autoPlayed.clear();
    for (const e of [...this.tonight].sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0))) {
      if (!confirmedPlay(e, nowSec)) continue;
      for (const song of findAllSongs(e, songs)) {
        if (!this.autoPlayed.has(song.id)) this.autoPlayed.set(song.id, new Date((e.startTime ?? 0) * 1000).toISOString());
      }
    }
    // Songs Serato now says were only loaded (flag rewritten to 0) and never really played
    // tonight: a stamp from earlier doesn't stand.
    const loadedOnly = new Set<string>();
    for (const e of this.tonight) {
      if (e.played !== false) continue;
      for (const song of findAllSongs(e, songs)) if (!this.autoPlayed.has(song.id)) loadedOnly.add(song.id);
    }
    const crm = [...this.crmPlayed].filter(([id]) => !loadedOnly.has(id));
    const next = new Map<string, string>([...crm, ...this.autoPlayed, ...this.manualOn]);
    for (const id of this.manualOff) next.delete(id);
    this.played = next;
  }

  private updating = false;
  private updateAgain = false;

  /** Re-read, re-match, re-tick, re-render, report. Serialized. */
  private async update(): Promise<void> {
    if (this.updating) { this.updateAgain = true; return; }
    this.updating = true;
    try {
      if (this.plan) this.tonight = await this.readTonight();
      this.decks = Object.entries(this.lastDeckState?.decks ?? {})
        .map(([d, np]) => this.classify(np, Number(d)))
        .sort((a, b) => a.deck - b.deck);
      this.recompute();
      this.emit();
      await this.report();
    } finally {
      this.updating = false;
      if (this.updateAgain) { this.updateAgain = false; void this.update(); }
    }
  }

  /** Serato changed something on the decks. */
  onDecks(state: DeckState): void {
    this.lastDeckState = state;
    void this.update();
  }

  /** The DJ ticked or un-ticked a song by hand. */
  toggle(songId: string, on: boolean) {
    if (on) {
      this.manualOn.set(songId, this.now().toISOString());
      this.manualOff.delete(songId);
    } else {
      this.manualOn.delete(songId);
      this.manualOff.add(songId);
    }
    this.recompute();
    this.emit();
    void this.report();
  }

  // ---- telling the CRM -------------------------------------------------------------

  private alertDeck(): DeckMatch | null {
    // The newest-loaded deck holding a do-not-play that hasn't gone out yet. Once it has
    // played the warning is moot, but it stays red on screen while it's on the deck.
    const dnp = this.decks.filter((d) => d.dnp).sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0));
    return dnp.find((d) => !d.played) ?? dnp[0] ?? null;
  }

  private async post(body: Record<string, unknown>) {
    const id = this.settings.eventId;
    if (!id || !this.configured) return false;
    try {
      await this.api(`/api/oncue/events/${encodeURIComponent(id)}/now-playing`, { method: "POST", body: JSON.stringify(body) });
      return true;
    } catch (e) {
      this.log(`report failed: ${(e as Error).message}`);
      return false;
    }
  }

  private reporting = false;
  private reportAgain = false;

  private async report() {
    if (!this.plan || !this.isEventNight()) return; // only on the night
    if (this.reporting) { this.reportAgain = true; return; }
    this.reporting = true;
    try {
      await this.reportOnce();
    } finally {
      this.reporting = false;
      if (this.reportAgain) { this.reportAgain = false; void this.report(); }
    }
  }

  private async reportOnce() {
    // Every plan song played tonight that the CRM hasn't stamped yet — including ones found in
    // tonight's history and ones ticked by hand. markOnly: stamp it, don't touch "now playing".
    const songs = new Map(this.allSongs().map((s) => [s.id, s]));
    for (const [id, at] of this.played) {
      const s = songs.get(id);
      if (!s || this.reported.has(id)) continue;
      if (await this.post({ title: s.title, artist: s.artist, played: true, songId: id, markOnly: true, playedAt: at })) this.reported.add(id);
    }
    // …and un-stamp what's no longer played: un-ticked by hand, or Serato rewrote it as never played.
    for (const id of [...this.reported]) {
      if (this.played.has(id) || !songs.has(id)) continue;
      const s = songs.get(id)!;
      if (await this.post({ title: s.title, artist: s.artist, played: false, songId: id, markOnly: true })) {
        this.reported.delete(id);
        this.crmPlayed.delete(id);
      }
    }
    // What the lock screen should show: a loaded do-not-play first, else what's playing.
    const alert = this.alertDeck();
    const playing = [...this.decks].filter((d) => d.played).sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0))[0];
    const show = alert && !alert.played ? alert : playing;
    if (!show) return;
    const key = `${show.deck}|${show.title}|${show.artist}|${show.played}|${show.dnp ?? ""}`;
    if (key === this.lastReportKey) return;
    this.lastReportKey = key;
    if (!(await this.post({ title: show.title, artist: show.artist, deck: show.deck, played: show.played, dnp: show.dnp }))) this.lastReportKey = "";
  }

  /** Event day, or the small hours after it (a gig runs past midnight). Mac-local time. */
  private isEventNight(): boolean {
    const date = this.plan?.event.date;
    if (!date) return false;
    const now = this.now();
    if (localDay(now) === date) return true;
    return now.getHours() < 6 && localDay(new Date(now.getTime() - 86400000)) === date;
  }

  // ---- snapshot -------------------------------------------------------------------

  snapshot(): OnCueSnapshot {
    const songs = this.allSongs().filter((s) => !s.dnpSection && s.mustPlay);
    const ageMs = this.plan ? this.now().getTime() - new Date(this.plan.generatedAt).getTime() : null;
    return {
      configured: this.configured,
      crmUrl: this.settings.crmUrl,
      hasKey: !!this.settings.key,
      events: this.events,
      eventId: this.settings.eventId || null,
      plan: this.plan,
      offline: this.offline,
      planAge: ageMs == null ? null : ageMs < 90000 ? "just now" : ageMs < 3600000 ? `${Math.round(ageMs / 60000)} min ago` : `${Math.round(ageMs / 3600000)} h ago`,
      error: this.error,
      decks: this.decks,
      played: Object.fromEntries(this.played),
      alert: this.alertDeck(),
      mustPlay: { total: songs.length, played: songs.filter((s) => this.played.has(s.id)).length },
    };
  }

  /** Every do-not-play path + entry — so suggestions never offer one tonight. */
  dnpFilter(): (t: { title?: string; artist?: string; absPath?: string }) => boolean {
    if (!this.plan) return () => false;
    const dnpSongs = this.allSongs().filter((s) => s.dnpSection);
    const frags = noteFragments(this.plan.doNotPlay.notes);
    return (t) => !!findSong(t, dnpSongs) || !!matchNote(t, frags);
  }

  private emit() {
    this.opts.onChange(this.snapshot());
  }
}
