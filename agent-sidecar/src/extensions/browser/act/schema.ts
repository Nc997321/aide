import { z } from "zod";

export const MAX_BATCH_STEPS = 8;

const actionFields = {
  action: z.enum(["click", "fill", "hover", "press"]),
  text: z.string().optional().describe("Visible label; for fill, the field label/name/id/placeholder."),
  selector: z.string().optional().describe("CSS target; takes precedence over text. Multiple matches require index."),
  tag: z.string().optional().describe("Restrict text matching to this tag."),
  index: z.number().int().min(0).optional().describe("Choose this match; selector ambiguity is never guessed."),
  value: z.string().optional().describe("Only for fill; select accepts option value or visible text."),
  key: z.string().optional().describe("Only for press: Enter, Escape, Tab, arrows, or a key with modifiers. Use fill to type."),
  modifiers: z.array(z.enum(["ctrl", "shift", "alt", "meta"])).optional(),
};

const waitFor = z.object({
  until: z.enum(["condition", "load"]).optional().describe("Default condition; load requires a new document after this action."),
  condition: z.string().optional().describe("Synchronous JS expression; truthy confirms the expected effect."),
  timeout_ms: z.number().int().min(1).max(30_000).optional().describe("Default 5000, at most 30000 and within the operation's 60s budget."),
}).strict();

export const actSchema = {
  view_id: z.string().optional().describe("View id from browser_tabs; omit only when exactly one view is open."),
  ...actionFields,
  action: z.enum(["click", "fill", "hover", "press", "batch"]),
  steps: z.array(z.object({ ...actionFields, wait_for: waitFor.optional() }).strict())
    .min(1).max(MAX_BATCH_STEPS).optional()
    .describe("Only for batch: 1–8 explicit actions in order; first failure, unmet wait or uncertain input stops the rest. No rollback/replay."),
  scope: z.string().optional().describe("CSS subtree for before/after page feedback, as in browser_read; not an action target."),
  wait_for: waitFor.optional().describe("Optional expected result after a single action; for batch put it on the relevant step."),
};

export const actInputSchema = z.object(actSchema).strict();
export type ActInput = z.infer<typeof actInputSchema>;
export type StepInput = Omit<ActInput, "action" | "view_id" | "steps" | "scope"> & {
  action: "click" | "fill" | "hover" | "press";
};
export type WaitFor = z.infer<typeof waitFor>;
