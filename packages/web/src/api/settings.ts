import {
  SETTING_CHANGE_REFUSALS,
  SETTING_KEYS,
  type SettingChangeRefusal,
  type SettingChangeRequest,
  type SettingKey,
  type SettingsSnapshot,
} from "@argelanderspace/contracts";
import { apiRequest, HttpError } from "./request";

/**
 * The settings endpoints (desktop-app ticket 10): the page reads every setting with one GET and changes one key of
 * config.toml with one PUT. What comes back is checked for the shape the page relies on; an answer that does not
 * have it counts as no answer.
 */

/** Why a change was not made: the server's category, or `unreachable` when no usable answer came. */
export type SettingChangeFailure = SettingChangeRefusal | "unreachable";

export type SettingChangeOutcome =
  | { ok: true; changed: boolean; settings: SettingsSnapshot }
  | { ok: false; reason: SettingChangeFailure };

function isSnapshot(value: unknown): value is SettingsSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<SettingsSnapshot>;
  if (v.version !== 1 || typeof v.path !== "string" || typeof v.readonly !== "boolean") return false;
  if (typeof v.values !== "object" || v.values === null) return false;
  if (typeof v.sources !== "object" || v.sources === null) return false;
  if (typeof v.uneditable !== "object" || v.uneditable === null) return false;
  if (!Array.isArray(v.problems) || !Array.isArray(v.legacy)) return false;
  return SETTING_KEYS.every((key) => key in (v.values as object) && key in (v.sources as object));
}

/** The settings as the server reads them now; null when the server gave no usable answer. */
export async function fetchSettings(signal?: AbortSignal): Promise<SettingsSnapshot | null> {
  try {
    const body = await apiRequest<unknown>("/api/settings", { cache: "no-store" }, { signal });
    return isSnapshot(body) ? body : null;
  } catch (e) {
    if ((e as { name?: string } | null)?.name === "AbortError") throw e;
    return null;
  }
}

/** Set one key, or remove it so that its default applies. Never throws. */
export async function changeSetting(key: SettingKey, change: SettingChangeRequest): Promise<SettingChangeOutcome> {
  try {
    const body = await apiRequest<{ ok?: unknown; changed?: unknown; settings?: unknown }>(
      `/api/settings/${encodeURIComponent(key)}`,
      { method: "PUT", json: change }
    );
    if (body?.ok === true && isSnapshot(body.settings)) return { ok: true, changed: body.changed === true, settings: body.settings };
    return { ok: false, reason: "unreachable" };
  } catch (e) {
    const reason = e instanceof HttpError ? (e.body as { reason?: unknown } | null)?.reason : undefined;
    return {
      ok: false,
      reason: (SETTING_CHANGE_REFUSALS as readonly unknown[]).includes(reason) ? (reason as SettingChangeRefusal) : "unreachable",
    };
  }
}
