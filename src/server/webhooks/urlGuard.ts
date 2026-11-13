import { assertPublicHost } from "../../util/netGuard.js";

/**
 * Reject webhook URLs that could reach internal infrastructure: non-HTTP(S)
 * schemes, loopback/link-local/private hosts, and the cloud metadata endpoint.
 * The server fetches this URL with no caller-visible response, so an unchecked
 * URL is a blind SSRF primitive. Call this both at subscription-create time and
 * immediately before delivery (DNS can change between the two).
 */
export async function assertPublicWebhookUrl(rawUrl: string): Promise<void> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Webhook URL scheme must be http or https, got "${url.protocol}".`);
  }
  await assertPublicHost(url.hostname);
}
