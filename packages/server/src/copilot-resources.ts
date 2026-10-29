/**
 * The ONE application resource loader of the Copilot's Pi sessions (copilot tickets 03, 08 and 30).
 *
 * Everything the model is instructed with comes through here and nowhere else: the base system prompt (small and
 * always present), the versioned instructions, which are held in memory (not Pi skills, not files), and the skills that
 * ship with the application (copilot ticket 58, ADR 0011), which are files. The instructions are NOT written into the
 * system prompt: they cost the window nothing until the model asks for one (the `text` tool's `load_instruction`),
 * and then the loader hands over exactly the version this application ships. Nothing is discovered from a file system, the
 * environment or the working directory, so no `.pi`, AGENTS file or skill directory of the machine can reach a
 * session (spec §8.1), and the instruction is part of the bundle rather than a loose asset. The ONE place a skill
 * comes from is the bundled skills folder (`bundledSkillsDir`, the folder the desktop app's "show the skills folder"
 * opens); it is read only here, and only when the file tools are on (a skill is read with the `read` tool).
 */

import {
  type LoadSkillsResult,
  loadSkillsFromDir,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { PDF_TRANSCRIPTION_INSTRUCTION } from "./copilot-transcription-instruction.js";

/**
 * The Copilot's skills from the folder that ships with the application: every bundled skill, nothing from any other
 * place. (Until release-0.2 an allow-list kept three of the six: the guides now describe each step as an operation with
 * its Copilot tool action beside the CLI command for external agents, so one guide serves both entries, ADR 0015's
 * revision of ADR 0011. Plan, Writer, Mail and the shelf have no guide; the Copilot uses those tools as before.)
 */
export function loadBundledSkills(dir: string | null | undefined): LoadSkillsResult {
  if (!dir) return { skills: [], diagnostics: [] };
  return loadSkillsFromDir({ dir, source: "bundled" });
}

export interface AppInstruction {
  /** The name the model asks for. */
  name: string;
  /** The version of the instruction text this application ships; it changes whenever the text does. */
  version: number;
  /** One line: when to load it. */
  description: string;
  text: string;
}

/** Every instruction the application ships. A new one is added here and nowhere else. */
export const APP_INSTRUCTIONS: readonly AppInstruction[] = [PDF_TRANSCRIPTION_INSTRUCTION];

export type ApplicationResourceLoader = ResourceLoader & {
  /** The named instruction, or null: the model's `load_instruction` is answered from this and nothing else. */
  getInstruction(name: string): AppInstruction | null;
  /** The names of the instructions that can be loaded. */
  instructionNames(): string[];
};

/**
 * `extensions` is the (empty) runtime the session needs; `systemPrompt` builds the base instruction of the session
 * (which tools are present decides what it says). The instructions are held here in memory: never written to a file,
 * never in the prompt, never a Pi skill.
 */
export function createApplicationResourceLoader(options: {
  extensions: ReturnType<ResourceLoader["getExtensions"]>;
  systemPrompt: () => string;
  /** The bundled skills this session lists (`loadBundledSkills`); none when absent. */
  skills?: () => LoadSkillsResult;
  /** Throws what a session would when asked to extend its resources (nothing may add any). */
  refuseExtension: () => never;
}): ApplicationResourceLoader {
  return {
    getExtensions: () => options.extensions,
    // The versioned instructions are not Pi skills (a skill has a file path; they are not files): they are reachable only
    // through `getInstruction` (the `load_instruction` tool). The only skills are the bundled ones, given by the host.
    getSkills: () => options.skills?.() ?? { skills: [], diagnostics: [] },
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: options.systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => options.refuseExtension(),
    reload: async () => {},
    getInstruction: (name) => APP_INSTRUCTIONS.find((item) => item.name === name) ?? null,
    instructionNames: () => APP_INSTRUCTIONS.map((item) => item.name),
  };
}
