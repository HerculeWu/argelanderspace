/**
 * The ONE application resource loader of the Copilot's Pi sessions (copilot tickets 03, 08 and 30).
 *
 * Everything the model is instructed with comes through here and nowhere else: the base system prompt (small and
 * always present) and the versioned instructions, which are skills of this loader. The skills are NOT written into the
 * system prompt: they cost the window nothing until the model asks for one (the `text` tool's `load_instruction`),
 * and then the loader hands over exactly the version this application ships. Nothing is read from a file system, the
 * environment or the working directory, so no `.pi`, AGENTS file or skill directory of the machine can reach a
 * session (spec §8.1), and the instruction is part of the bundle rather than a loose asset.
 */
import type { ResourceLoader, Skill } from "@earendil-works/pi-coding-agent";
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
 * (which tools are present decides what it says). The skills list only describes the instructions (for a future
 * reading tool and for slash-command listings); their text is held here and never written to a file or to the prompt.
 */
export function createApplicationResourceLoader(options: {
  extensions: ReturnType<ResourceLoader["getExtensions"]>;
  systemPrompt: () => string;
  /** Throws what a session would when asked to extend its resources (nothing may add any). */
  refuseExtension: () => never;
}): ApplicationResourceLoader {
  const skills: Skill[] = APP_INSTRUCTIONS.map((instruction) => ({
    name: instruction.name,
    description: instruction.description,
    // Not a file: this application's own resource. A `/skill:` expansion is never enabled for the Copilot's messages.
    filePath: `app:instructions/${instruction.name}`,
    baseDir: "app:instructions",
    sourceInfo: {
      path: `<app:${instruction.name}>`,
      source: "app",
      scope: "temporary",
      origin: "top-level",
    },
    disableModelInvocation: false,
  }));
  return {
    getExtensions: () => options.extensions,
    getSkills: () => ({ skills, diagnostics: [] }),
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
