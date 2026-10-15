import { z } from "zod";

/** The long operations the runner executes (`upload` = user LaTeX-zip attach, MS2); a leaf like the state below. */
export const JobKindSchema = z.enum(["upload", "refresh", "ingest"]);

/** A job's state; a leaf module so schemas that jobs.ts itself depends on can share it without an import cycle. */
export const JobStatusSchema = z.enum(["queued", "running", "done", "failed", "interrupted"]);
