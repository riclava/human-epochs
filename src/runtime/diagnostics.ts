import type { ModelUsage } from "./model.js";

export type ToolOutcome = "returned" | "invalid_input" | "denied" | "unknown_tool" | "failed";

type RuntimeEvent =
  | { event: "model"; call: number; elapsedMs: number; outcome: string; httpStatus?: number; usage?: ModelUsage }
  | { event: "tool"; tool?: string; toolCallId?: string; elapsedMs: number; outcome: ToolOutcome }
  | { event: "material_fallback"; reason: "model_unavailable" | "model_failed" | "invalid_output" | "invalid_citation" };

export type ObserveRun = (event: RuntimeEvent) => void;
