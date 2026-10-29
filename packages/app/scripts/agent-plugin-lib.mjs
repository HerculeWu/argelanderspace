// The Agent plugin (release-0.2 ticket 14): a single-plugin local marketplace for Claude Code, built into
// dist/agent-plugin/ and shipped in the npm package (and, as part of dist/, in the desktop package's sidecar app).
//
// Layout (schema: Claude Code docs, plugin-marketplaces and plugin manifest reference; the sources are recorded in the
// ticket's Comments). The marketplace root and the plugin root are the same folder, the entry's source is "./":
//   dist/agent-plugin/.claude-plugin/marketplace.json   the marketplace (name AGENT_MARKETPLACE_NAME, one plugin)
//   dist/agent-plugin/.claude-plugin/plugin.json        the plugin (name AGENT_PLUGIN_NAME, version = package version)
//   dist/agent-plugin/skills/                           a copy of dist/skills made at build time (never a second source)
// No MCP server, hooks, agents or CLI body: the plugin only carries the operation guides and uses the CLI on PATH.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const AGENT_PLUGIN_NAME = "argelanderspace";
export const AGENT_MARKETPLACE_NAME = "argelanderspace-local";
export const AGENT_PLUGIN_FILES = [".claude-plugin/marketplace.json", ".claude-plugin/plugin.json"];

const DESCRIPTION =
  "Operation guides for ArgelanderSpace: read, search and annotate your literature library and write argument graphs through the argelanderspace command line.";

export function pluginManifest(version, repository) {
  return {
    name: AGENT_PLUGIN_NAME,
    version,
    description: DESCRIPTION,
    author: { name: "ArgelanderSpace" },
    ...(repository ? { repository: repository.replace(/^git\+/, "").replace(/\.git$/, "") } : {}),
    license: "MIT",
    keywords: ["literature", "papers", "citation-graph", "arxiv"],
  };
}

export function marketplaceManifest() {
  return {
    name: AGENT_MARKETPLACE_NAME,
    description: "The ArgelanderSpace Agent plugin, shipped with the argelanderspace package.",
    owner: { name: "ArgelanderSpace" },
    plugins: [{ name: AGENT_PLUGIN_NAME, source: "./", description: DESCRIPTION }],
  };
}

/** Build `<distDir>/agent-plugin` from `<distDir>/skills` (already copied) for `version`. */
export function buildAgentPlugin(distDir, version, repository) {
  const skills = join(distDir, "skills");
  if (!existsSync(join(skills, "README.md"))) throw new Error("dist/skills must be built first");
  const out = join(distDir, "agent-plugin");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(out, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(pluginManifest(version, repository), null, 2)}\n`
  );
  writeFileSync(
    join(out, ".claude-plugin", "marketplace.json"),
    `${JSON.stringify(marketplaceManifest(), null, 2)}\n`
  );
  cpSync(skills, join(out, "skills"), { recursive: true });
}

function tree(dir) {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) =>
        join(e.parentPath ?? e.path, e.name)
          .slice(dir.length + 1)
          .replaceAll("\\", "/")
      )
      .sort();
  } catch {
    return [];
  }
}

function readJson(file, problems) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    problems.push(
      `agent plugin: ${file} is not readable JSON (${e instanceof Error ? e.message : e})`
    );
    return null;
  }
}

/**
 * Problems with an agent-plugin folder (empty = fine): the files exist, both manifests carry the plugin and marketplace
 * names and `version`, the marketplace lists exactly this plugin at "./", and skills/ is the bundled guides
 * (`skillsDir`) file for file.
 */
export function checkAgentPlugin(pluginDir, skillsDir, version) {
  const problems = [];
  for (const f of AGENT_PLUGIN_FILES)
    if (!existsSync(join(pluginDir, f))) problems.push(`agent plugin: missing ${f}`);
  if (problems.length === 0) {
    const plugin = readJson(join(pluginDir, ".claude-plugin/plugin.json"), problems);
    const market = readJson(join(pluginDir, ".claude-plugin/marketplace.json"), problems);
    if (plugin) {
      if (plugin.name !== AGENT_PLUGIN_NAME)
        problems.push(`agent plugin: plugin.json name ${plugin.name} is not ${AGENT_PLUGIN_NAME}`);
      if (plugin.version !== version)
        problems.push(
          `agent plugin: plugin.json version ${plugin.version} differs from package version ${version}`
        );
      for (const k of ["mcpServers", "hooks", "agents", "commands"])
        if (k in plugin) problems.push(`agent plugin: plugin.json must not declare ${k}`);
    }
    if (market) {
      if (market.name !== AGENT_MARKETPLACE_NAME)
        problems.push(
          `agent plugin: marketplace.json name ${market.name} is not ${AGENT_MARKETPLACE_NAME}`
        );
      const entries = Array.isArray(market.plugins) ? market.plugins : [];
      const e = entries[0];
      if (entries.length !== 1 || e?.name !== AGENT_PLUGIN_NAME || e?.source !== "./")
        problems.push(
          `agent plugin: marketplace.json must list exactly ${AGENT_PLUGIN_NAME} at source "./"`
        );
      else if (e.version !== undefined && e.version !== version)
        problems.push(
          `agent plugin: marketplace.json version ${e.version} differs from package version ${version}`
        );
    }
  }
  const want = tree(skillsDir);
  const got = tree(join(pluginDir, "skills"));
  if (want.length === 0)
    problems.push(`agent plugin: reference skills folder ${skillsDir} is empty`);
  for (const f of want) {
    if (!got.includes(f)) problems.push(`agent plugin: skills/${f} is missing`);
    else if (!readFileSync(join(skillsDir, f)).equals(readFileSync(join(pluginDir, "skills", f))))
      problems.push(`agent plugin: skills/${f} differs from the bundled guide`);
  }
  for (const f of got)
    if (!want.includes(f)) problems.push(`agent plugin: skills/${f} is not a bundled guide`);
  return problems;
}
