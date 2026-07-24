import { describe, expect, it } from "vitest";

import {
  parseApiProblem,
  parseGeneratorJob,
  progressPercent,
  resolveArtifactUrl,
} from "./job-contract";

const COMPLETE_JOB = {
  schemaVersion: "inkos.generator-job/v1",
  jobId: "job-123",
  status: "complete",
  phase: "complete",
  progress: { completed: 12, total: 12, message: "打包完成" },
  statusUrl: "/api/ink/v1/generator/jobs/job-123",
  artifactUrl: "/api/ink/v1/generator/jobs/job-123/artifact",
  package: {
    packageId: "pkg-123",
    fileName: "nook.ink",
    bytes: 2048,
    sha256: "abc123",
  },
};

describe("generator job contract", () => {
  it("parses the concrete v1 job resource", () => {
    const job = parseGeneratorJob(COMPLETE_JOB);

    expect(job.status).toBe("complete");
    expect(job.progress).toEqual({ completed: 12, total: 12, message: "打包完成" });
    expect(job.package?.fileName).toBe("nook.ink");
  });

  it("does not expose an artifact before the service reports complete", () => {
    const running = parseGeneratorJob({
      ...COMPLETE_JOB,
      status: "running",
      phase: "rendering",
    });

    expect(resolveArtifactUrl(running, "https://ink.example")).toBeUndefined();
  });

  it("derives the documented artifact endpoint only for a complete job", () => {
    const job = parseGeneratorJob({ ...COMPLETE_JOB, artifactUrl: undefined });

    expect(resolveArtifactUrl(job, "https://ink.example"))
      .toBe("https://ink.example/api/ink/v1/generator/jobs/job-123/artifact");
  });

  it("calculates only server-backed progress and clamps over-completion", () => {
    expect(progressPercent({ completed: 3, total: 12, message: "" })).toBe(25);
    expect(progressPercent({ completed: 15, total: 12, message: "" })).toBe(100);
    expect(progressPercent({ completed: 0, total: 0, message: "" })).toBeUndefined();
  });

  it("keeps a machine-readable problem code and retry flag", () => {
    expect(parseApiProblem({
      code: "SOURCE_UNREACHABLE",
      title: "无法抓取来源",
      detail: "目标站点返回 404",
      retryable: false,
    }, 422)).toEqual({
      code: "SOURCE_UNREACHABLE",
      title: "无法抓取来源",
      detail: "目标站点返回 404",
      retryable: false,
      status: 422,
    });
  });

  it("rejects an unknown status instead of presenting fake progress", () => {
    expect(() => parseGeneratorJob({ ...COMPLETE_JOB, status: "done" }))
      .toThrow(/缺少/);
  });
});
