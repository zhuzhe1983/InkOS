export const JOB_PHASES = [
  "queued",
  "fetching",
  "extracting",
  "rendering",
  "packaging",
  "complete",
] as const;

export const JOB_STATUSES = [
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
] as const;

export type GeneratorJobPhase = (typeof JOB_PHASES)[number];
export type GeneratorJobStatus = (typeof JOB_STATUSES)[number];

export interface GeneratorJobProblem {
  code: string;
  message: string;
  retryable: boolean;
}

export interface GeneratorJobProgress {
  completed: number;
  total: number;
  message: string;
}

export interface GeneratorPackageSummary {
  packageId: string;
  fileName: string;
  bytes: number;
  sha256: string;
}

export interface GeneratorJobSnapshot {
  schemaVersion?: string;
  jobId: string;
  status: GeneratorJobStatus;
  phase: GeneratorJobPhase;
  progress: GeneratorJobProgress;
  createdAt?: string;
  updatedAt?: string;
  statusUrl: string;
  eventsUrl?: string;
  artifactUrl?: string;
  package?: GeneratorPackageSummary;
  error?: GeneratorJobProblem;
}

export interface ApiProblem {
  code: string;
  title: string;
  detail: string;
  retryable: boolean;
  status?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function finiteNonNegative(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function isJobStatus(value: unknown): value is GeneratorJobStatus {
  return typeof value === "string" && JOB_STATUSES.includes(value as GeneratorJobStatus);
}

function isJobPhase(value: unknown): value is GeneratorJobPhase {
  return typeof value === "string" && JOB_PHASES.includes(value as GeneratorJobPhase);
}

/**
 * Parse the public service response without inventing progress or completion.
 * Optional metadata stays optional so additive API fields remain compatible.
 */
export function parseGeneratorJob(value: unknown): GeneratorJobSnapshot {
  if (!isRecord(value)) throw new Error("任务状态响应不是 JSON 对象");

  const jobId = optionalString(value.jobId);
  const statusUrl = optionalString(value.statusUrl);
  if (!jobId || !statusUrl || !isJobStatus(value.status) || !isJobPhase(value.phase)) {
    throw new Error("任务状态响应缺少 jobId、statusUrl、status 或 phase");
  }

  const progress = isRecord(value.progress) ? value.progress : {};
  const completed = finiteNonNegative(progress.completed);
  const total = finiteNonNegative(progress.total);
  const message = optionalString(progress.message) ?? "服务端尚未提供进度说明";

  const rawError = isRecord(value.error) ? value.error : undefined;
  const error = rawError && optionalString(rawError.code) && optionalString(rawError.message)
    ? {
        code: String(rawError.code),
        message: String(rawError.message),
        retryable: rawError.retryable === true,
      }
    : undefined;

  const rawPackage = isRecord(value.package) ? value.package : undefined;
  const packageSummary = rawPackage
    && optionalString(rawPackage.packageId)
    && optionalString(rawPackage.fileName)
    && optionalString(rawPackage.sha256)
    ? {
        packageId: String(rawPackage.packageId),
        fileName: String(rawPackage.fileName),
        bytes: finiteNonNegative(rawPackage.bytes),
        sha256: String(rawPackage.sha256),
      }
    : undefined;

  return {
    schemaVersion: optionalString(value.schemaVersion),
    jobId,
    status: value.status,
    phase: value.phase,
    progress: { completed, total, message },
    createdAt: optionalString(value.createdAt),
    updatedAt: optionalString(value.updatedAt),
    statusUrl,
    eventsUrl: optionalString(value.eventsUrl),
    artifactUrl: optionalString(value.artifactUrl),
    package: packageSummary,
    error,
  };
}

export function parseApiProblem(value: unknown, status?: number): ApiProblem {
  const record = isRecord(value) ? value : {};
  return {
    code: optionalString(record.code) ?? "REQUEST_FAILED",
    title: optionalString(record.title) ?? "请求失败",
    detail: optionalString(record.detail) ?? optionalString(record.message) ?? "服务没有返回可读的错误说明。",
    retryable: record.retryable === true,
    status,
  };
}

export function progressPercent(progress: GeneratorJobProgress): number | undefined {
  if (progress.total <= 0) return undefined;
  return Math.min(100, Math.max(0, (progress.completed / progress.total) * 100));
}

export function isTerminalStatus(status: GeneratorJobStatus): boolean {
  return status === "complete" || status === "failed" || status === "cancelled";
}

export function resolveServiceUrl(url: string, origin: string): string {
  return new URL(url, origin).toString();
}

export function resolveArtifactUrl(job: GeneratorJobSnapshot, origin: string): string | undefined {
  if (job.status !== "complete") return undefined;
  if (job.artifactUrl) return resolveServiceUrl(job.artifactUrl, origin);
  return resolveServiceUrl(`${job.statusUrl.replace(/\/$/, "")}/artifact`, origin);
}
