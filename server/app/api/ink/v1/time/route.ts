import { inkTimeResponseSchema } from "@/lib/ink/service-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface TimeRouteDependencies {
  now?: () => Date;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function shanghaiIso(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1_000);
  return `${shifted.getUTCFullYear()}-${twoDigits(shifted.getUTCMonth() + 1)}-${twoDigits(shifted.getUTCDate())}`
    + `T${twoDigits(shifted.getUTCHours())}:${twoDigits(shifted.getUTCMinutes())}:${twoDigits(shifted.getUTCSeconds())}`
    + `.${String(shifted.getUTCMilliseconds()).padStart(3, "0")}+08:00`;
}

export function handleTime(dependencies: TimeRouteDependencies = {}): Response {
  const now = (dependencies.now ?? (() => new Date()))();
  if (Number.isNaN(now.getTime())) throw new Error("Time source returned an invalid date");
  const body = inkTimeResponseSchema.parse({
    schemaVersion: "inkos.time/v1",
    serverUnixMs: now.getTime(),
    timezone: "Asia/Shanghai",
    serverIso: shanghaiIso(now),
  });
  const bytes = new TextEncoder().encode(`${JSON.stringify(body)}\n`);
  return new Response(bytes, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Length": String(bytes.byteLength),
      "Content-Type": "application/json; charset=utf-8",
      Date: now.toUTCString(),
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function GET(): Response {
  return handleTime();
}
