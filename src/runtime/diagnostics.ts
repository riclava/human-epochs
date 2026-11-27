import type { ModelUsage } from "./model.js";

// Why a material reply failed verification. Logs carry only this category, never the text that failed.
export type VerificationFailure = "invalid_output" | "invalid_citation" | "unsourced_quote" | "invalid_structure";

export type ToolOutcome = "returned" | "invalid_input" | "denied" | "unknown_tool" | "failed";

type RuntimeEvent =
  | { event: "model"; call: number; elapsedMs: number; outcome: string; httpStatus?: number; usage?: ModelUsage }
  | { event: "tool"; tool?: string; toolCallId?: string; elapsedMs: number; outcome: ToolOutcome }
  | { event: "material_retry"; reason: VerificationFailure }
  | { event: "material_fallback"; reason: "model_unavailable" | "model_failed" | VerificationFailure };

export type ObserveRun = (event: RuntimeEvent) => void;
