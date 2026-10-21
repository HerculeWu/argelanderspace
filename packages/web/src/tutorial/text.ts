import type { TFunction } from "i18next";

/** A copy key built at run time (`tutorial.steps.<id>.title`): the definitions own these keys, the locale test checks them. */
export function tk(t: TFunction, key: string, values?: Record<string, unknown>): string {
  return (t as unknown as (k: string, v?: Record<string, unknown>) => string)(key, values);
}
