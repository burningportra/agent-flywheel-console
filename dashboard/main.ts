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
} = {
  snapshot: null,
  socket: null,
  reconnectTimer: null,
  reconnectDelayMs: 1500,
  reconnectMessageShown: false,
  promptCatalog: new Map(),
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
};

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
