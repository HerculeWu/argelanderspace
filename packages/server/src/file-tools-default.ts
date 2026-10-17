import type { CopilotFileToolsSetting } from "@argelanderspace/contracts";

/**
 * What a Copilot host gets for the file and command permission when config.toml does not set `copilot_file_tools`.
 * Unset in production (the schema default, "ask"); the server tests install "off" so that the many tests of other
 * tools see the tool list they were written for, and the tests of these tools set the key in a config file of their
 * own. Kept in its own file so installing it imports nothing else.
 */
export const fileToolsDefault: { value: CopilotFileToolsSetting | undefined } = {
  value: undefined,
};
