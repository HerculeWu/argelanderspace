/**
 * The ONE application resource loader of the Copilot's Pi sessions (copilot tickets 03, 08 and 30).
 *
 * Everything the model is instructed with comes through here and nowhere else: the base system prompt (small and
 * always present) and the versioned instructions, which are held in memory (not Pi skills, not files). They are NOT written into the
 * system prompt: they cost the window nothing until the model asks for one (the `text` tool's `load_instruction`),
 * and then the loader hands over exactly the version this application ships. Nothing is read from a file system, the
 * environment or the working directory, so no `.pi`, AGENTS file or skill directory of the machine can reach a
 * session (spec §8.1), and the instruction is part of the bundle rather than a loose asset.
 */
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { PDF_TRANSCRIPTION_INSTRUCTION } from "./copilot-transcription-instruction.js";

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
  /** Throws what a session would when asked to extend its resources (nothing may add any). */
  refuseExtension: () => never;
}): ApplicationResourceLoader {
  return {
    getExtensions: () => options.extensions,
    // No Pi skills: a skill has a file path a `/skill:` command would read, and the instructions are not files. They are
    // reachable only through `getInstruction` (the `load_instruction` tool).
    getSkills: () => ({ skills: [], diagnostics: [] }),
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
