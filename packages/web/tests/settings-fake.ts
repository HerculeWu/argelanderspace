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
  /** Every change the page asked for, in order. */
  puts: { key: string; body: unknown }[];
  gets: number;
  /** No answer at all (the request fails), until set back. */
  down: boolean;
  snapshot(): SettingsSnapshot;
  /** The answer to a request of the settings endpoints; null for any other URL. */
  handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> | null;
}

const json = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

export function fakeSettings(file: Partial<Record<SettingKey, SettingValue>> = {}): FakeSettings {
  const fake: FakeSettings = {
    file: { ...file },
    problems: [],
    uneditable: {},
    state: "read",
    refuse: {},
    puts: [],
    gets: 0,
    down: false,
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
        file: fake.state,
        readonly,
        values: redactSettingsValues(values),
        sources,
        problems: readonly ? [{ key: null, reason: fake.state as "unparseable" | "unreadable" }] : fake.problems,
        uneditable: readonly ? {} : fake.uneditable,
        legacy: [],
      };
    },
    handle(input, init) {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/settings" && method === "GET") {
        fake.gets += 1;
        if (fake.down) return Promise.reject(new TypeError("fetch failed"));
        return Promise.resolve(json(fake.snapshot()));
      }
      if (!url.startsWith("/api/settings/") || method !== "PUT") return null;
      const key = decodeURIComponent(url.slice("/api/settings/".length));
      const body = JSON.parse(String(init?.body)) as { set?: SettingValue; reset?: true };
      fake.puts.push({ key, body });
      if (fake.down) return Promise.reject(new TypeError("fetch failed"));
      const refuse = (reason: SettingChangeRefusal, status: number) => Promise.resolve(json({ ok: false, reason }, status));
      if (!isSettingKey(key)) return refuse("unknown_key", 404);
      if (SETTINGS_SCHEMA[key].ui !== "edit") return refuse("not_editable", 422);
      const forced = fake.refuse[key] ?? fake.uneditable[key];
      if (forced) return refuse(forced, 409);
      if (fake.state === "unparseable") return refuse("unparseable", 409);
      let changed: boolean;
      if (body.reset === true) {
        changed = key in fake.file;
        delete fake.file[key];
      } else {
        if (body.set === undefined || checkSettingValue(key, body.set) !== null) return refuse("invalid_value", 400);
        changed = fake.file[key] !== body.set;
        fake.file[key] = body.set;
      }
      fake.problems = fake.problems.filter((problem) => problem.key !== key);
      return Promise.resolve(json({ ok: true, changed, settings: fake.snapshot() }));
    },
  };
  return fake;
}
