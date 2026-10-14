/**
 * A stand-in for the server's settings endpoints in web tests: `GET /api/settings` and `PUT /api/settings/:key`
 * over an in-memory "file" (the keys it sets), answering with the shapes of contracts `settings-api.ts`. A test
 * routes its fetch stub through `handle` and looks at `file`, `puts` and what the page shows.
 */
import {
  checkSettingValue,
  defaultSettings,
  isSettingKey,
  redactSettingsValues,
  SETTINGS_SCHEMA,
  type SettingChangeRefusal,
  type SettingKey,
  type SettingsFileState,
  type SettingsProblem,
  type SettingsSnapshot,
  type SettingValue,
} from "@argelanderspace/contracts";

export interface FakeSettings {
  /** The keys the file sets. A test may change it directly: an edit made outside the page. */
  file: Partial<Record<SettingKey, SettingValue>>;
  problems: SettingsProblem[];
  uneditable: Partial<Record<SettingKey, SettingChangeRefusal>>;
  state: SettingsFileState;
  /** Refuse the next changes of a key with this category (the file stays as it is). */
  refuse: Partial<Record<SettingKey, SettingChangeRefusal>>;
  /** Where the "running process" keeps its data (fixed at its start; the file's state does not change it). */
  startup: SettingsSnapshot["startup"];
  /** What the "running process" uses for the restart-only keys (desktop-app ticket 11). */
  running: SettingsSnapshot["running"];
  /** The deprecated keys the file still sets. */
  legacy: SettingKey[];
  /** Every change the page asked for, in order. */
  puts: { key: string; body: unknown }[];
  gets: number;
  /** No answer at all (the request fails), until set back. */
  down: boolean;
  /**
   * Delays (ms) for the next changes, one taken per change: such a change reaches the file only after its delay, so
   * changes sent at once can be written in another order than sent (as when several requests wait for the file lock).
   */
  writeDelays: number[];
  /** Delays (ms) for the next reads, one taken per read: the answer is what the file held when the read arrived. */
  getDelays: number[];
  /** A refused change is answered this many ms late (default 200): a refusal does not come at once from a real server. */
  refusalDelayMs: number;
  snapshot(): SettingsSnapshot;
  /** The answer to a request of the settings endpoints; null for any other URL. */
  handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> | null;
}

const json = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

/** The value in effect for each key of a "file" (the default where it does not set the key). */
function effective(file: Partial<Record<SettingKey, SettingValue>>): Record<SettingKey, SettingValue | null> {
  return { ...defaultSettings(), ...file };
}

export function fakeSettings(file: Partial<Record<SettingKey, SettingValue>> = {}): FakeSettings {
  // The file as the "process" started with it: a restart-only key changed since is pending a restart.
  const atStart = effective(file);
  const fake: FakeSettings = {
    file: { ...file },
    problems: [],
    uneditable: {},
    state: "read",
    refuse: {},
    puts: [],
    gets: 0,
    down: false,
    refusalDelayMs: 200,
    startup: null,
    running: {
      project_root: { path: "/home/someone/project", display: "~/project" },
      port: 1859,
      data_dir: { path: "/home/someone/project/literatures", display: "~/project/literatures" },
      global_dir: { path: "/home/someone/.local/share/argelanderspace", display: "~/.local/share/argelanderspace" },
      global_cache_dir: { path: "/home/someone/.cache/argelanderspace", display: "~/.cache/argelanderspace" },
      from_flag: [],
    },
    legacy: [],
    writeDelays: [],
    getDelays: [],
    snapshot() {
      const readonly = fake.state === "unparseable" || fake.state === "unreadable";
      const values = defaultSettings();
      const sources = Object.fromEntries(Object.keys(SETTINGS_SCHEMA).map((key) => [key, "default"])) as SettingsSnapshot["sources"];
      const bad = new Set(fake.problems.map((problem) => problem.key));
      if (!readonly) {
        for (const [key, value] of Object.entries(fake.file) as [SettingKey, SettingValue][]) {
          if (bad.has(key)) continue;
          values[key] = value;
          sources[key] = "file";
        }
      }
      return {
        version: 1,
        path: "/home/someone/.config/argelanderspace/config.toml",
        pathDisplay: "~/.config/argelanderspace/config.toml",
        file: fake.state,
        readonly,
        values: redactSettingsValues(values),
        sources,
        problems: readonly ? [{ key: null, reason: fake.state as "unparseable" | "unreadable" }] : fake.problems,
        uneditable: readonly ? {} : fake.uneditable,
        legacy: fake.legacy,
        startup: fake.startup,
        running: fake.running,
        restartPending: (Object.keys(SETTINGS_SCHEMA) as SettingKey[]).filter(
          (key) => !readonly && SETTINGS_SCHEMA[key].restart && !(fake.running.from_flag as string[]).includes(key) && values[key] !== atStart[key]
        ),
      };
    },
    handle(input, init) {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/settings" && method === "GET") {
        fake.gets += 1;
        if (fake.down) return Promise.reject(new TypeError("fetch failed"));
        const answer = json(fake.snapshot());
        const delay = fake.getDelays.shift();
        return delay === undefined ? Promise.resolve(answer) : new Promise((resolve) => setTimeout(() => resolve(answer), delay));
      }
      if (!url.startsWith("/api/settings/") || method !== "PUT") return null;
      const key = decodeURIComponent(url.slice("/api/settings/".length));
      const body = JSON.parse(String(init?.body)) as { set?: SettingValue; reset?: true };
      fake.puts.push({ key, body });
      if (fake.down) return Promise.reject(new TypeError("fetch failed"));
      const refuse = (reason: SettingChangeRefusal, status: number) =>
        new Promise<Response>((resolve) => setTimeout(() => resolve(json({ ok: false, reason }, status)), fake.refusalDelayMs));
      if (!isSettingKey(key)) return refuse("unknown_key", 404);
      if (SETTINGS_SCHEMA[key].ui !== "edit") return refuse("not_editable", 422);
      const forced = fake.refuse[key] ?? fake.uneditable[key];
      if (forced) return refuse(forced, 409);
      if (fake.state === "unparseable") return refuse("unparseable", 409);
      if (body.reset !== true && (body.set === undefined || checkSettingValue(key, body.set) !== null)) return refuse("invalid_value", 400);
      // The change reaches the "file" now, or after its delay.
      const write = (): Response => {
        let changed: boolean;
        if (body.reset === true) {
          changed = key in fake.file;
          delete fake.file[key];
        } else {
          changed = fake.file[key] !== body.set;
          fake.file[key] = body.set as SettingValue;
        }
        fake.problems = fake.problems.filter((problem) => problem.key !== key);
        return json({ ok: true, changed, settings: fake.snapshot() });
      };
      const delay = fake.writeDelays.shift();
      if (delay !== undefined) return new Promise<Response>((resolve) => setTimeout(() => resolve(write()), delay));
      return Promise.resolve(write());
    },
  };
  return fake;
}
