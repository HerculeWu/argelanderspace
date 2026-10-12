/**
 * What the argument graph view tells the Copilot (ADR 0005, ticket 04). The shape, its capacity rule (whole graph within
 * a budget, otherwise a partial page with the selected argument in full) and its summary live in contracts
 * (`argument-ops.ts`); this module is the view's name for them.
 */
export { type ArgumentPage, buildArgumentPage as captureArgumentPage } from "@argelanderspace/contracts";
