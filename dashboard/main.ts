import type {
  AgentStatus,
  BeadSummary,
  CostSummary,
  DashboardSnapshot,
  MailStatus,
  Phase,
  PromptSummary,
  RunSummary,
  VpsHealth,
} from "./types.js";

const STORAGE_SERVER_URL = "flywheel.dashboard.server-url";
const PHASES = ["plan", "beads", "swarm", "review", "deploy"];
const ACTION_ORDER = ["prompt.send", "swarm.pause", "swarm.resume", "gate.advance"];
const ACTION_LABELS: Record<string, string> = {
  "prompt.send": "Prompt send",
  "swarm.pause": "Swarm pause",
  "swarm.resume": "Swarm resume",
  "gate.advance": "Gate advance",
};

const state: {
  snapshot: DashboardSnapshot | null;
  socket: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectDelayMs: number;
  reconnectMessageShown: boolean;
  promptCatalog: Map<string, PromptSummary>;
  sentSteps: Map<string, { panes: number[]; label: string; deliveredAt: string }>;
  lastPhase: string | null;
} = {
  snapshot: null,
  socket: null,
  reconnectTimer: null,
  reconnectDelayMs: 1500,
  reconnectMessageShown: false,
  promptCatalog: new Map(),
  sentSteps: new Map<string, { panes: number[]; label: string; deliveredAt: string }>(),
  lastPhase: null,
};

const ui = {
  serverUrl: requireElement("#server-url") as HTMLInputElement,
  wsStatus: requireElement("#ws-status") as HTMLElement,
  reconnectButton: requireElement("#reconnect-button") as HTMLButtonElement,
  refreshButton: requireElement("#refresh-button") as HTMLButtonElement,
  serverMeta: requireElement("#server-meta") as HTMLElement,
  runBadge: requireElement("#run-badge") as HTMLElement,
  guidanceTitle: requireElement("#guidance-title") as HTMLElement,
  guidanceDetail: requireElement("#guidance-detail") as HTMLElement,
  workflowRail: requireElement("#workflow-rail") as HTMLElement,
  metricRun: requireElement("#metric-run") as HTMLElement,
  metricProject: requireElement("#metric-project") as HTMLElement,
  metricPhase: requireElement("#metric-phase") as HTMLElement,
  metricPhaseMeta: requireElement("#metric-phase-meta") as HTMLElement,
  metricSsh: requireElement("#metric-ssh") as HTMLElement,
  metricHost: requireElement("#metric-host") as HTMLElement,
  metricAgents: requireElement("#metric-agents") as HTMLElement,
  metricAgentBreakdown: requireElement("#metric-agent-breakdown") as HTMLElement,
  metricBeads: requireElement("#metric-beads") as HTMLElement,
  metricTopPick: requireElement("#metric-top-pick") as HTMLElement,
  metricVelocity: requireElement("#metric-velocity") as HTMLElement,
  metricPrompts: requireElement("#metric-prompts") as HTMLElement,
  metricSession: requireElement("#metric-session") as HTMLElement,
  errorBanner: requireElement("#error-banner") as HTMLElement,
  agentsUpdated: requireElement("#agents-updated") as HTMLElement,
  agentList: requireElement("#agent-list") as HTMLElement,
  beadSummary: requireElement("#bead-summary") as HTMLElement,
  actionAvailability: requireElement("#action-availability") as HTMLElement,
  promptLibraryMeta: requireElement("#prompt-library-meta") as HTMLElement,
  promptLibrary: requireElement("#prompt-library") as HTMLElement,
  vpsHealth: requireElement("#vps-health") as HTMLElement,
  mailStatus: requireElement("#mail-status") as HTMLElement,
  costPanel: requireElement("#cost-panel") as HTMLElement,
  actionLog: requireElement("#action-log") as HTMLElement,
  promptForm: requireElement("#prompt-form") as HTMLFormElement,
  promptName: requireElement("#prompt-name") as HTMLInputElement,
  promptOptions: requireElement("#prompt-options") as HTMLElement,
  promptPane: requireElement("#prompt-pane") as HTMLInputElement,
  promptAll: requireElement("#prompt-all") as HTMLInputElement,
  promptVars: requireElement("#prompt-vars") as HTMLTextAreaElement,
  promptMeta: requireElement("#prompt-meta") as HTMLElement,
  promptSubmit: requireElement("#prompt-submit") as HTMLButtonElement,
  sessionSummary: requireElement("#session-summary") as HTMLElement,
  pauseButton: requireElement("#pause-button") as HTMLButtonElement,
  resumeButton: requireElement("#resume-button") as HTMLButtonElement,
  swarmControlsNote: requireElement("#swarm-controls-note") as HTMLElement,
  gateForm: requireElement("#gate-form") as HTMLFormElement,
  gatePhase: requireElement("#gate-phase") as HTMLSelectElement,
  gateCheckpoint: requireElement("#gate-checkpoint") as HTMLInputElement,
  gateSubmit: requireElement("#gate-submit") as HTMLButtonElement,
  gateNote: requireElement("#gate-note") as HTMLElement,
  beadProgress: requireElement("#bead-progress") as HTMLElement,
  beadProgressFill: requireElement("#bead-progress-fill") as HTMLElement,
  beadProgressLabel: requireElement("#bead-progress-label") as HTMLElement,
  primaryAction: requireElement("#primary-action") as HTMLElement,
  noActionHint: requireElement("#no-action-hint") as HTMLElement,
  gateNoteDisabled: requireElement("#gate-note-disabled") as HTMLElement,
  phaseSteps: requireElement("#phase-steps") as HTMLElement,
  phaseIntro: requireElement("#phase-intro") as HTMLElement,
};

// ── Prompt constants for phase steps ────────────────────────────────────────

const P_COMBINE_PLANS = `I asked 3 competing LLMs to do the exact same thing and they came up with pretty different plans which you can read below. I want you to REALLY carefully analyze their plans with an open mind and be intellectually honest about what they did that's better than your plan. Then I want you to come up with the best possible revisions to your plan (you should simply update your existing document for your original plan with the revisions) that artfully and skillfully blends the "best of all worlds" to create a true, ultimate, superior hybrid version of the plan that best achieves our stated goals and will work the best in real-world practice to solve the problems we are facing and our overarching goals while ensuring the extreme success of the enterprise as best as possible; you should provide me with a complete series of git-diff style changes to your original plan to turn it into the new, enhanced, much longer and detailed plan that integrates the best of all the plans with every good idea included:`;

const P_100_IDEAS = `OK so now I want you to come up with your top 10 most brilliant ideas for adding extremely powerful and cool functionality that will make this system far more compelling, useful, intuitive, versatile, powerful, robust, reliable, etc for the users. Use /effort max. But be pragmatic and don't think of features that will be extremely hard to implement or which aren't necessarily worth the additional complexity burden they would introduce. But I don't want you to just think of 10 ideas: I want you to seriously think hard and come up with one HUNDRED ideas and then only tell me your 10 VERY BEST and most brilliant, clever, and radically innovative and powerful ideas.`;

const P_CREATE_BEADS = `OK so please take ALL of that and elaborate on it more and then create a comprehensive and granular set of beads for all this with tasks, subtasks, and dependency structure overlaid, with detailed comments so that the whole thing is totally self-contained and self-documenting (including relevant background, reasoning/justification, considerations, etc.-- anything we'd want our "future self" to know about the goals and intentions and thought process and how it serves the over-arching goals of the project.) Use the \`br\` tool repeatedly to create the actual beads. Use /effort max.`;

const P_IMPROVE_BEADS = `Check over each bead super carefully-- are you sure it makes sense? Is it optimal? Could we change anything to make the system work better for users? If so, revise the beads. It's a lot easier and faster to operate in "plan space" before we start implementing these things! Use /effort max.`;

const P_NEW_AGENT = `First read ALL of the AGENTS.md file and README.md file super carefully and understand ALL of both! Then use your code investigation agent mode to fully understand the code, and technical architecture and purpose of the project. Then register with MCP Agent Mail and introduce yourself to the other agents. Be sure to check your agent mail and to promptly respond if needed to any messages; then proceed meticulously with your next assigned beads, working on the tasks systematically and meticulously and tracking your progress via beads and agent mail messages. Don't get stuck in "communication purgatory" where nothing is getting done; be proactive about starting tasks that need to be done, but inform your fellow agents via messages when you do so and mark beads appropriately. When you're not sure what to do next, use the bv tool mentioned in AGENTS.md to prioritize the best beads to work on next; pick the next one that you can usefully work on and get started. Make sure to acknowledge all communication requests from other agents and that you are aware of all active agents and their names. Use /effort max.`;

const P_CHECK_MAIL = `Be sure to check your agent mail and to promptly respond if needed to any messages, and also acknowledge any contact requests; make sure you know the names of all active agents using the MCP Agent Mail system.`;

const P_NEXT_BEAD = `Pick the next bead you can actually do usefully now and start coding on it immediately; communicate what you're working on to your fellow agents and mark beads appropriately as you work. And respond to any agent mail messages you've received.`;

const P_FRESH_REVIEW = `Great, now I want you to carefully read over all of the new code you just wrote and other existing code you just modified with "fresh eyes" looking super carefully for any obvious bugs, errors, problems, issues, confusion, etc. Carefully fix anything you uncover.`;

const P_PEER_REVIEW = `Ok can you now turn your attention to reviewing the code written by your fellow agents and checking for any issues, bugs, errors, problems, inefficiencies, security problems, reliability issues, etc. and carefully diagnose their underlying root causes using first-principle analysis and then fix or revise them if necessary? Don't restrict yourself to the latest commits, cast a wider net and go super deep! Use /effort max.`;

const P_SCRUTINIZE_UI = `Great, now I want you to super carefully scrutinize every aspect of the application workflow and implementation and look for things that just seem sub-optimal or even wrong/mistaken to you, things that could very obviously be improved from a user-friendliness and intuitiveness standpoint, places where our UI/UX could be improved and polished to be slicker, more visually appealing, and more premium feeling and just ultra high quality, like Stripe-level apps.`;

const P_APPLY_UBS = `Read about the ubs tool in AGENTS.md. Now run UBS and investigate and fix literally every single UBS issue once you determine (after reasoned consideration and close inspection) that it's legit.`;

const P_GIT_COMMIT = `Now, based on your knowledge of the project, commit all changed files now in a series of logically connected groupings with super detailed commit messages for each and then push. Take your time to do it right. Don't edit the code at all. Don't commit obviously ephemeral files. Use /effort max.`;

const P_GH_FLOW = `Do all the GitHub stuff: commit, deploy, create tag, bump version, release, monitor gh actions, compute checksums, etc.`;

// ── Phase step types & renderer ─────────────────────────────────────────────

interface PhaseStep {
  title: string;
  detail?: string;
  command?: string;
  promptText?: string;
  promptLabel?: string;
  state: "done" | "current" | "upcoming";
}

function getPhaseSteps(snapshot: DashboardSnapshot): PhaseStep[] {
  const phase = snapshot.run?.phase;
  const agents = snapshot.agents;
  const beads = snapshot.beads;
  const gateEnabled = snapshot.actionStates["gate.advance"]?.enabled ?? false;
  const hasAgents = agents.length > 0;

  const stepKey = (idx: number) => `${phase ?? "none"}:${idx}`;
  const isSent = (idx: number) => state.sentSteps.has(stepKey(idx));

  function stepState(idx: number, fallback: "current" | "upcoming"): "done" | "current" | "upcoming" {
    if (isSent(idx)) return "done";
    for (let i = 0; i < idx; i++) {
      if (!isSent(i)) return "upcoming";
    }
    return fallback;
  }

  if (!snapshot.run) {
    const sshOk = snapshot.ssh.connected;
    return [
      {
        title: "Connect to your VPS",
        detail: sshOk
          ? `Connected to ${snapshot.ssh.host ?? "your server"} ✓`
          : "Tell the console where your ACFS server is. You'll need your server IP address, SSH username, and private key path.",
        command: "flywheel settings ssh",
        state: isSent(0) ? "done" : sshOk ? "done" : "current",
      },
      {
        title: "Start your first project",
        detail: "Describe what you want to build. The planning wizard will ask three AI models to plan it in parallel, then synthesize their best ideas.",
        command: 'flywheel new "describe what you want to build"',
        state: stepState(1, sshOk ? "current" : "upcoming"),
      },
    ];
  }

  if (phase === "plan") {
    return [
      {
        title: "Ask three AI models to plan your project",
        detail: "Open ChatGPT (GPT-4o or newer), Claude.ai (Opus), and Google Gemini. Give each one the same description of what you want to build. Don't worry about perfection — you're collecting three different perspectives.",
        state: stepState(0, "current"),
      },
      {
        title: "Synthesize: combine the best of all three plans",
        detail: "Paste all three plans back into your primary AI with this prompt. It will honestly compare them, take the best ideas from each, and produce a single superior plan.",
        promptText: P_COMBINE_PLANS,
        promptLabel: "Copy combine_plans prompt",
        state: stepState(1, "upcoming"),
      },
      {
        title: "Generate brilliant feature ideas",
        detail: "This prompt forces the AI to think of 100 ideas before picking the best 10 — much better than asking for 10 directly. Run it 2-3 times for compounding results.",
        promptText: P_100_IDEAS,
        promptLabel: "Copy 100_ideas prompt",
        state: stepState(2, "upcoming"),
      },
      {
        title: "Run the local planning wizard",
        detail: "This orchestrates the multi-model planning automatically and saves a plan.md file. Run it after you have your synthesized plan ready.",
        command: 'flywheel new "your idea"',
        state: stepState(3, "upcoming"),
      },
      {
        title: "Advance to task breakdown (Beads)",
        detail: gateEnabled
          ? "Your plan looks good. When you're ready to break it into tasks, advance the gate below."
          : "Complete the planning steps above, then advance the gate to move to the task breakdown phase.",
        state: stepState(4, gateEnabled ? "current" : "upcoming"),
      },
    ];
  }

  if (phase === "beads") {
    return [
      {
        title: "Generate tasks (beads) from your plan",
        detail: "Beads are granular tasks with dependencies — like a smart to-do list. This prompt creates them automatically from your plan, with enough context in each task that an agent can work on it independently without needing to re-read the whole plan.",
        promptText: P_CREATE_BEADS,
        promptLabel: "Copy create_beads prompt",
        state: stepState(0, "current"),
      },
      {
        title: "Review and refine the task breakdown",
        detail: "It's much cheaper to fix issues in task-space than code-space. This prompt reviews every bead for clarity, feasibility, and optimal sequencing — and revises them. Do this before any code is written.",
        promptText: P_IMPROVE_BEADS,
        promptLabel: "Copy improve_beads prompt",
        state: stepState(1, "upcoming"),
      },
      {
        title: "Analyze task priorities with Beads Viewer",
        detail: "bv uses PageRank to score which tasks are most important (blocking the most other tasks). Run this to see your critical path — the sequence of tasks that determines your minimum ship date.",
        command: "bv --robot-triage",
        state: stepState(2, "upcoming"),
      },
      {
        title: "Advance to the implementation swarm",
        detail: gateEnabled
          ? "Task breakdown looks good. When you're ready to start coding, advance the gate."
          : "Finalize your beads above, then advance the gate to start spawning agents.",
        state: stepState(3, gateEnabled ? "current" : "upcoming"),
      },
    ];
  }

  if (phase === "swarm") {
    const stuck = agents.filter((a) => a.status === "stuck");
    const beadsDone = beads && beads.open === 0 && beads.inProgress === 0 && beads.closed > 0;
    const etaPart = beads && typeof beads.etaHours === "number" && beads.etaHours > 0
      ? ` · ETA ${beads.etaHours < 1 ? `${Math.round(beads.etaHours * 60)}m` : `${beads.etaHours.toFixed(1)}h`}`
      : "";

    const step3Title = stuck.length > 0
      ? `${stuck.length} agent${stuck.length === 1 ? "" : "s"} stuck — needs your attention`
      : beadsDone
        ? "All tasks complete ✓"
        : `Agents working${beads ? ` · ${beads.closed}/${beads.total} tasks done${etaPart}` : ""}`;

    const step3Detail = stuck.length > 0
      ? `Pane${stuck.length === 1 ? "" : "s"} ${stuck.map((a) => a.pane).join(", ")} ${stuck.length === 1 ? "hasn't" : "haven't"} changed recently. Send this prompt to check for messages from other agents and pick the next task — often this unsticks them.`
      : beadsDone
        ? "Every task is closed. Review the work, then advance to the review phase."
        : beads?.topRecommendation
          ? `Highest priority open task: ${beads.topRecommendation.id} — ${beads.topRecommendation.title}`
          : "Monitor the agent panel below. If an agent shows as 'stuck', send it the next_bead prompt.";

    return [
      {
        title: "Spawn AI agents on your VPS",
        detail: hasAgents
          ? `${agents.length} agent${agents.length === 1 ? "" : "s"} running in NTM (tmux panes on the VPS)`
          : "NTM (Node Tmux Manager) creates terminal panes on your VPS — one per agent. Each agent is a Claude, Codex, or Gemini instance. Start with 4-8 agents; scale up as you see results.",
        command: "flywheel swarm 6",
        state: isSent(0) ? "done" : hasAgents ? "done" : "current",
      },
      {
        title: "Initialize each agent",
        detail: hasAgents
          ? "Agents have read AGENTS.md and registered with Agent Mail"
          : "Copy this prompt into each agent pane. It tells the agent to read your project docs, register an identity with Agent Mail (so agents can coordinate), and start picking up tasks from your bead list.",
        promptText: P_NEW_AGENT,
        promptLabel: "Copy new_agent prompt",
        state: stepState(1, hasAgents ? "current" : "upcoming"),
      },
      {
        title: step3Title,
        detail: step3Detail,
        promptText: stuck.length > 0 ? P_CHECK_MAIL : P_NEXT_BEAD,
        promptLabel: stuck.length > 0 ? "Copy check_mail prompt" : "Copy next_bead prompt",
        state: stepState(2, hasAgents ? "current" : "upcoming"),
      },
      {
        title: "Advance to review",
        detail: beadsDone
          ? "All tasks are closed. When you're satisfied with the work, advance to the review phase."
          : "This step becomes available when all tasks (beads) are closed.",
        state: stepState(3, beadsDone && gateEnabled ? "current" : "upcoming"),
      },
    ];
  }

  if (phase === "review") {
    return [
      {
        title: hasAgents ? "Fresh review — catch bugs the author missed" : "Spawn agents for review",
        detail: hasAgents
          ? "Each agent re-reads the code they just wrote with 'fresh eyes' — a different mental context than when writing. This catches a surprising number of bugs. Send to every agent."
          : "Spawn a few agents (even 2-3 is enough for review). They'll review the work done in the swarm phase.",
        command: hasAgents ? undefined : "flywheel swarm 3",
        promptText: hasAgents ? P_FRESH_REVIEW : undefined,
        promptLabel: hasAgents ? "Copy fresh_review prompt" : undefined,
        state: stepState(0, "current"),
      },
      {
        title: "Peer review — agents check each other's code",
        detail: "Each agent reviews code written by the other agents, not their own. Different agents have different blind spots — this cross-review catches issues that fresh review misses.",
        promptText: P_PEER_REVIEW,
        promptLabel: "Copy check_other_agents prompt",
        state: stepState(1, "upcoming"),
      },
      {
        title: "UI/UX scrutiny — polish to Stripe-level quality",
        detail: "Send to your most capable agent (Claude Opus or GPT-4o). It will go through the entire user-facing experience looking for anything that feels off — unclear interactions, visual rough edges, confusing flows.",
        promptText: P_SCRUTINIZE_UI,
        promptLabel: "Copy scrutinize_ui prompt",
        state: stepState(2, "upcoming"),
      },
      {
        title: "UBS scan — systematic bug detection",
        detail: "UBS (Ultimate Bug Scanner) runs a structured sweep across the entire codebase looking for common error patterns, security issues, and edge cases. More thorough than a manual review.",
        promptText: P_APPLY_UBS,
        promptLabel: "Copy apply_ubs prompt",
        state: stepState(3, "upcoming"),
      },
      {
        title: "Advance to deploy",
        detail: gateEnabled
          ? "Review passes are complete. When you're satisfied with code quality, advance to deploy."
          : "Run the review passes above, then advance the gate when you're satisfied.",
        state: stepState(4, gateEnabled ? "current" : "upcoming"),
      },
    ];
  }

  if (phase === "deploy") {
    return [
      {
        title: "Commit in logical, well-described groups",
        detail: "Rather than one giant commit, this prompt groups changes by feature or concern and writes detailed commit messages for each group. This makes the git history readable and reversible.",
        promptText: P_GIT_COMMIT,
        promptLabel: "Copy git_commit prompt",
        state: stepState(0, "current"),
      },
      {
        title: "Run the full GitHub deployment flow",
        detail: "Creates a version tag, bumps the version number, drafts a release, monitors GitHub Actions, and computes checksums. One prompt handles the whole release pipeline.",
        promptText: P_GH_FLOW,
        promptLabel: "Copy gh_flow prompt",
        state: stepState(1, "upcoming"),
      },
      {
        title: "Deploy",
        detail: "The CLI will ask you to type DEPLOY <project-name> to confirm — a deliberate step to prevent accidental deploys. This is the final action.",
        command: "flywheel deploy",
        state: stepState(2, "upcoming"),
      },
    ];
  }

  return [];
}

function renderPhaseIntro(snapshot: DashboardSnapshot): void {
  const phase = snapshot.run?.phase;
  const fragment = document.createDocumentFragment();

  const eyebrow = document.createElement("p");
  eyebrow.className = "phase-intro-eyebrow";

  const heading = document.createElement("h2");
  heading.className = "phase-intro-heading";

  const body = document.createElement("p");
  body.className = "phase-intro-body";

  if (!snapshot.run) {
    eyebrow.textContent = "Getting started";
    heading.textContent = "Welcome to Flywheel Console";
    body.textContent = "This dashboard orchestrates AI coding agents on your remote VPS. Agents pick up tasks, write code, and coordinate automatically — you supervise and steer. Let's get connected first.";
  } else if (phase === "plan") {
    eyebrow.textContent = "Phase 1 of 5 · Planning";
    heading.textContent = "Build a better plan than any single AI can";
    body.textContent = "Before writing any code, you'll ask three AI models to plan your project independently. Each model thinks differently and catches different things. Then you synthesize their best ideas into one superior plan.";
  } else if (phase === "beads") {
    eyebrow.textContent = "Phase 2 of 5 · Task breakdown";
    heading.textContent = "Break your plan into work agents can pick up";
    body.textContent = "Beads are granular tasks with explicit dependencies — like a smart to-do list that agents can claim, work on, and complete independently. A good bead set lets multiple agents work in parallel without stepping on each other.";
  } else if (phase === "swarm") {
    const agentCount = snapshot.agents.length;
    eyebrow.textContent = "Phase 3 of 5 · Implementation";
    heading.textContent = agentCount > 0
      ? `${agentCount} agent${agentCount === 1 ? "" : "s"} building your project`
      : "Ready to launch your AI agent swarm";
    body.textContent = agentCount > 0
      ? "Each agent reads your AGENTS.md, picks up the next available bead, and works on it. They coordinate through Agent Mail so they don't overwrite each other. Your job is to monitor progress and unblock stuck agents."
      : "You'll spawn multiple AI agents via NTM (a tmux session manager). Each agent runs in its own terminal pane on the VPS, claims tasks from your bead list, and reports progress through Agent Mail.";
  } else if (phase === "review") {
    eyebrow.textContent = "Phase 4 of 5 · Review";
    heading.textContent = "Agents review and polish each other's work";
    body.textContent = "Send structured review prompts to your agents. Fresh review catches bugs the author missed. Peer review catches issues across the whole codebase. UBS (Ultimate Bug Scanner) does a systematic sweep. Each pass makes the code significantly better.";
  } else if (phase === "deploy") {
    eyebrow.textContent = "Phase 5 of 5 · Deploy";
    heading.textContent = "Ship it";
    body.textContent = "Commit the work in logical groups with detailed messages, run the full GitHub deployment flow, then deploy. The CLI requires you to type DEPLOY <project-name> explicitly — a deliberate confirmation step before anything goes live.";
  } else {
    eyebrow.textContent = "Active run";
    heading.textContent = `Phase: ${phase ?? "unknown"}`;
    body.textContent = "Dashboard is live. Use the steps below to steer the current run.";
  }

  fragment.append(eyebrow, heading, body);
  ui.phaseIntro.replaceChildren(fragment);
}

async function sendStepPrompt(
  snapshot: DashboardSnapshot,
  promptText: string,
  stepKey: string,
  stepLabel: string,
  pane: number | "all"
): Promise<void> {
  const payload: Record<string, unknown> = {
    type: "prompt.send",
    promptText,
    ...(pane === "all" ? { all: true } : { pane }),
  };

  const result = await postAction(payload);
  if (result.ok) {
    const panes = pane === "all"
      ? snapshot.agents.map((a: AgentStatus) => a.pane)
      : [pane as number];
    state.sentSteps.set(stepKey, {
      panes,
      label: stepLabel,
      deliveredAt: new Date().toISOString(),
    });
    logAction(`Sent "${stepLabel}" to ${pane === "all" ? "all agents" : `pane ${pane}`}`);
    await fetchSnapshot(); // triggers re-render via applySnapshot
  } else {
    logAction(`Failed to send "${stepLabel}": ${result.error ?? "unknown error"}`, true);
  }
}

function renderPhaseSteps(snapshot: DashboardSnapshot): void {
  const steps = getPhaseSteps(snapshot);
  const fragment = document.createDocumentFragment();

  for (const step of steps) {
    const el = document.createElement("div");
    el.className = `phase-step phase-step--${step.state}`;

    const badge = document.createElement("div");
    badge.className = "phase-step-badge";
    badge.textContent = step.state === "done" ? "✓" : step.state === "current" ? "▶" : String(steps.indexOf(step) + 1);

    const body = document.createElement("div");
    body.className = "phase-step-body";

    const title = document.createElement("div");
    title.className = "phase-step-title";
    title.textContent = step.title;
    body.append(title);

    if (step.detail) {
      const detail = document.createElement("div");
      detail.className = "phase-step-detail";
      detail.textContent = step.detail;
      body.append(detail);
    }

    const stepIdx = steps.indexOf(step);
    const sk = `${snapshot.run?.phase ?? "none"}:${stepIdx}`;
    const sentEntry = state.sentSteps.get(sk);

    if (sentEntry) {
      // Show delivery confirmation
      const result = document.createElement("div");
      result.className = "step-send-result";
      const paneStatuses = sentEntry.panes.map(pNum => {
        const agent = snapshot.agents.find((a: AgentStatus) => a.pane === pNum);
        const statusClass = agent?.status === "active" ? "step-dot--active"
          : agent?.status === "stuck" ? "step-dot--stuck" : "step-dot--idle";
        return `<span class="step-agent-dot ${statusClass}"></span> pane ${pNum}${agent?.type ? ` (${agent.type})` : ""}`;
      });
      result.innerHTML = `Delivered to ${sentEntry.panes.join(", ")} · ${formatRelative(sentEntry.deliveredAt)}<br>
    <span class="step-agent-status">${paneStatuses.join(" &nbsp; ")}</span>`;
      body.append(result);
    } else if ((step.promptText || step.command) && step.state !== "done") {
      const actions = document.createElement("div");
      actions.className = "phase-step-actions";

      if (step.promptText) {
        // Build agent pills
        const pills = document.createElement("div");
        pills.className = "agent-pills";

        if (snapshot.agents.length > 0) {
          // "All" pill
          const allPill = document.createElement("button");
          allPill.className = "agent-pill agent-pill--all";
          allPill.type = "button";
          allPill.textContent = "All agents";
          const pt = step.promptText;
          const sl = step.title;
          const snap = snapshot;
          allPill.onclick = async () => {
            allPill.disabled = true;
            await sendStepPrompt(snap, pt, sk, sl, "all");
            allPill.disabled = false;
          };
          pills.append(allPill);

          // Per-pane pills
          for (const agent of snapshot.agents) {
            const pill = document.createElement("button");
            const statusClass = agent.status === "active" ? "dot--active"
              : agent.status === "stuck" ? "dot--stuck" : "dot--idle";
            pill.className = `agent-pill`;
            pill.type = "button";
            pill.innerHTML = `<span class="agent-pill-dot ${statusClass}"></span> pane ${agent.pane}${agent.type ? ` <span class="agent-pill-type">${agent.type}</span>` : ""}`;
            const ptCopy = step.promptText;
            const slCopy = step.title;
            const snapCopy = snapshot;
            const pane = agent.pane;
            pill.onclick = async () => {
              pill.disabled = true;
              await sendStepPrompt(snapCopy, ptCopy, sk, slCopy, pane);
              pill.disabled = false;
            };
            pills.append(pill);
          }
        } else {
          // No agents — show a note
          const note = document.createElement("p");
          note.className = "step-no-agents";
          note.textContent = "No agents running yet — spawn agents first.";
          pills.append(note);
        }

        actions.append(pills);
      }

      if (step.command) {
        // Keep clipboard copy for shell commands
        const btn = document.createElement("button");
        btn.className = "step-cmd";
        btn.type = "button";
        btn.textContent = step.command;
        const cmd = step.command;
        btn.onclick = () => {
          void navigator.clipboard.writeText(cmd).then(() => {
            btn.classList.add("copied");
            btn.textContent = "Copied!";
            setTimeout(() => { btn.classList.remove("copied"); btn.textContent = cmd; }, 2000);
          });
        };
        actions.append(btn);
      }

      body.append(actions);
    }

    el.append(badge, body);
    fragment.append(el);
  }

  ui.phaseSteps.replaceChildren(fragment);
}

initialize();

function initialize() {
  hydrateServerUrl();
  bindEvents();
  syncPaneFieldState();
  void bootstrapInitialState();
}

async function bootstrapInitialState() {
  try {
    await fetchSnapshot();
    await connect();
  } catch (error) {
    logAction(`Dashboard bootstrap failed: ${describeError(error)}`, true);
  }
}

function bindEvents() {
  ui.serverUrl.onchange = () => {
    const value = ui.serverUrl.value.trim();
    if (value) {
      localStorage.setItem(STORAGE_SERVER_URL, value);
    }
  };

  ui.reconnectButton.onclick = () => {
    clearReconnectTimer();
    void connect();
  };

  ui.refreshButton.onclick = () => {
    void fetchSnapshot();
  };

  ui.promptAll.onchange = () => {
    syncPaneFieldState();
  };

  ui.promptName.oninput = () => {
    updatePromptMeta();
  };

  ui.promptForm.onsubmit = (event) => {
    event.preventDefault();

    const promptName = ui.promptName.value.trim();
    if (!promptName) {
      logAction("Prompt name is required.", true);
      return;
    }

    if (state.promptCatalog.size > 0 && !state.promptCatalog.has(promptName)) {
      logAction(`Unknown prompt "${promptName}". Pick one from the prompt library.`, true);
      return;
    }

    const payload: Record<string, unknown> = {
      type: "prompt.send",
      promptName,
      all: ui.promptAll.checked,
    };

    if (!ui.promptAll.checked) {
      const pane = Number.parseInt(ui.promptPane.value.trim(), 10);
      if (!Number.isInteger(pane) || pane <= 0) {
        logAction("Target pane must be a positive integer, or choose broadcast.", true);
        return;
      }
      payload["pane"] = pane;
    }

    const parsed = parseVariables(ui.promptVars.value);
    if (parsed.invalidLines.length > 0) {
      logAction(
        `Prompt variables contain invalid line(s): ${parsed.invalidLines.join(", ")}. Expected key=value format.`,
        true
      );
      return;
    }

    if (Object.keys(parsed.variables).length > 0) {
      payload["variables"] = parsed.variables;
    }

    void runAction(payload, ui.promptSubmit);
  };

  ui.pauseButton.onclick = () => {
    void runAction({ type: "swarm.pause" }, ui.pauseButton);
  };

  ui.resumeButton.onclick = () => {
    void runAction({ type: "swarm.resume" }, ui.resumeButton);
  };

  ui.gateForm.onsubmit = (event) => {
    event.preventDefault();

    const nextPhase = ui.gatePhase.value;
    if (!nextPhase) {
      logAction("Choose a target phase before advancing the gate.", true);
      return;
    }

    const payload: Record<string, unknown> = {
      type: "gate.advance",
      nextPhase,
    };

    const checkpointSha = ui.gateCheckpoint.value.trim();
    if (checkpointSha) {
      payload["checkpointSha"] = checkpointSha;
    }

    void runAction(payload, ui.gateSubmit);
  };

  ui.promptLibrary.onclick = (event) => {
    const target = event.target instanceof Element ? event.target.closest("button[data-prompt-name]") : null;
    if (!(target instanceof HTMLButtonElement)) {
      return;
    }

    ui.promptName.value = target.dataset["promptName"] ?? "";
    updatePromptMeta();
  };
}

function hydrateServerUrl() {
  const saved = localStorage.getItem(STORAGE_SERVER_URL);
  if (saved) {
    ui.serverUrl.value = saved;
  }
}

async function fetchSnapshot() {
  const baseUrl = normalizedBaseUrl();

  try {
    const response = await fetch(`${baseUrl}/snapshot`, {
      cache: "no-store",
    });

    if (!response.ok) {
      logAction(`Snapshot fetch failed: ${response.status} ${response.statusText}`, true);
      return;
    }

    const snapshot = await response.json();
    applySnapshot(snapshot as DashboardSnapshot);
  } catch (error) {
    logAction(`Snapshot fetch failed: ${describeError(error)}`, true);
  }
}

async function connect() {
  if (state.socket) {
    state.socket.onclose = null;
    state.socket.close();
    state.socket = null;
  }

  clearReconnectTimer();

  const baseUrl = normalizedBaseUrl();
  const wsUrl = baseUrl.replace(/^http/i, "ws") + "/ws";

  setWsStatus("Connecting", "status-idle");

  try {
    const socket = new WebSocket(wsUrl);
    state.socket = socket;

    socket.onopen = () => {
      state.reconnectDelayMs = 1500;
      state.reconnectMessageShown = false;
      setWsStatus("Live", "status-live");
      logAction(`Connected to ${wsUrl}`);
    };

    socket.onmessage = (event) => {
      let data: { type: string; payload?: unknown; ok?: boolean; action?: string; error?: string };
      try {
        data = JSON.parse(event.data as string) as typeof data;
      } catch {
        logAction("Received malformed WebSocket payload.", true);
        return;
      }

      if (data.type === "snapshot") {
        applySnapshot(data.payload as DashboardSnapshot);
        return;
      }

      if (data.type === "action_result") {
        if (data.ok) {
          logAction(`Action ${data.action} succeeded`);
        } else {
          logAction(`Action failed: ${data.error ?? "unknown error"}`, true);
        }
      }
    };

    socket.onerror = () => {
      setWsStatus("Error", "status-error");
    };

    socket.onclose = () => {
      setWsStatus("Disconnected", "status-error");
      scheduleReconnect();
    };
  } catch (error) {
    setWsStatus("Error", "status-error");
    logAction(`WebSocket failed to initialize: ${describeError(error)}`, true);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (state.reconnectTimer) {
    return;
  }

  if (!state.reconnectMessageShown) {
    logAction("WebSocket disconnected. Reconnect retry is scheduled.", true);
    state.reconnectMessageShown = true;
  }

  const waitMs = state.reconnectDelayMs;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connect();
  }, waitMs);

  state.reconnectDelayMs = Math.min(Math.round(state.reconnectDelayMs * 1.6), 15000);
}

function clearReconnectTimer() {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

async function runAction(payload: Record<string, unknown>, triggerButton: HTMLButtonElement | null) {
  if (triggerButton) {
    triggerButton.disabled = true;
    triggerButton.classList.add("is-busy");
  }

  try {
    const result = await postAction(payload);
    if (result.ok) {
      logAction(`Action ${payload["type"]} succeeded`);
      await fetchSnapshot();
      return;
    }

    logAction(`Action ${payload["type"]} failed: ${result.error ?? "unknown error"}`, true);
  } catch (error) {
    logAction(`Action ${payload["type"]} failed: ${describeError(error)}`, true);
  } finally {
    if (triggerButton) {
      triggerButton.classList.remove("is-busy");
    }

    if (state.snapshot) {
      syncControls(state.snapshot);
    } else if (triggerButton) {
      triggerButton.disabled = false;
    }
  }
}

async function postAction(payload: Record<string, unknown>): Promise<{ ok: boolean; action?: string; error?: string }> {
  const baseUrl = normalizedBaseUrl();
  try {
    const response = await fetch(`${baseUrl}/action`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    let data: { ok: boolean; action?: string; error?: string };
    try {
      data = await response.json() as typeof data;
    } catch {
      data = { ok: false, error: `${response.status} ${response.statusText}` };
    }

    if (!response.ok && data.ok !== false) {
      return {
        ok: false,
        error: `${response.status} ${response.statusText}`,
      };
    }

    return data;
  } catch (error) {
    return {
      ok: false,
      error: `Failed to post action: ${describeError(error)}`,
    };
  }
}

function applySnapshot(snapshot: DashboardSnapshot) {
  state.snapshot = snapshot;

  // Clear sent-steps tracking when the phase changes
  const currentPhase = snapshot.run?.phase ?? null;
  if (currentPhase !== state.lastPhase) {
    state.sentSteps.clear();
    state.lastPhase = currentPhase;
  }

  ui.serverMeta.textContent = `Server ${snapshot.server.host}:${snapshot.server.port} · Snapshot ${formatTimestamp(
    snapshot.generatedAt
  )}`;

  ui.metricRun.textContent = snapshot.run ? shortenId(snapshot.run.id) : "—";
  ui.metricProject.textContent = snapshot.run
    ? `Project ${snapshot.run.projectName}`
    : snapshot.server.remoteProjectPath
      ? `Remote ${snapshot.server.remoteProjectPath}`
      : "Project unavailable";

  ui.metricPhase.textContent = snapshot.run ? snapshot.run.phase : "—";
  ui.metricPhaseMeta.textContent = snapshot.run
    ? snapshot.run.gatePassedAt
      ? `Last gate pass ${formatRelative(snapshot.run.gatePassedAt)}`
      : "Gate not passed yet"
    : "No run selected";

  ui.metricSsh.textContent = snapshot.ssh.connected ? "Connected" : "Disconnected";
  ui.metricHost.textContent = `Host ${snapshot.ssh.host ?? "unknown"}`;

  const agentSummary = summarizeAgents(snapshot.agents);
  ui.metricAgents.textContent = String(snapshot.agents.length);
  ui.metricAgentBreakdown.textContent = `active ${agentSummary.active} · idle ${agentSummary.idle} · stuck ${agentSummary.stuck}`;

  ui.metricPrompts.textContent = String(snapshot.prompts.length);
  ui.metricSession.textContent = `Session ${snapshot.server.sessionName}`;
  renderMemoryPanel(snapshot);
  renderPhaseIntro(snapshot);
  renderPhaseSteps(snapshot);
  renderBeadProgress(snapshot.beads, snapshot.run?.phase);

  if (snapshot.beads) {
    ui.metricBeads.textContent = `${snapshot.beads.closed}/${snapshot.beads.total}`;
    ui.metricTopPick.textContent = snapshot.beads.topRecommendation
      ? `Top pick ${snapshot.beads.topRecommendation.id}`
      : "Top pick unavailable";
    ui.metricVelocity.textContent =
      typeof snapshot.beads.velocityPerHour === "number" && snapshot.beads.velocityPerHour > 0
        ? `Velocity ${snapshot.beads.velocityPerHour.toFixed(2)}/hr · ETA ${formatEta(snapshot.beads.etaHours)}`
        : "Velocity gathering";
  } else {
    ui.metricBeads.textContent = "—";
    ui.metricTopPick.textContent = "Top pick unavailable";
    ui.metricVelocity.textContent = "Velocity unavailable";
  }

  applyGuidance(snapshot);
  renderWorkflowRail(snapshot.run?.phase);
  renderError(snapshot.lastError);
  renderAgents(snapshot.agents);
  renderBeads(snapshot.beads);
  renderActionAvailability(snapshot);
  renderPromptLibrary(snapshot.prompts);
  renderVpsHealth(snapshot.vpsHealth);
  renderMail(snapshot.mail);

  ui.agentsUpdated.textContent = `Updated ${formatTimestamp(snapshot.generatedAt)}`;

  syncControls(snapshot);
  void fetchCost();
}

function applyGuidance(snapshot: DashboardSnapshot) {
  ui.guidanceTitle.textContent = snapshot.guidance.title;
  ui.guidanceDetail.textContent = snapshot.guidance.detail;

  if (!snapshot.run) {
    ui.runBadge.textContent = "No run";
    ui.runBadge.className = "status-pill status-subtle";
    return;
  }

  if (snapshot.lastError) {
    ui.runBadge.textContent = "Attention";
    ui.runBadge.className = "status-pill status-error";
    return;
  }

  if (!snapshot.ssh.connected) {
    ui.runBadge.textContent = "Degraded";
    ui.runBadge.className = "status-pill status-idle";
    return;
  }

  ui.runBadge.textContent = snapshot.run.phase;
  ui.runBadge.className = "status-pill status-live";
}

function renderError(lastError: string | undefined) {
  if (!lastError) {
    ui.errorBanner.classList.add("hidden");
    ui.errorBanner.textContent = "";
    return;
  }

  ui.errorBanner.classList.remove("hidden");
  ui.errorBanner.textContent = `Latest server error: ${lastError}`;
}

function renderWorkflowRail(currentPhase: Phase | undefined) {
  const currentIndex = currentPhase ? PHASES.indexOf(currentPhase) : -1;
  const fragment = document.createDocumentFragment();

  for (const [index, phase] of PHASES.entries()) {
    const step = document.createElement("div");
    step.className = "workflow-step";

    if (index === currentIndex) {
      step.classList.add("workflow-step-current");
    } else if (currentIndex >= 0 && index < currentIndex) {
      step.classList.add("workflow-step-complete");
    }

    step.textContent = phase;
    fragment.append(step);
  }

  ui.workflowRail.replaceChildren(fragment);
}

function renderAgents(agents: AgentStatus[]) {
  if (!agents.length) {
    replaceWithEmpty(ui.agentList, "No agent status available yet.");
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const agent of agents) {
    const row = document.createElement("article");
    row.className = "agent-row";

    const copy = document.createElement("div");

    const title = document.createElement("p");
    title.className = "agent-title";
    title.textContent = `Pane ${agent.pane} · ${agent.title ?? agent.command ?? "unknown"}${
      agent.currentBead ? ` · ${agent.currentBead}` : ""
    }`;

    const meta = document.createElement("p");
    meta.className = "agent-meta";
    meta.textContent = `${agent.type ?? "unknown"} · last activity ${formatRelative(agent.lastActivity)}`;

    const pill = document.createElement("span");
    pill.className = `status-pill ${statusClass(agent.status)}`;
    pill.textContent = agent.status;

    copy.append(title, meta);
    row.append(copy, pill);
    fragment.append(row);
  }

  ui.agentList.replaceChildren(fragment);
}

function renderBeads(beads: BeadSummary | null) {
  if (!beads) {
    replaceWithEmpty(ui.beadSummary, "Bead polling is waiting for a remote project path.");
    return;
  }

  const fragment = document.createDocumentFragment();
  const rows: [string, string][] = [
    ["Total", String(beads.total)],
    ["Open", String(beads.open)],
    ["In Progress", String(beads.inProgress)],
    ["Closed", String(beads.closed)],
    ["Blocked", String(beads.blocked)],
    ["Velocity", formatVelocity(beads.velocityPerHour)],
    ["ETA", formatEta(beads.etaHours)],
  ];

  for (const [label, value] of rows) {
    const row = document.createElement("article");
    row.className = "stat-line";

    const span = document.createElement("span");
    span.textContent = label;

    const strong = document.createElement("strong");
    strong.textContent = value;

    row.append(span, strong);
    fragment.append(row);
  }

  const callout = document.createElement("article");
  callout.className = "callout";

  const calloutLabel = document.createElement("p");
  calloutLabel.className = "callout-label";
  calloutLabel.textContent = "Top recommendation";

  const strong = document.createElement("strong");
  strong.textContent = beads.topRecommendation?.title ?? "Unavailable";

  const text = document.createElement("p");
  text.textContent = beads.topRecommendation?.id ?? "No triage recommendation yet";

  callout.append(calloutLabel, strong, text);
  fragment.append(callout);

  ui.beadSummary.replaceChildren(fragment);
}

function renderActionAvailability(snapshot: DashboardSnapshot) {
  const actionStates = snapshot.actionStates ?? {};
  const supported = new Set(snapshot.actions ?? []);
  const fragment = document.createDocumentFragment();

  for (const action of ACTION_ORDER) {
    const stateForAction = actionStates[action as keyof typeof actionStates] ?? { enabled: false };
    const isSupported = supported.has(action as keyof typeof actionStates);
    const enabled = isSupported && stateForAction.enabled;
    const status = enabled ? "ready" : "blocked";
    const reason = !isSupported
      ? "Not supported by this runtime."
      : stateForAction.reason ?? "Ready";

    const row = document.createElement("article");
    row.className = "availability-row";

    const copy = document.createElement("div");
    const title = document.createElement("p");
    title.className = "availability-title";
    title.textContent = ACTION_LABELS[action] ?? action;

    const description = document.createElement("p");
    description.className = "availability-reason";
    description.textContent = reason;

    const pill = document.createElement("span");
    pill.className = `status-pill ${enabled ? "status-live" : "status-idle"}`;
    pill.textContent = status;

    copy.append(title, description);
    row.append(copy, pill);
    fragment.append(row);
  }

  ui.actionAvailability.replaceChildren(fragment);
}

function renderPromptLibrary(prompts: PromptSummary[]) {
  state.promptCatalog = new Map(prompts.map((prompt) => [prompt.name, prompt]));

  const optionFragment = document.createDocumentFragment();
  for (const prompt of prompts) {
    const option = document.createElement("option");
    option.value = prompt.name;
    optionFragment.append(option);
  }
  ui.promptOptions.replaceChildren(optionFragment);

  if (!prompts.length) {
    ui.promptLibraryMeta.textContent = "No prompts loaded from prompts.yaml";
    replaceWithEmpty(ui.promptLibrary, "Prompt library is empty.");
    updatePromptMeta();
    return;
  }

  ui.promptLibraryMeta.textContent = `${prompts.length} prompt${prompts.length === 1 ? "" : "s"} loaded`;

  const selected = ui.promptName.value.trim();
  const fragment = document.createDocumentFragment();
  for (const prompt of prompts) {
    const button = document.createElement("button");
    button.className = "prompt-chip";
    if (selected === prompt.name) {
      button.classList.add("prompt-chip-active");
    }
    button.type = "button";
    button.dataset["promptName"] = prompt.name;

    const name = document.createElement("span");
    name.className = "prompt-chip-name";
    name.textContent = prompt.name;

    const meta = document.createElement("span");
    meta.className = "prompt-chip-meta";
    meta.textContent = `${prompt.phase} · ${prompt.model} · ${prompt.effort}`;

    button.append(name, meta);
    fragment.append(button);
  }

  ui.promptLibrary.replaceChildren(fragment);
  updatePromptMeta();
}

function updatePromptMeta() {
  const selected = ui.promptName.value.trim();
  for (const chip of ui.promptLibrary.querySelectorAll(".prompt-chip")) {
    const isActive = (chip as HTMLElement).dataset["promptName"] === selected;
    chip.classList.toggle("prompt-chip-active", isActive);
  }

  if (!selected) {
    ui.promptMeta.textContent = "Select a prompt to see its routing metadata.";
    return;
  }

  const prompt = state.promptCatalog.get(selected);
  if (!prompt) {
    ui.promptMeta.textContent = "Unknown prompt. Pick an item from Available prompts.";
    return;
  }

  ui.promptMeta.textContent = `Phase ${prompt.phase} · Model ${prompt.model} · Effort ${prompt.effort}`;
}

function renderVpsHealth(vpsHealth: VpsHealth | null) {
  if (!vpsHealth) {
    replaceWithEmpty(ui.vpsHealth, "Waiting for VPS health samples.");
    return;
  }

  const fragment = document.createDocumentFragment();
  const healthRows: [string, string][] = [
    ["Uptime", vpsHealth.uptime],
    ["Memory", vpsHealth.memory],
    ["Disk", vpsHealth.disk],
  ];
  for (const [label, value] of healthRows) {
    const card = document.createElement("article");
    card.className = "health-card";

    const heading = document.createElement("p");
    heading.className = "callout-label";
    heading.textContent = label;

    const pre = document.createElement("pre");
    pre.textContent = value;

    card.append(heading, pre);
    fragment.append(card);
  }

  ui.vpsHealth.replaceChildren(fragment);
}

function renderMail(mail: MailStatus) {
  const callout = document.createElement("article");
  callout.className = mail.available ? "callout" : "callout callout-warning";

  const heading = document.createElement("p");
  heading.className = "callout-label";
  heading.textContent = mail.available ? "Status" : "Unavailable";

  const body = document.createElement("p");
  body.textContent = mail.available ? "Mail hook available." : mail.reason ?? "No details provided.";

  callout.append(heading, body);
  ui.mailStatus.replaceChildren(callout);
}

function renderCostPanel(cost: CostSummary): void {
  const fragment = document.createDocumentFragment();

  const totalRow = document.createElement("article");
  totalRow.className = "stat-line";
  const totalLabel = document.createElement("span");
  totalLabel.textContent = "Total";
  const totalValue = document.createElement("strong");
  totalValue.textContent = `$${cost.totalCostUsd.toFixed(4)}`;
  totalRow.append(totalLabel, totalValue);
  fragment.append(totalRow);

  for (const [model, amount] of Object.entries(cost.byModel).sort((a, b) => b[1] - a[1])) {
    const row = document.createElement("article");
    row.className = "stat-line";
    const label = document.createElement("span");
    label.textContent = model;
    const value = document.createElement("strong");
    value.textContent = `$${amount.toFixed(4)}`;
    row.append(label, value);
    fragment.append(row);
  }

  if (Object.keys(cost.byPhase).length > 0) {
    const heading = document.createElement("p");
    heading.className = "callout-label";
    heading.textContent = "By phase";
    fragment.append(heading);

    for (const [phase, amount] of Object.entries(cost.byPhase)) {
      const row = document.createElement("article");
      row.className = "stat-line";
      const label = document.createElement("span");
      label.textContent = phase;
      const value = document.createElement("strong");
      value.textContent = `$${amount.toFixed(4)}`;
      row.append(label, value);
      fragment.append(row);
    }
  }

  ui.costPanel.replaceChildren(fragment);
}

async function fetchCost(): Promise<void> {
  const baseUrl = normalizedBaseUrl();
  try {
    const response = await fetch(`${baseUrl}/cost`, { cache: "no-store" });
    if (!response.ok) return;
    const cost = await response.json() as CostSummary;
    renderCostPanel(cost);
  } catch {
    // Non-fatal — cost panel stays in last-known state.
  }
}

function renderBeadProgress(beads: BeadSummary | null, phase: string | undefined): void {
  const show = phase === "swarm" && beads !== null && beads.total > 0;
  ui.beadProgress.classList.toggle("hidden", !show);
  if (!show || !beads) return;

  const pct = beads.total > 0 ? Math.round((beads.closed / beads.total) * 100) : 0;
  ui.beadProgressFill.style.width = `${pct}%`;
  ui.beadProgressLabel.textContent = `${beads.closed}/${beads.total} beads · ${pct}%`;
}

function renderMemoryPanel(snapshot: DashboardSnapshot): void {
  const fragment = document.createDocumentFragment();
  const rows: [string, string][] = [
    ["Session", snapshot.server.sessionName],
    ["Path", snapshot.server.remoteProjectPath ?? "not configured"],
    ["Run", snapshot.run ? shortenId(snapshot.run.id) : "—"],
    ["Phase", snapshot.run?.phase ?? "—"],
    ["Started", snapshot.run ? formatRelative(snapshot.run.startedAt) : "—"],
    ["Gate", snapshot.run?.gatePassedAt ? formatRelative(snapshot.run.gatePassedAt) : "Not yet"],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement("article");
    row.className = "stat-line";
    const span = document.createElement("span");
    span.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = value;
    row.append(span, strong);
    fragment.append(row);
  }
  ui.sessionSummary.replaceChildren(fragment);
}

function syncControls(snapshot: DashboardSnapshot) {
  const actionStates = snapshot.actionStates ?? {};

  const promptEnabled = Boolean(actionStates["prompt.send"]?.enabled);
  const pauseEnabled = Boolean(actionStates["swarm.pause"]?.enabled);
  const resumeEnabled = Boolean(actionStates["swarm.resume"]?.enabled);
  const gateEnabled = Boolean(actionStates["gate.advance"]?.enabled);

  ui.promptSubmit.disabled = !promptEnabled;
  ui.pauseButton.disabled = !pauseEnabled;
  ui.resumeButton.disabled = !resumeEnabled;
  ui.gateSubmit.disabled = !gateEnabled;

  // Show gate form in command center only when gate is enabled
  ui.primaryAction.classList.toggle("hidden", !gateEnabled);
  ui.noActionHint.classList.toggle("hidden", gateEnabled);

  ui.swarmControlsNote.textContent =
    actionStates["swarm.pause"]?.reason ?? actionStates["swarm.resume"]?.reason ?? "Swarm controls are ready.";

  ui.gateNote.textContent = actionStates["gate.advance"]?.reason ?? "Gate advance is ready.";

  if (!promptEnabled && actionStates["prompt.send"]?.reason) {
    ui.promptMeta.textContent = actionStates["prompt.send"].reason;
  }

  syncPaneFieldState();
  syncGatePhaseOptions(snapshot.run);
}

function syncGatePhaseOptions(run: RunSummary | null) {
  const currentIndex = run ? PHASES.indexOf(run.phase) : -1;

  for (const option of ui.gatePhase.options) {
    const optionIndex = PHASES.indexOf(option.value);
    option.disabled = currentIndex >= 0 && optionIndex <= currentIndex;
  }

  if (currentIndex >= 0) {
    const nextPhase = PHASES[currentIndex + 1];
    if (nextPhase && Array.from(ui.gatePhase.options).some((option) => option.value === nextPhase)) {
      ui.gatePhase.value = nextPhase;
    }
  }
}

function syncPaneFieldState() {
  const broadcast = ui.promptAll.checked;
  ui.promptPane.disabled = broadcast;
  if (broadcast) {
    ui.promptPane.value = "";
  }
}

function summarizeAgents(agents: AgentStatus[]): { active: number; idle: number; stuck: number } {
  const counts = { active: 0, idle: 0, stuck: 0 };

  for (const agent of agents) {
    if (agent.status === "active") {
      counts.active += 1;
    } else if (agent.status === "stuck") {
      counts.stuck += 1;
    } else {
      counts.idle += 1;
    }
  }

  return counts;
}

function parseVariables(raw: string): { variables: Record<string, string>; invalidLines: string[] } {
  const variables: Record<string, string> = {};
  const invalidLines: string[] = [];

  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equals = trimmed.indexOf("=");
    if (equals <= 0) {
      invalidLines.push(String(index + 1));
      continue;
    }

    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim();

    if (!key) {
      invalidLines.push(String(index + 1));
      continue;
    }

    variables[key] = value;
  }

  return {
    variables,
    invalidLines,
  };
}

function replaceWithEmpty(container: Element, message: string) {
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = message;
  container.replaceChildren(empty);
}

function setWsStatus(label: string, className: string) {
  ui.wsStatus.textContent = label;
  ui.wsStatus.className = `status-pill ${className}`;
}

function normalizedBaseUrl() {
  let value = ui.serverUrl.value.trim() || "http://127.0.0.1:4200";
  if (!/^[a-z]+:\/\//i.test(value)) {
    value = `http://${value}`;
  }
  const normalized = value.replace(/\/+$/, "");
  ui.serverUrl.value = normalized;
  localStorage.setItem(STORAGE_SERVER_URL, normalized);
  return normalized;
}

function statusClass(status: AgentStatus["status"]) {
  if (status === "active") return "status-live";
  if (status === "stuck") return "status-error";
  return "status-idle";
}

function formatVelocity(value: number | undefined) {
  if (typeof value !== "number" || value <= 0) {
    return "warming up";
  }
  return `${value.toFixed(2)}/hr`;
}

function formatEta(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "unknown";
  }

  if (value < 1) {
    return `${Math.max(1, Math.round(value * 60))}m`;
  }

  return `${value.toFixed(1)}h`;
}

function formatTimestamp(value: string | undefined) {
  if (!value) {
    return "unknown";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return date.toLocaleString();
}

function formatRelative(value: string | undefined) {
  if (!value) {
    return "unknown";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  const elapsedMs = Date.now() - date.getTime();
  const elapsedMin = Math.floor(elapsedMs / 60_000);

  if (elapsedMin < 1) {
    return `just now (${formatTimestamp(value)})`;
  }

  if (elapsedMin < 60) {
    return `${elapsedMin}m ago (${formatTimestamp(value)})`;
  }

  const elapsedHours = Math.floor(elapsedMin / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h ago (${formatTimestamp(value)})`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays}d ago (${formatTimestamp(value)})`;
}

function shortenId(value: string | undefined) {
  if (!value) {
    return "—";
  }
  return value.length > 8 ? value.slice(0, 8) : value;
}

function logAction(message: string, isError = false) {
  const row = document.createElement("article");
  row.className = `log-line${isError ? " log-line-error" : ""}`;
  row.textContent = `${new Date().toLocaleTimeString()} ${isError ? "ERROR" : "INFO"} ${message}`;

  ui.actionLog.prepend(row);

  while (ui.actionLog.childElementCount > 40) {
    ui.actionLog.lastElementChild?.remove();
  }
}

function describeError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function requireElement(selector: string): Element {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`Dashboard element not found: ${selector}`);
  }
  return element;
}
