import type { InkDynamicRegion } from "@/lib/ink/contracts";
import { inkTimeResponseSchema } from "@/lib/ink/service-contracts";

export const INK_TIME_ENDPOINT = "/api/ink/v1/time";

export interface ClockTick {
  readonly unixMs: number;
  readonly updateCount: number;
  readonly visualReset: boolean;
}

export interface ClockTextPlacement {
  readonly x: number;
  readonly y: number;
  readonly textAnchor: "start" | "middle" | "end";
  readonly dominantBaseline: "hanging" | "central" | "text-after-edge";
}

interface ClockSchedulerEnvironment {
  readonly now?: () => number;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}

export function estimateServerTimeOffset(
  requestStartedAt: number,
  responseReceivedAt: number,
  serverUnixMs: number,
): number {
  if (![requestStartedAt, responseReceivedAt, serverUnixMs].every(Number.isFinite)) {
    throw new Error("Clock synchronization values must be finite");
  }
  if (responseReceivedAt < requestStartedAt) {
    throw new Error("Clock synchronization response predates its request");
  }
  return serverUnixMs - (requestStartedAt + responseReceivedAt) / 2;
}

export async function fetchServerTimeOffset(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<number> {
  const requestStartedAt = now();
  const response = await fetcher(INK_TIME_ENDPOINT, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  const responseReceivedAt = now();
  if (!response.ok) throw new Error(`Time synchronization failed with HTTP ${response.status}`);
  const server = inkTimeResponseSchema.parse(await response.json());
  return estimateServerTimeOffset(requestStartedAt, responseReceivedAt, server.serverUnixMs);
}

export function formatClockTime(
  unixMs: number,
  timezone: InkDynamicRegion["timezone"],
  format: InkDynamicRegion["format"],
): string {
  if (format !== "HH:mm:ss") throw new Error(`Unsupported local clock format '${format}'`);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(new Date(unixMs));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("hour")}:${values.get("minute")}:${values.get("second")}`;
}

export function clockTextPlacement(region: InkDynamicRegion): ClockTextPlacement {
  const { bounds, style } = region;
  const x = style.textAlign === "left"
    ? bounds.x
    : style.textAlign === "right"
      ? bounds.x + bounds.width
      : bounds.x + bounds.width / 2;
  const y = style.verticalAlign === "top"
    ? bounds.y
    : style.verticalAlign === "bottom"
      ? bounds.y + bounds.height
      : bounds.y + bounds.height / 2;
  return {
    x,
    y,
    textAnchor: style.textAlign === "left" ? "start" : style.textAlign === "right" ? "end" : "middle",
    dominantBaseline: style.verticalAlign === "top"
      ? "hanging"
      : style.verticalAlign === "bottom"
        ? "text-after-edge"
        : "central",
  };
}

/** Align updates to corrected server-time boundaries and return an idempotent cleanup. */
export function startAlignedClock(
  region: Pick<InkDynamicRegion, "refreshMs" | "fullRefreshEvery">,
  serverOffsetMs: number,
  onTick: (tick: ClockTick) => void,
  environment: ClockSchedulerEnvironment = {},
): () => void {
  const now = environment.now ?? Date.now;
  const scheduleTimeout = environment.setTimeout ?? globalThis.setTimeout;
  const cancelTimeout = environment.clearTimeout ?? globalThis.clearTimeout;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let stopped = false;
  let updateCount = 0;

  const emit = (visualReset: boolean) => {
    onTick({
      unixMs: now() + serverOffsetMs,
      updateCount,
      visualReset,
    });
  };
  const schedule = () => {
    if (stopped) return;
    const correctedNow = now() + serverOffsetMs;
    const remainder = ((correctedNow % region.refreshMs) + region.refreshMs) % region.refreshMs;
    const delay = remainder === 0 ? region.refreshMs : region.refreshMs - remainder;
    timer = scheduleTimeout(() => {
      if (stopped) return;
      updateCount += 1;
      emit(updateCount % region.fullRefreshEvery === 0);
      schedule();
    }, delay);
  };

  emit(false);
  schedule();
  return () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) cancelTimeout(timer);
  };
}
