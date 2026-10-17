import { fileToolsDefault } from "../src/file-tools-default.js";
import { mailAccountProbe } from "../src/mail-account-probe.js";

// Runs after packages/infra/tests/isolate-user-dirs.ts, which has already pointed the per-user directories at a
// throwaway one; importing server source is safe from here on.
// Mail tool mounting asks "is there an account?": tests answer "no" unless they inject their own probe.
mailAccountProbe.default = () => false;
// Copilot's file and command tools default to "ask" in production; the tests of the other tools see none of them,
// and the tests of these tools write `copilot_file_tools` to a config file of their own.
fileToolsDefault.value = "off";
