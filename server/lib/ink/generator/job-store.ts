import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  generatorJobSchema,
  generatorJobUrls,
  normalizeGeneratorRequest,
  type GeneratorJob,
  type GeneratorRequest,
} from "./contracts";
import { inkUuidSchema } from "../contracts";

export class GeneratorStoreError extends Error {
  constructor(
    readonly code: "JOB_NOT_FOUND" | "IDEMPOTENCY_CONFLICT" | "JOB_NOT_READY",
    message: string,
  ) {
    super(message);
    this.name = "GeneratorStoreError";
  }
}

export class GeneratorJobCancelled extends Error {
  constructor() {
    super("Generator job was cancelled");
    this.name = "GeneratorJobCancelled";
  }
}

export function inkDataRoot(): string {
  return process.env.INKOS_DATA_DIR ??
    path.join(/*turbopackIgnore: true*/ process.cwd(), ".ink-data");
}

function jobDirectory(jobId: string): string {
  return path.join(inkDataRoot(), "jobs", inkUuidSchema.parse(jobId));
}

function jobJsonPath(jobId: string): string {
  return path.join(jobDirectory(jobId), "job.json");
}

function requestJsonPath(jobId: string): string {
  return path.join(jobDirectory(jobId), "request.json");
}

export function generatorArtifactPath(jobId: string): string {
  return path.join(jobDirectory(jobId), "artifact.ink");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function atomicWrite(filePath: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, filePath);
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const jobLocks = new Map<string, Promise<void>>();
const idempotencyLocks = new Map<string, Promise<void>>();

async function withJobLock<T>(jobId: string, action: () => Promise<T>): Promise<T> {
  const previous = jobLocks.get(jobId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  jobLocks.set(jobId, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (jobLocks.get(jobId) === tail) jobLocks.delete(jobId);
  }
}

async function withIdempotencyLock<T>(
  idempotencyPath: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = idempotencyLocks.get(idempotencyPath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  idempotencyLocks.set(idempotencyPath, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (idempotencyLocks.get(idempotencyPath) === tail) {
      idempotencyLocks.delete(idempotencyPath);
    }
  }
}

export async function readGeneratorJob(jobId: string): Promise<GeneratorJob> {
  try {
    return generatorJobSchema.parse(await readJson(jobJsonPath(jobId)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GeneratorStoreError("JOB_NOT_FOUND", `Generator job '${jobId}' was not found`);
    }
    throw error;
  }
}

export async function readGeneratorRequest(jobId: string): Promise<GeneratorRequest> {
  try {
    return normalizeGeneratorRequest(await readJson(requestJsonPath(jobId)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GeneratorStoreError("JOB_NOT_FOUND", `Generator job '${jobId}' was not found`);
    }
    throw error;
  }
}

interface IdempotencyRecord {
  requestSha256: string;
  jobId: string;
}

export async function createGeneratorJob(
  rawRequest: unknown,
  idempotencyKey?: string,
): Promise<{ job: GeneratorJob; request: GeneratorRequest; created: boolean }> {
  const request = normalizeGeneratorRequest(rawRequest);
  const requestSha256 = digest(request);
  let idempotencyPath: string | undefined;
  if (idempotencyKey !== undefined) {
    if (!idempotencyKey.trim() || idempotencyKey.length > 200) {
      throw new GeneratorStoreError("IDEMPOTENCY_CONFLICT", "Idempotency-Key must contain 1 to 200 characters");
    }
    const keySha256 = createHash("sha256").update(idempotencyKey).digest("hex");
    idempotencyPath = path.join(inkDataRoot(), "idempotency", `${keySha256}.json`);
  }

  const create = async () => {
    if (idempotencyPath) {
      try {
        const existing = await readJson(idempotencyPath) as IdempotencyRecord;
        if (existing.requestSha256 !== requestSha256) {
          throw new GeneratorStoreError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency-Key was already used with a different request",
          );
        }
        return { job: await readGeneratorJob(existing.jobId), request, created: false };
      } catch (error) {
        if (error instanceof GeneratorStoreError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    const jobId = randomUUID();
    const now = new Date().toISOString();
    const urls = generatorJobUrls(jobId);
    const job = generatorJobSchema.parse({
      schemaVersion: "inkos.generator-job/v1",
      jobId,
      status: "queued",
      phase: "queued",
      progress: { completed: 0, total: 1, message: "任务已进入本地生成队列" },
      createdAt: now,
      updatedAt: now,
      statusUrl: urls.statusUrl,
      eventsUrl: urls.eventsUrl,
    });
    await atomicWrite(requestJsonPath(jobId), stableJson(request));
    await atomicWrite(jobJsonPath(jobId), stableJson(job));
    if (idempotencyPath) {
      await atomicWrite(idempotencyPath, stableJson({ requestSha256, jobId } satisfies IdempotencyRecord));
    }
    return { job, request, created: true };
  };

  return idempotencyPath ? withIdempotencyLock(idempotencyPath, create) : create();
}

export async function updateGeneratorJob(
  jobId: string,
  update: (current: GeneratorJob) => GeneratorJob,
): Promise<GeneratorJob> {
  return withJobLock(jobId, async () => {
    const current = await readGeneratorJob(jobId);
    if (current.status === "cancelled") throw new GeneratorJobCancelled();
    const next = generatorJobSchema.parse(update(current));
    await atomicWrite(jobJsonPath(jobId), stableJson(next));
    return next;
  });
}

export async function failGeneratorJob(
  jobId: string,
  error: { code: string; message: string; retryable: boolean },
): Promise<GeneratorJob | undefined> {
  return withJobLock(jobId, async () => {
    const current = await readGeneratorJob(jobId);
    if (current.status === "cancelled") return undefined;
    if (current.status === "complete") return current;
    const next = generatorJobSchema.parse({
      ...current,
      status: "failed",
      updatedAt: new Date().toISOString(),
      error,
    });
    await atomicWrite(jobJsonPath(jobId), stableJson(next));
    return next;
  });
}

export async function cancelGeneratorJob(jobId: string): Promise<GeneratorJob> {
  return withJobLock(jobId, async () => {
    const current = await readGeneratorJob(jobId);
    if (current.status === "complete" || current.status === "failed" || current.status === "cancelled") {
      return current;
    }
    const next = generatorJobSchema.parse({
      ...current,
      status: "cancelled",
      updatedAt: new Date().toISOString(),
      progress: { ...current.progress, message: "任务已取消" },
    });
    await rm(generatorArtifactPath(jobId), { force: true });
    await atomicWrite(jobJsonPath(jobId), stableJson(next));
    return next;
  });
}

export async function publishGeneratorArtifact(
  jobId: string,
  artifact: Uint8Array,
  packageSummary: GeneratorJob["package"],
): Promise<GeneratorJob> {
  return withJobLock(jobId, async () => {
    const current = await readGeneratorJob(jobId);
    if (current.status === "cancelled") throw new GeneratorJobCancelled();
    if (!packageSummary) throw new Error("Package summary is required");
    await atomicWrite(generatorArtifactPath(jobId), artifact);
    const diskBytes = (await stat(generatorArtifactPath(jobId))).size;
    if (diskBytes !== artifact.byteLength || diskBytes !== packageSummary.bytes) {
      await rm(generatorArtifactPath(jobId), { force: true });
      throw new Error("Published artifact size does not match its package summary");
    }
    const urls = generatorJobUrls(jobId);
    const next = generatorJobSchema.parse({
      ...current,
      status: "complete",
      phase: "complete",
      progress: { completed: 1, total: 1, message: "离线包已校验并发布" },
      updatedAt: new Date().toISOString(),
      artifactUrl: urls.artifactUrl,
      package: packageSummary,
    });
    await atomicWrite(jobJsonPath(jobId), stableJson(next));
    return next;
  });
}
