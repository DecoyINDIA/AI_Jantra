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
