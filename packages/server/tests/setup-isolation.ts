import { mailAccountProbe } from "../src/mail-account-probe.js";

// Runs after packages/infra/tests/isolate-user-dirs.ts, which has already pointed the per-user directories at a
// throwaway one; importing server source is safe from here on.
// Mail tool mounting asks "is there an account?": tests answer "no" unless they inject their own probe.
mailAccountProbe.default = () => false;
