// Re-export CLI types for dashboard consumption (type-only — no runtime import).
export type {
  ActionName,
  ActionState,
  BeadSummary,
  DashboardAction,
  DashboardSnapshot,
  MailStatus,
  PromptSummary,
  RunSummary,
  VpsHealth,
  WorkflowGuidance,
} from "../cli/server.js";

export type { AgentRuntimeType, AgentStatus } from "../cli/ntm-bridge.js";

export type { Phase } from "../cli/state.js";

// Client-only types (not present on the server).

import type { ActionName, DashboardSnapshot } from "../cli/server.js";

export type ServerMessage =
  | { type: "snapshot"; payload: DashboardSnapshot }
  | { type: "action_result"; ok: true; action: ActionName; payload: unknown }
  | { type: "action_result"; ok: false; error: string };

export interface ActionLogEntry {
  timestamp: string;
  action: ActionName;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

export interface CostSummary {
  totalCostUsd: number;
  byModel: Record<string, number>;
  byPhase: Record<string, number>;
}
