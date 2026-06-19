// Jantra embeddable widgets.
//
// Two mounts are exported:
//   mountJantraRunWidget    read-only run status (existing).
//   mountJantraIntakeWidget interactive conversational intake (new).
//
// Both are framework-agnostic vanilla DOM, dependency-free, and safe to drop
// into any site. The intake widget drives the public intake agent over the
// run + interaction API and is themeable so the host can match its brand.

export interface JantraEmbedOptions {
  container: HTMLElement;
  baseUrl: string;
  apiKey: string;
  runId: string;
}

export async function mountJantraRunWidget(options: JantraEmbedOptions): Promise<void> {
  const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/v1/runs/${options.runId}`, {
    headers: { Authorization: `Bearer ${options.apiKey}` },
  });
  if (!response.ok) throw new Error(await response.text());
  const { run } = (await response.json()) as { run: { title: string; status: string; currentStage: string } };
  options.container.replaceChildren();
  const root = document.createElement("section");
  root.style.cssText = "font: 14px system-ui; border: 1px solid #d8ded8; border-radius: 8px; padding: 12px;";
  root.innerHTML = `<strong>${escapeHtml(run.title)}</strong><br><span>${escapeHtml(run.status)} · ${escapeHtml(
    run.currentStage,
  )}</span>`;
  options.container.append(root);
}

// ---------------------------------------------------------------------------
// Interactive conversational intake widget
// ---------------------------------------------------------------------------

/** Design tokens the host passes so the widget matches its brand. */
export interface JantraThemeTokens {
  fontFamily?: string;
  accent?: string; // brand color: send button, agent label
  accentText?: string; // text on the accent color
  text?: string; // primary body text
  muted?: string; // secondary text
  surface?: string; // widget panel background
  agentBubble?: string; // agent message background
  userBubble?: string; // visitor message background
  border?: string;
  radius?: string; // border radius, e.g. "16px"
}

/** The structured idea summary handed back when intake completes. */
export interface JantraIdeaSummary {
  title: string;
  content: string; // rendered markdown summary
}

export interface JantraIntakeOptions {
  container: HTMLElement;
  baseUrl: string;
  /** Public agent id. Defaults to "intake-public". */
  agentId?: string;
  /**
   * Bearer key. Usually omitted: a public edge (e.g. a Cloudflare Worker) holds
   * the real key and injects it, so the browser ships no secret. Provide only
   * for trusted/server contexts.
   */
  apiKey?: string;
  /** Run title used server-side. Defaults to "Website intake". */
  title?: string;
  theme?: JantraThemeTokens;
  /** Called once the agent produces its idea summary (a captured lead). */
  onComplete?: (summary: JantraIdeaSummary) => void;
  /** Called on any unrecoverable error. */
  onError?: (error: Error) => void;
  /** Per-request timeout. Defaults to 20 seconds. */
  requestTimeoutMs?: number;
  /** Maximum visitor answer size. Defaults to 2000 characters. */
  maxMessageChars?: number;
  /** Number of automatic retries for transient request failures. Defaults to 2. */
  maxRetries?: number;
}

export interface JantraIntakeHandle {
  destroy(): void;
}

interface PendingInteraction {
  id: string;
  prompt: string;
}

interface Artifact {
  kind: string;
  title: string;
  content: string;
}

type StageStep =
  | { status: "awaiting_input"; interaction: PendingInteraction }
  | { status: "awaiting_confirmation"; artifacts: Artifact[] }
  | { status: "failed"; error?: { message?: string } };

interface RunEnvelope {
  run: { id: string };
  step?: StageStep;
}

const DEFAULT_THEME: Required<JantraThemeTokens> = {
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  accent: "#1c2e1e",
  accentText: "#ffffff",
  text: "#1a1a1a",
  muted: "#738273",
  surface: "#ffffff",
  agentBubble: "#f4f6f3",
  userBubble: "#1c2e1e",
  border: "#e6eae5",
  radius: "16px",
};

let widgetSeq = 0;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_MESSAGE_CHARS = 2000;
const DEFAULT_MAX_RETRIES = 2;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function mountJantraIntakeWidget(options: JantraIntakeOptions): JantraIntakeHandle {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const agentId = options.agentId ?? "intake-public";
  const theme = sanitizeTheme({ ...DEFAULT_THEME, ...(options.theme ?? {}) });
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxMessageChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const scope = `jantra-intake-${++widgetSeq}`;
  const reduceMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let destroyed = false;
  let runId: string | null = null;
  let busy = false;

  const container = options.container;
  container.replaceChildren();

  const style = document.createElement("style");
  style.textContent = css(scope, theme, reduceMotion);

  const root = document.createElement("section");
  root.className = scope;
  root.setAttribute("aria-label", "Jantra intake assistant");

  const thread = document.createElement("div");
  thread.className = `${scope}__thread`;
  thread.setAttribute("role", "log");
  thread.setAttribute("aria-live", "polite");

  const form = document.createElement("form");
  form.className = `${scope}__form`;

  const input = document.createElement("textarea");
  input.className = `${scope}__input`;
  input.rows = 1;
  input.maxLength = maxMessageChars;
  input.placeholder = "Your answer...";
  input.setAttribute("aria-label", "Your message to the Jantra intake assistant");

  const send = document.createElement("button");
  send.type = "submit";
  send.className = `${scope}__send`;
  send.textContent = "Send";

  const status = document.createElement("div");
  status.className = `${scope}__status`;
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.hidden = true;

  form.append(input, send);
  root.append(thread, status, form);
  container.append(style, root);

  function clearStatus(): void {
    status.replaceChildren();
    status.hidden = true;
  }

  function showStatus(text: string, retry?: () => void): void {
    status.replaceChildren();
    status.hidden = false;
    const message = document.createElement("span");
    message.textContent = text;
    status.append(message);
    if (retry) {
      const retryButton = document.createElement("button");
      retryButton.type = "button";
      retryButton.className = `${scope}__retry`;
      retryButton.textContent = "Try again";
      retryButton.addEventListener("click", () => {
        clearStatus();
        retry();
      });
      status.append(retryButton);
    }
  }

  function fail(error: Error, retry?: () => void): void {
    if (destroyed) return;
    showStatus("The intake service did not respond. Please try again.", retry);
    setBusy(false);
    options.onError?.(error);
  }

  function setBusy(value: boolean): void {
    busy = value;
    input.disabled = value;
    send.disabled = value;
    send.textContent = value ? "Sending..." : "Send";
  }

  function autosize(): void {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }

  function addMessage(role: "agent" | "user", text: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = `${scope}__msg ${scope}__msg--${role}`;
    const bubble = document.createElement("div");
    bubble.className = `${scope}__bubble`;
    bubble.textContent = text;
    wrap.append(bubble);
    thread.append(wrap);
    thread.scrollTop = thread.scrollHeight;
    return wrap;
  }

  function showTyping(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = `${scope}__msg ${scope}__msg--agent`;
    const bubble = document.createElement("div");
    bubble.className = `${scope}__bubble ${scope}__typing`;
    bubble.innerHTML = "<span></span><span></span><span></span>";
    wrap.append(bubble);
    thread.append(wrap);
    thread.scrollTop = thread.scrollHeight;
    return wrap;
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const headers = new Headers(init.headers);
      if (options.apiKey) headers.set("Authorization", `Bearer ${options.apiKey}`);
      if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), requestTimeoutMs);
      let response: Response | null = null;
      try {
        response = await fetch(`${baseUrl}${path}`, {
          ...init,
          headers,
          signal: controller.signal,
        });
      } catch (error) {
        lastError = error;
        if (attempt === maxRetries) {
          throw error instanceof Error ? error : new Error(String(error));
        }
        await delay(300 * 2 ** attempt);
        continue;
      } finally {
        window.clearTimeout(timeout);
      }

      if (!response) {
        lastError = new Error("No response from intake service.");
        if (attempt === maxRetries) throw lastError;
        await delay(300 * 2 ** attempt);
        continue;
      }
      if (response.ok) return (await response.json()) as T;
      const text = await response.text();
      lastError = new Error(`${response.status} ${text}`);
      if (!RETRYABLE_STATUS.has(response.status) || attempt === maxRetries) {
        throw lastError;
      }
      await delay(300 * 2 ** attempt);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  function handleStep(step: StageStep | undefined, typing: HTMLElement | null): void {
    if (destroyed) return;
    typing?.remove();
    clearStatus();
    if (!step) {
      setBusy(false);
      return;
    }
    if (step.status === "awaiting_input") {
      addMessage("agent", step.interaction.prompt);
      pendingInteractionId = step.interaction.id;
      setBusy(false);
      input.focus();
      return;
    }
    if (step.status === "awaiting_confirmation") {
      const summary =
        step.artifacts.find((a) => a.kind === "idea_summary") ?? step.artifacts[0];
      addMessage(
        "agent",
        "I love where this landed. Here's your idea, written up the way I'll hand it to our team. They'll dig in and get back to you soon.",
      );
      if (summary) {
        renderSummary(summary);
        options.onComplete?.({ title: summary.title, content: summary.content });
      }
      pendingInteractionId = null;
      busy = false;
      input.disabled = true;
      send.disabled = true;
      send.textContent = "Done";
      input.placeholder = "Intake complete.";
      return;
    }
    // failed
    fail(new Error(step.error?.message ?? "Intake stage failed."));
  }

  function renderSummary(summary: Artifact): void {
    const wrap = document.createElement("div");
    wrap.className = `${scope}__summary`;
    const heading = document.createElement("strong");
    heading.textContent = summary.title;
    const pre = document.createElement("pre");
    pre.textContent = summary.content;
    wrap.append(heading, pre);
    thread.append(wrap);
    thread.scrollTop = thread.scrollHeight;
  }

  let pendingInteractionId: string | null = null;

  async function start(): Promise<void> {
    setBusy(true);
    clearStatus();
    const typing = showTyping();
    try {
      const created = await request<RunEnvelope>("/v1/runs", {
        method: "POST",
        body: JSON.stringify({ agentId, title: options.title ?? "Website intake" }),
      });
      runId = created.run.id;
      const advanced = await request<RunEnvelope>(`/v1/runs/${runId}/advance`, { method: "POST" });
      handleStep(advanced.step, typing);
    } catch (error) {
      typing.remove();
      fail(error instanceof Error ? error : new Error(String(error)), () => void start());
    }
  }

  async function submit(text: string, echo = true): Promise<void> {
    if (!runId || !pendingInteractionId) return;
    if (echo) addMessage("user", text);
    setBusy(true);
    clearStatus();
    const interactionId = pendingInteractionId;
    pendingInteractionId = null;
    const typing = showTyping();
    try {
      const result = await request<RunEnvelope>(
        `/v1/runs/${runId}/interactions/${interactionId}`,
        { method: "POST", body: JSON.stringify({ text }) },
      );
      handleStep(result.step, typing);
    } catch (error) {
      typing.remove();
      pendingInteractionId = interactionId;
      fail(error instanceof Error ? error : new Error(String(error)), () => void submit(text, false));
    }
  }

  function onSubmit(event: Event): void {
    event.preventDefault();
    if (busy) return;
    const text = input.value.trim();
    if (!text) return;
    if (text.length > maxMessageChars) {
      showStatus(`Please keep your answer under ${maxMessageChars} characters.`);
      return;
    }
    input.value = "";
    autosize();
    void submit(text);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  }

  form.addEventListener("submit", onSubmit);
  input.addEventListener("keydown", onKeydown);
  input.addEventListener("input", autosize);

  void start();

  return {
    destroy(): void {
      destroyed = true;
      form.removeEventListener("submit", onSubmit);
      input.removeEventListener("keydown", onKeydown);
      input.removeEventListener("input", autosize);
      container.replaceChildren();
    },
  };
}

function css(scope: string, t: Required<JantraThemeTokens>, reduceMotion: boolean): string {
  const dotAnim = reduceMotion
    ? ""
    : `@keyframes ${scope}-blink { 0%, 80%, 100% { opacity: 0.25 } 40% { opacity: 1 } }`;
  const dotStyle = reduceMotion
    ? "opacity: 0.5;"
    : `animation: ${scope}-blink 1.2s infinite both;`;
  return `
.${scope} { font-family: ${t.fontFamily}; color: ${t.text}; background: ${t.surface};
  border: 1px solid ${t.border}; border-radius: ${t.radius}; padding: 16px;
  display: flex; flex-direction: column; gap: 12px; box-sizing: border-box; }
.${scope} * { box-sizing: border-box; }
.${scope}__thread { display: flex; flex-direction: column; gap: 10px;
  max-height: 360px; overflow-y: auto; padding-right: 4px; }
.${scope}__msg { display: flex; }
.${scope}__msg--agent { justify-content: flex-start; }
.${scope}__msg--user { justify-content: flex-end; }
.${scope}__bubble { max-width: 85%; padding: 10px 14px; border-radius: 14px;
  line-height: 1.5; font-size: 15px; white-space: pre-wrap; word-wrap: break-word; }
.${scope}__msg--agent .${scope}__bubble { background: ${t.agentBubble}; color: ${t.text};
  border-bottom-left-radius: 4px; }
.${scope}__msg--user .${scope}__bubble { background: ${t.userBubble}; color: ${t.accentText};
  border-bottom-right-radius: 4px; }
.${scope}__typing { display: inline-flex; gap: 4px; align-items: center; }
.${scope}__typing span { width: 6px; height: 6px; border-radius: 50%;
  background: ${t.muted}; display: inline-block; ${dotStyle} }
.${scope}__typing span:nth-child(2) { animation-delay: 0.2s; }
.${scope}__typing span:nth-child(3) { animation-delay: 0.4s; }
.${scope}__summary { background: ${t.agentBubble}; border: 1px solid ${t.border};
  border-radius: 12px; padding: 12px 14px; }
.${scope}__summary pre { white-space: pre-wrap; word-wrap: break-word; margin: 8px 0 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: ${t.text}; }
.${scope}__status { display: flex; align-items: center; justify-content: space-between; gap: 10px;
  color: #7a2e1e; background: #fff6f3; border: 1px solid #f0d4cc;
  border-radius: 12px; padding: 9px 11px; font-size: 13px; line-height: 1.4; }
.${scope}__status[hidden] { display: none; }
.${scope}__retry { font: inherit; color: ${t.accent}; background: transparent;
  border: 0; padding: 0; font-weight: 700; cursor: pointer; white-space: nowrap; }
.${scope}__form { display: flex; gap: 8px; align-items: flex-end; }
.${scope}__input { flex: 1; resize: none; font: inherit; color: ${t.text};
  background: ${t.surface}; border: 1px solid ${t.border}; border-radius: 12px;
  padding: 10px 12px; line-height: 1.4; min-height: 44px; max-height: 160px;
  overflow-y: hidden; }
.${scope}__input:focus { outline: 2px solid ${t.accent}; outline-offset: 1px; }
.${scope}__input:disabled { opacity: 0.6; }
.${scope}__send { font: inherit; font-weight: 600; color: ${t.accentText};
  background: ${t.accent}; border: none; border-radius: 12px; padding: 10px 18px;
  min-height: 44px;
  cursor: pointer; white-space: nowrap; }
.${scope}__send:disabled { opacity: 0.5; cursor: default; }
${dotAnim}
`;
}

function sanitizeCssToken(value: string): string {
  // Theme tokens are interpolated into a <style> block. Strip characters that
  // could break out of a CSS value/declaration context (rule/declaration
  // terminators, tag delimiters that could close </style>, CSS escapes, and
  // newlines) so a host that forwards untrusted theme values cannot inject CSS
  // or markup. Legitimate colors, fonts, sizes, and radii use none of these.
  return value.replace(/[{}<>;@\\]/g, "").replace(/[\r\n]+/g, " ");
}

function sanitizeTheme(theme: Required<JantraThemeTokens>): Required<JantraThemeTokens> {
  const out = {} as Required<JantraThemeTokens>;
  for (const key of Object.keys(theme) as Array<keyof JantraThemeTokens>) {
    out[key] = sanitizeCssToken(theme[key]);
  }
  return out;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;",
    };
    return map[char] ?? char;
  });
}
