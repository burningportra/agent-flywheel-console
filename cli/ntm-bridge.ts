// NTM Bridge — orchestrate NTM commands over SSH
// We wrap ntm, never bypass it

export interface AgentStatus {
  pane: number;
  status: "active" | "idle" | "stuck";
  lastActivity: string;
  currentBead?: string;
}

// TODO: Implement NTM bridge
// - ntm spawn <project> <count>
// - ntm send <pane> <prompt>
// - ntm activity <project> → parsed agent status
// - ntm pause / ntm resume
// - Idle detection: byte-identical snapshots × 3 at 5s intervals
