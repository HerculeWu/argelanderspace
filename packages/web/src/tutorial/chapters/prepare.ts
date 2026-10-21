import { SETTINGS_VIEW } from "@argelanderspace/contracts";
import type { ChapterDefinition, Requirement } from "../types";

/** The anchors of chapter 0, constants checked by the static anchor test. */
const NAV_SETTINGS = { ui: "navigate-view", key: SETTINGS_VIEW } as const;
const SETTINGS_PAGE = { ui: "settings-page" } as const;
const GROUP_TEX = { ui: "settings-group", key: "tex" } as const;
const ENVIRONMENT_CHECK = { ui: "environment-check" } as const;
const ENVIRONMENT_RECHECK = { ui: "environment-recheck" } as const;
const GROUP_SERVICES = { ui: "settings-group", key: "services" } as const;
const ADS_CREDENTIAL = { ui: "ads-credential" } as const;
const GROUP_CLI = { ui: "settings-group", key: "cli" } as const;
const CLI_INSTALL = { ui: "cli-install" } as const;
const SHOW_SKILLS_FOLDER = { ui: "show-skills-folder" } as const;

/** The settings page is a pane view the Copilot's `switch_view` does not take: no "take me there", only the hint. */
const ON_SETTINGS: Requirement = { test: (s) => s.page.view === SETTINGS_VIEW, where: "settings" };

/** Chapter 0, "prepare" (appendix A): the settings page. */
export const PREPARE: ChapterDefinition = {
  id: "prepare",
  n: 0,
  steps: [
    {
      id: "prepare.settings",
      kind: "do",
      anchors: [NAV_SETTINGS, SETTINGS_PAGE],
      gate: (s) => s.page.view === SETTINGS_VIEW,
    },
    {
      id: "prepare.environment",
      kind: "do",
      // The check lives in its settings group: the group's entry is the lowest rung, shown until the group is open.
      anchors: [GROUP_TEX, ENVIRONMENT_CHECK, ENVIRONMENT_RECHECK],
      gate: (s) => s.dom.attr(ENVIRONMENT_CHECK, "data-state") === "done",
      requires: ON_SETTINGS,
      onPass: "recheckEnvironment",
    },
    {
      id: "prepare.ads",
      kind: "look",
      anchors: [GROUP_SERVICES, ADS_CREDENTIAL],
      requires: ON_SETTINGS,
    },
    {
      id: "prepare.agent",
      kind: "agent",
      anchors: [GROUP_CLI, CLI_INSTALL, SHOW_SKILLS_FOLDER],
      // The browser form has no "command line & agents" group: no anchor, the card docks, the browser copy.
      browser: { anchors: [], copy: "browser" },
    },
  ],
};
