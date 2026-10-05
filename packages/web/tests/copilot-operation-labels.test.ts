import { LIBRARY_OPERATION_ACTIONS, PLAN_OPERATION_ACTIONS, READER_OPERATION_ACTIONS, WORKSPACE_OPERATION_ACTIONS, WRITER_OPERATION_ACTIONS } from "@argelanderspace/contracts";
import { expect, test } from "vitest";
import { OPERATION_ACTION_KEYS } from "../src/copilot/Copilot";
import i18n from "../src/i18n";

test("every tool action has a translated operation label in each language", async () => {
  const actions = new Set<string>([...PLAN_OPERATION_ACTIONS, ...WORKSPACE_OPERATION_ACTIONS, ...LIBRARY_OPERATION_ACTIONS, ...READER_OPERATION_ACTIONS, ...WRITER_OPERATION_ACTIONS]);
  for (const language of ["en", "zh-CN"]) {
    await i18n.changeLanguage(language);
    for (const action of actions) {
      const key = (OPERATION_ACTION_KEYS as Record<string, string>)[action];
      expect(key, action).toBeTruthy();
      expect(i18n.exists(key!), `${language}:${action}`).toBe(true);
    }
  }
});
