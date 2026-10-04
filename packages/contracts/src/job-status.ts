import { z } from "zod";

/** A job's state; a leaf module so schemas that jobs.ts itself depends on can share it without an import cycle. */
export const JobStatusSchema = z.enum(["queued", "running", "done", "failed", "interrupted"]);
