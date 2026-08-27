#!/usr/bin/env node
// The published `argelanderspace` binary (decision 22): the M5 commander
// program bundled into one self-contained ESM file (see tsup.config.ts).
import { buildProgram } from "@argelanderspace/cli";

await buildProgram().parseAsync(process.argv);
