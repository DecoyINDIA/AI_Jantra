import * as dns from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import { assertPublicHost, isBlockedAddress } from "./netGuard.js";

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
}

export interface NextRequestResult {
  url: string;
  method: string;
  dropBody: boolean;
}

export function nextRequest(
  currentUrl: string,
  status: number,
  location: string | null | undefined,
  method: string,
): NextRequestResult {
  if (!location) {
    throw new UnsafeUrlError("Redirect response missing Location header.");
  }
  const resolvedUrl = new URL(location, currentUrl).toString();
  const upperMethod = method.toUpperCase();
  let nextMethod = upperMethod;
  let dropBody = false;

  if (status === 303 || ((status === 301 || status === 302) && upperMethod === "POST")) {
    nextMethod = "GET";
    dropBody = true;
  }
  return {
    url: resolvedUrl,
    method: nextMethod,
    dropBody,
  };
}

export async function safeFetch(
  url: string,
  init?: RequestInit,
  opts?: SafeFetchOptions,
): Promise<Response> {
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  const maxRedirects = opts?.maxRedirects ?? 3;
  const maxBytes = opts?.maxBytes ?? 5_000_000;

  let currentUrl = url;
  let currentMethod = (init?.method ?? "GET").toUpperCase();
  let currentBody = init?.body;

  let redirects = 0;

  while (true) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      throw new UnsafeUrlError("Invalid URL.");
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new UnsafeUrlError(`Unsupported URL protocol: ${parsed.protocol}`);
    }
    if (parsed.username || parsed.password) {
      throw new UnsafeUrlError("Credentials in URL are not permitted.");
    }

    try {
      await assertPublicHost(parsed.hostname);
    } catch (err) {
      throw new UnsafeUrlError(err instanceof Error ? err.message : "Host is not permitted.");
    }

    const agent = new Agent({
      connect: {
        lookup: (hostname, options, cb) => {
          dns.lookup(hostname, options, (err, addressOrAddresses, family) => {
            const callback = cb as (err: Error | null, address?: any, family?: any) => void;
            if (err) return callback(err);
            if (Array.isArray(addressOrAddresses)) {
              for (const entry of addressOrAddresses) {
                if (isBlockedAddress(entry.address)) {
                  return callback(new UnsafeUrlError("Destination address is not permitted."));
                }
              }
              return callback(null, addressOrAddresses);
            }
            if (typeof addressOrAddresses === "string" && isBlockedAddress(addressOrAddresses)) {
              return callback(new UnsafeUrlError("Destination address is not permitted."));
            }
            return callback(null, addressOrAddresses, family);
          });
        },
      },
    });

    let res;
    try {
      res = await undiciFetch(currentUrl, {
        ...(init as any),
        method: currentMethod,
        body: currentBody as any,
        redirect: "manual",
        dispatcher: agent,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      await agent.close().catch(() => {});
      if (err instanceof UnsafeUrlError) throw err;
      throw new UnsafeUrlError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      await agent.close().catch(() => {});
      if (redirects >= maxRedirects) {
        throw new UnsafeUrlError("Too many redirects.");
      }
      redirects++;
      const location = res.headers.get("location");
      const next = nextRequest(currentUrl, res.status, location, currentMethod);
      currentUrl = next.url;
      currentMethod = next.method;
      if (next.dropBody) {
        currentBody = undefined;
      }
      continue;
    }

    // Enforce maxBytes
    const contentLength = res.headers.get("content-length");
    if (contentLength) {
      const bytes = Number(contentLength);
      if (Number.isFinite(bytes) && bytes > maxBytes) {
        await agent.close().catch(() => {});
        throw new UnsafeUrlError("Response body exceeded maximum allowed size.");
      }
    }

    if (!res.body) {
      await agent.close().catch(() => {});
      return res as unknown as Response;
    }

    let bytesRead = 0;
    const bodyStream = res.body as unknown as ReadableStream<Uint8Array>;
    const limitedStream = bodyStream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytesRead += chunk.byteLength;
          if (bytesRead > maxBytes) {
            agent.close().catch(() => {});
            controller.error(new UnsafeUrlError("Response body exceeded maximum allowed size."));
            return;
          }
          controller.enqueue(chunk);
        },
        flush() {
          agent.close().catch(() => {});
        },
      }),
    );

    return new Response(limitedStream, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers as any,
    });
  }
}
