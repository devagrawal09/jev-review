import timers from "node:timers/promises";

export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const milliseconds = headers.get("retry-after-ms");

  if (milliseconds?.trim() && Number.isFinite(Number(milliseconds)) && Number(milliseconds) >= 0) {
    return Number(milliseconds);
  }

  const value = headers.get("retry-after")?.trim();

  if (!value) return undefined;
  const seconds = Number(value);

  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1_000 : undefined;
  const date = Date.parse(value);

  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function rateLimitedFetch(send: typeof fetch = globalThis.fetch): typeof fetch {
  let blockedUntil = 0;

  return async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);

    for (let attempt = 0; ; attempt++) {
      while (blockedUntil > Date.now()) {
        await timers.setTimeout(Math.min(60_000, blockedUntil - Date.now()), undefined, {
          signal: signal ?? undefined,
        });
      }

      signal?.throwIfAborted();

      // Space callers after a cooldown so they do not all retry together.
      if (blockedUntil > 0) blockedUntil = Date.now() + 250;
      const response = await send(input, init);

      if (response.status !== 429 && response.status !== 503) return response;

      const backoff = 2_000 * 2 ** Math.min(attempt, 2);
      const delay = retryAfterMs(response.headers) ?? backoff;
      blockedUntil = Math.max(blockedUntil, Date.now() + delay);
      await response.body?.cancel();
      const reason = response.status === 429 ? "rate limited" : "model temporarily unavailable";
      console.error(
        "AI Gateway " +
          reason +
          "; waiting " +
          Math.ceil(delay / 1_000) +
          "s (retry " +
          (attempt + 1) +
          "; Ctrl+C to cancel).",
      );
    }
  };
}
