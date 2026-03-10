// Local HTTP + WebSocket server for dashboard
// Topology: Browser ←→ WS ←→ this server ←→ SSH ←→ VPS
// Never expose beyond localhost

// TODO: Implement server
// - HTTP server on localhost:4200
// - WebSocket for real-time dashboard updates
// - SSH polling loop → bead_snapshots → WS push
// - Polling intervals:
//   - Agent status (ntm activity): 10s
//   - Beads (br stats + bv --robot-triage): 20s
//   - VPS health (uptime + free + df): 45s
//   - Agent Mail: 10s
// - Three permitted mutations from dashboard:
//   1. Prompt injection (prompts send)
//   2. Swarm pause/resume
//   3. Gate advance
