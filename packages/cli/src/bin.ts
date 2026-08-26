#!/usr/bin/env node
// The `argelanderspace` binary (name re-checked at M6 packaging, decision 22).
import { buildProgram } from "./program.js";

await buildProgram().parseAsync(process.argv);
