/**
 * `argelanderspace agent-plugin` (release-0.2 ticket 14; spec 「Agent 插件」, Q25): prints where the Agent plugin that
 * ships with this installation is, and the two commands to type inside Claude Code to add and install it. Read-only: it
 * looks at the plugin folder beside the running CLI entry (`dist/agent-plugin`, in the npm package and in the desktop
 * package alike) and changes no configuration, neither Claude Code's nor ArgelanderSpace's. The plugin and marketplace
 * names are read from the shipped manifests, so they cannot drift from what Claude Code will read.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bundledAgentPluginDir } from "@argelanderspace/infra";
import type { Command } from "commander";
import { fail, realpathOr } from "./common.js";

export const AGENT_PLUGIN_MESSAGES = {
  noPlugin: "this installation does not include the Agent plugin",
};

function manifestName(dir: string, file: string): string {
  const name = (
    JSON.parse(readFileSync(join(dir, ".claude-plugin", file), "utf8")) as { name?: unknown }
  ).name;
  if (typeof name !== "string" || name === "") throw new Error(`${file} in ${dir} has no name`);
  return name;
}

/** The output lines for the plugin folder `dir`. */
export function agentPluginLines(dir: string): string[] {
  const plugin = manifestName(dir, "plugin.json");
  const marketplace = manifestName(dir, "marketplace.json");
  return [
    `Agent plugin: ${dir}`,
    "",
    "In Claude Code, run:",
    `  /plugin marketplace add ${dir}`,
    `  /plugin install ${plugin}@${marketplace}`,
  ];
}

export function registerAgentPluginCommand(program: Command): void {
  program
    .command("agent-plugin")
    .description(
      "Print the path of the Claude Code Agent plugin and the two commands that install it (changes no configuration)."
    )
    .action(() => {
      try {
        const entry = process.argv[1] === undefined ? null : realpathOr(resolve(process.argv[1]));
        const dir = entry === null ? null : bundledAgentPluginDir(entry);
        if (dir === null) throw new Error(AGENT_PLUGIN_MESSAGES.noPlugin);
        console.log(agentPluginLines(dir).join("\n"));
      } catch (e) {
        fail(e);
      }
    });
}
