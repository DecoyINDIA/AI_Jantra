import { getApiConfig, type RunEvent } from "./client";

function parseSseBlock(block: string): RunEvent | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data) return null;
  return JSON.parse(data) as RunEvent;
}

export async function subscribeRunEvents(
  runId: string,
  onEvent: (event: RunEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const config = getApiConfig();
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/v1/runs/${runId}/events`, {
    headers: {
      Authorization: `Bearer ${config.token}`,
    },
    signal,
  });
  if (!response.ok || !response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal?.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const event = parseSseBlock(block);
      if (event) onEvent(event);
    }
  }
}
