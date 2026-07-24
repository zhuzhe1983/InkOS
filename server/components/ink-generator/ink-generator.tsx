"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";

import styles from "./ink-generator.module.css";
import {
  JOB_PHASES,
  type ApiProblem,
  type GeneratorJobPhase,
  type GeneratorJobSnapshot,
  isTerminalStatus,
  parseApiProblem,
  parseGeneratorJob,
  progressPercent,
  resolveArtifactUrl,
  resolveServiceUrl,
} from "./job-contract";

const GENERATOR_ENDPOINT = "/api/ink/v1/generator/jobs";
const DEFAULT_SEED_URL = "https://zh.wikipedia.org/wiki/Nook#电子墨水屏系列";
const UI_MAX_DEPTH = 2;
const UI_MAX_DOCUMENTS = 20;
const POLL_INTERVAL_MS = 1_200;

const PHASE_LABELS: Record<GeneratorJobPhase, { title: string; detail: string }> = {
  queued: { title: "任务排队", detail: "服务已接收配置，等待执行资源" },
  fetching: { title: "抓取网页", detail: "安全访问来源及允许的子页面" },
  extracting: { title: "提取内容", detail: "生成带 UUID 与层级关系的文档" },
  rendering: { title: "预渲染画面", detail: "按设备、方向和显示参数输出图片" },
  packaging: { title: "校验并打包", detail: "写入清单、sidecar 与完整性摘要" },
  complete: { title: "生成完成", detail: "服务已发布可下载的 .ink 文件" },
};

const STATUS_LABELS: Record<GeneratorJobSnapshot["status"], string> = {
  queued: "已排队",
  running: "生成中",
  complete: "已完成",
  failed: "生成失败",
  cancelled: "已取消",
};

interface GeneratorFormState {
  seedUrl: string;
  title: string;
  maxDepth: number;
  maxDocuments: number;
  profileIds: string[];
  orientations: Array<"portrait" | "landscape">;
  fontLevels: number[];
}

const DEFAULT_FORM: GeneratorFormState = {
  seedUrl: DEFAULT_SEED_URL,
  title: "Nook 电子墨水屏系列",
  maxDepth: 1,
  maxDocuments: 2,
  profileIds: ["m5stack-paper-s3-portrait"],
  orientations: ["portrait"],
  fontLevels: [-2, -1, 0, 1, 2],
};

interface FormErrors {
  seedUrl?: string;
  title?: string;
  maxDepth?: string;
  maxDocuments?: string;
  orientations?: string;
  fontLevels?: string;
}

function Icon({ name }: { name: "arrow" | "api" | "check" | "download" | "retry" | "shield" }) {
  if (name === "arrow") {
    return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg>;
  }
  if (name === "api") {
    return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 9 4 12l4 3M16 9l4 3-4 3M14 5l-4 14" /></svg>;
  }
  if (name === "check") {
    return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6" /></svg>;
  }
  if (name === "download") {
    return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 20h14" /></svg>;
  }
  if (name === "retry") {
    return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 7v5h-5M4 17v-5h5M6.1 9a7 7 0 0 1 11.6-2.6L20 9M4 15l2.3 2.6A7 7 0 0 0 18 15" /></svg>;
  }
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.5 2.8 8 7 10 4.2-2 7-5.5 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-5" /></svg>;
}

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `ink-web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("服务返回了无法解析的 JSON");
  }
}

function toggleValue<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function validateForm(form: GeneratorFormState): FormErrors {
  const errors: FormErrors = {};
  try {
    const url = new URL(form.seedUrl);
    if (url.protocol !== "https:") {
      errors.seedUrl = "只支持 HTTPS 网页地址。";
    }
  } catch {
    errors.seedUrl = "请输入完整、有效的网页地址。";
  }
  if (!form.title.trim()) errors.title = "请填写离线包标题。";
  if (!Number.isInteger(form.maxDepth) || form.maxDepth < 0 || form.maxDepth > UI_MAX_DEPTH) {
    errors.maxDepth = `页面安全范围是 0–${UI_MAX_DEPTH} 层。`;
  }
  if (!Number.isInteger(form.maxDocuments) || form.maxDocuments < 1 || form.maxDocuments > UI_MAX_DOCUMENTS) {
    errors.maxDocuments = `页面安全范围是 1–${UI_MAX_DOCUMENTS} 篇。`;
  }
  if (form.orientations.length === 0) errors.orientations = "至少选择一个屏幕方向。";
  if (form.fontLevels.length === 0) errors.fontLevels = "至少选择一个字体档位。";
  return errors;
}

function firstErrorId(errors: FormErrors): string | undefined {
  const order: Array<keyof FormErrors> = [
    "seedUrl",
    "title",
    "maxDepth",
    "maxDocuments",
    "orientations",
    "fontLevels",
  ];
  const first = order.find((key) => errors[key]);
  return first ? `generator-${first}` : undefined;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "大小待服务确认";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

export function InkGenerator() {
  const [form, setForm] = useState<GeneratorFormState>(DEFAULT_FORM);
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [job, setJob] = useState<GeneratorJobSnapshot>();
  const [statusUrl, setStatusUrl] = useState<string>();
  const [requestProblem, setRequestProblem] = useState<ApiProblem>();
  const [pollProblem, setPollProblem] = useState<ApiProblem>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pollVersion, setPollVersion] = useState(0);

  const outputVariants = form.profileIds.length
    * form.orientations.length
    * form.fontLevels.length;
  const estimatedDocumentVariants = outputVariants * Math.max(0, form.maxDocuments);
  const percent = job ? progressPercent(job.progress) : undefined;
  const artifactUrl = useMemo(() => {
    if (!job || typeof window === "undefined") return undefined;
    return resolveArtifactUrl(job, window.location.origin);
  }, [job]);

  useEffect(() => {
    if (!statusUrl) return;

    let disposed = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    async function poll() {
      try {
        const response = await fetch(statusUrl!, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await readJson(response);
        if (!response.ok) {
          if (!disposed) setPollProblem(parseApiProblem(body, response.status));
          return;
        }

        const snapshot = parseGeneratorJob(body);
        if (disposed) return;
        setJob(snapshot);
        setPollProblem(undefined);
        if (!isTerminalStatus(snapshot.status)) {
          timeout = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        setPollProblem({
          code: "STATUS_POLL_FAILED",
          title: "任务状态暂时不可用",
          detail: error instanceof Error ? error.message : "无法连接任务状态接口。",
          retryable: true,
        });
      }
    }

    void poll();
    return () => {
      disposed = true;
      if (timeout) clearTimeout(timeout);
      controller.abort();
    };
  }, [pollVersion, statusUrl]);

  async function createJob() {
    const errors = validateForm(form);
    setFormErrors(errors);
    const errorId = firstErrorId(errors);
    if (errorId) {
      requestAnimationFrame(() => document.getElementById(errorId)?.focus());
      return;
    }

    setIsSubmitting(true);
    setRequestProblem(undefined);
    setPollProblem(undefined);
    setJob(undefined);
    setStatusUrl(undefined);

    try {
      const response = await fetch(GENERATOR_ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": newIdempotencyKey(),
        },
        body: JSON.stringify({
          seedUrl: form.seedUrl.trim(),
          title: form.title.trim(),
          maxDepth: form.maxDepth,
          maxDocuments: form.maxDocuments,
          profileIds: form.profileIds,
          orientations: form.orientations,
          fontLevels: [...form.fontLevels].sort((a, b) => a - b),
        }),
      });
      const body = await readJson(response);
      if (!response.ok) {
        setRequestProblem(parseApiProblem(body, response.status));
        return;
      }

      const snapshot = parseGeneratorJob(body);
      const absoluteStatusUrl = resolveServiceUrl(snapshot.statusUrl, window.location.origin);
      setJob(snapshot);
      if (!isTerminalStatus(snapshot.status)) {
        setStatusUrl(absoluteStatusUrl);
        setPollVersion((value) => value + 1);
      }
    } catch (error) {
      setRequestProblem({
        code: "JOB_CREATE_FAILED",
        title: "没有创建生成任务",
        detail: error instanceof Error ? error.message : "无法连接生成服务。",
        retryable: true,
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void createJob();
  }

  function retryPolling() {
    setPollProblem(undefined);
    setPollVersion((value) => value + 1);
  }

  const phaseIndex = job ? JOB_PHASES.indexOf(job.phase) : -1;

  return (
    <main className={styles.page}>
      <a className={styles.skipLink} href="#generator-form">跳到生成配置</a>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">I</span>
          <div>
            <span className={styles.brandName}>InkOS</span>
            <span className={styles.brandDescriptor}>Package Service</span>
          </div>
        </div>
        <nav className={styles.nav} aria-label="页面导航">
          <Link href="/" className={styles.navLink}><Icon name="arrow" />渲染实验室</Link>
          <a href="/api/ink/v1/openapi.json" className={styles.navLink} target="_blank" rel="noreferrer">
            <Icon name="api" />OpenAPI v1
          </a>
        </nav>
      </header>

      <section className={styles.hero} aria-labelledby="generator-page-title">
        <div>
          <p className={styles.kicker}><span />INK PACKAGE GENERATOR · PUBLIC API</p>
          <h1 id="generator-page-title">把一个网页，变成可离线分发的 <em>.ink</em> 内容包。</h1>
        </div>
        <div className={styles.heroAside}>
          <p>抓取结构化内容，为 PaperS3 预渲染多种显示组合，并打包文档、图片、跳转 sidecar 与校验信息。</p>
          <div className={styles.endpoint}><span>POST</span><code>{GENERATOR_ENDPOINT}</code></div>
        </div>
      </section>

      <div className={styles.workspace}>
        <form id="generator-form" className={styles.formPanel} onSubmit={handleSubmit} noValidate>
          <div className={styles.panelHeading}>
            <div>
              <p className={styles.sectionIndex}>01 / SOURCE &amp; OUTPUT</p>
              <h2>生成配置</h2>
            </div>
            <span className={styles.serviceBadge}><span />在线任务服务</span>
          </div>

          <fieldset className={styles.formSection}>
            <legend>内容来源</legend>
            <div className={styles.fieldWide}>
              <label htmlFor="generator-seedUrl">起始网页 <span aria-hidden="true">*</span></label>
              <input
                id="generator-seedUrl"
                type="url"
                inputMode="url"
                required
                value={form.seedUrl}
                aria-invalid={Boolean(formErrors.seedUrl)}
                aria-describedby={`seed-help${formErrors.seedUrl ? " seed-error" : ""}`}
                onChange={(event) => setForm((value) => ({ ...value, seedUrl: event.target.value }))}
              />
              <p id="seed-help" className={styles.help}>仅抓取公开 HTTPS 页面；服务端会重新校验 DNS、跳转和响应大小。</p>
              {formErrors.seedUrl && <p id="seed-error" className={styles.fieldError}>{formErrors.seedUrl}</p>}
            </div>
            <div className={styles.fieldWide}>
              <label htmlFor="generator-title">内容包标题 <span aria-hidden="true">*</span></label>
              <input
                id="generator-title"
                required
                value={form.title}
                aria-invalid={Boolean(formErrors.title)}
                aria-describedby={formErrors.title ? "title-error" : undefined}
                onChange={(event) => setForm((value) => ({ ...value, title: event.target.value }))}
              />
              {formErrors.title && <p id="title-error" className={styles.fieldError}>{formErrors.title}</p>}
            </div>
            <div className={styles.fieldGrid}>
              <div>
                <label htmlFor="generator-maxDepth">子页面深度</label>
                <input
                  id="generator-maxDepth"
                  type="number"
                  min="0"
                  max={UI_MAX_DEPTH}
                  step="1"
                  value={form.maxDepth}
                  aria-invalid={Boolean(formErrors.maxDepth)}
                  aria-describedby="depth-help"
                  onChange={(event) => setForm((value) => ({ ...value, maxDepth: Number(event.target.value) }))}
                />
                <p id="depth-help" className={formErrors.maxDepth ? styles.fieldError : styles.help}>
                  {formErrors.maxDepth ?? `本页面范围 0–${UI_MAX_DEPTH} 层`}
                </p>
              </div>
              <div>
                <label htmlFor="generator-maxDocuments">最多文档数</label>
                <input
                  id="generator-maxDocuments"
                  type="number"
                  min="1"
                  max={UI_MAX_DOCUMENTS}
                  step="1"
                  value={form.maxDocuments}
                  aria-invalid={Boolean(formErrors.maxDocuments)}
                  aria-describedby="documents-help"
                  onChange={(event) => setForm((value) => ({ ...value, maxDocuments: Number(event.target.value) }))}
                />
                <p id="documents-help" className={formErrors.maxDocuments ? styles.fieldError : styles.help}>
                  {formErrors.maxDocuments ?? `本页面范围 1–${UI_MAX_DOCUMENTS} 篇`}
                </p>
              </div>
            </div>
            <div className={styles.safetyNote}>
              <Icon name="shield" />
              <p><strong>安全上限不是配额承诺。</strong> 无论这里填写什么，服务端仍会独立限制抓取时间、页面数、图片数、渲染组合与包体积，并可能采用更严格的部署策略。</p>
            </div>
          </fieldset>

          <fieldset className={styles.formSection}>
            <legend>目标画面</legend>
            <div className={styles.fieldWide}>
              <label htmlFor="generator-profile">目标设备</label>
              <select id="generator-profile" value={form.profileIds[0]} onChange={(event) => setForm((value) => ({ ...value, profileIds: [event.target.value] }))}>
                <option value="m5stack-paper-s3-portrait">M5Stack PaperS3 · 16 级灰度 · 960×540</option>
                <option value="m5stack-xiaozhi-card">M5Stack Xiaozhi Card Kit · 黑白 · 176×264</option>
                <option value="m5stack-paper-color">M5Stack PaperColor · Spectra 6 色 · 400×600</option>
              </select>
            </div>

            <div className={styles.optionGroup}>
              <p id="orientation-label">屏幕方向</p>
              <div id="generator-orientations" className={styles.choiceRow} role="group" tabIndex={-1} aria-labelledby="orientation-label" aria-describedby={formErrors.orientations ? "orientation-error" : undefined}>
                {(["portrait", "landscape"] as const).map((orientation) => (
                  <label className={styles.choice} key={orientation}>
                    <input
                      type="checkbox"
                      checked={form.orientations.includes(orientation)}
                      onChange={() => setForm((value) => ({ ...value, orientations: toggleValue(value.orientations, orientation) }))}
                    />
                    <span>{orientation === "portrait" ? "竖屏" : "横屏"}</span>
                  </label>
                ))}
              </div>
              {formErrors.orientations && <p id="orientation-error" className={styles.fieldError}>{formErrors.orientations}</p>}
            </div>

            <div className={styles.optionGroup}>
              <p id="font-label">字体档位</p>
              <div id="generator-fontLevels" className={styles.choiceRow} role="group" tabIndex={-1} aria-labelledby="font-label" aria-describedby={formErrors.fontLevels ? "font-error" : "font-help"}>
                {[-2, -1, 0, 1, 2].map((level) => (
                  <label className={styles.choice} key={level}>
                    <input
                      type="checkbox"
                      checked={form.fontLevels.includes(level)}
                      onChange={() => setForm((value) => ({ ...value, fontLevels: toggleValue(value.fontLevels, level) }))}
                    />
                    <span>{level > 0 ? `+${level}` : level}</span>
                  </label>
                ))}
              </div>
              <p id="font-help" className={formErrors.fontLevels ? styles.fieldError : styles.help}>
                {formErrors.fontLevels ?? "−2 最小，0 为标准，+2 最大；每个档位都会单独预渲染。"}
              </p>
            </div>

          </fieldset>

          <div className={styles.variantSummary} aria-live="polite">
            <div><span>输出组合</span><strong>{outputVariants}</strong></div>
            <div><span>最多文档</span><strong>{Math.max(0, form.maxDocuments)}</strong></div>
            <div><span>内容 × 显示配置上限</span><strong>{estimatedDocumentVariants}</strong></div>
            <p>实际图片页数由内容分页决定，最终仍以服务端进度和包清单为准。</p>
          </div>

          {requestProblem && (
            <ProblemCard problem={requestProblem} onRetry={() => void createJob()} retryLabel="重新创建任务" />
          )}

          <div className={styles.submitRow}>
            <button className={styles.primaryButton} type="submit" disabled={isSubmitting}>
              {isSubmitting ? <><span className={styles.spinner} />正在提交…</> : <>开始生成 .ink 包<span aria-hidden="true">→</span></>}
            </button>
            <p>创建任务不会伪造即时结果；页面会持续读取服务端状态，完成后才出现下载入口。</p>
          </div>
        </form>

        <aside className={styles.jobPanel} aria-labelledby="job-heading">
          <div className={styles.panelHeading}>
            <div>
              <p className={styles.sectionIndex}>02 / JOB STATUS</p>
              <h2 id="job-heading">任务进度</h2>
            </div>
            {job && <span className={styles.statusBadge} data-status={job.status}><span />{STATUS_LABELS[job.status]}</span>}
          </div>

          {!job && !isSubmitting ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyGlyph} aria-hidden="true"><span /><span /><span /></div>
              <h3>还没有生成任务</h3>
              <p>确认左侧配置后开始生成。任务阶段、服务端进度和机器错误会原样显示在这里。</p>
            </div>
          ) : (
            <div className={styles.jobContent} aria-live="polite" aria-busy={isSubmitting || Boolean(job && !isTerminalStatus(job.status))}>
              {!job && isSubmitting && (
                <div className={styles.submittingState}>
                  <span className={styles.spinner} aria-hidden="true" />
                  <div>
                    <h3>正在创建任务</h3>
                    <p>服务确认并返回正式 job 资源后，这里才会显示阶段和进度。</p>
                  </div>
                </div>
              )}
              {job && (
                <>
                  <dl className={styles.jobMeta}>
                    <div><dt>JOB ID</dt><dd title={job.jobId}>{job.jobId}</dd></div>
                    <div><dt>UPDATED</dt><dd>{formatTime(job.updatedAt)}</dd></div>
                  </dl>

                  <section className={styles.progressBlock} aria-labelledby="progress-heading">
                    <div className={styles.progressHeading}>
                      <div>
                        <p id="progress-heading">{job.progress.message}</p>
                        <span>{percent === undefined ? "等待确定性计数" : `${job.progress.completed} / ${job.progress.total}`}</span>
                      </div>
                      <strong>{percent === undefined ? "—" : `${Math.round(percent)}%`}</strong>
                    </div>
                    <div
                      className={styles.progressTrack}
                      role="progressbar"
                      aria-label="生成进度"
                      aria-valuemin={0}
                      aria-valuemax={percent === undefined ? undefined : 100}
                      aria-valuenow={percent === undefined ? undefined : Math.round(percent)}
                      data-indeterminate={percent === undefined && !isTerminalStatus(job.status)}
                    >
                      {percent !== undefined && <span style={{ transform: `scaleX(${percent / 100})` }} />}
                    </div>
                  </section>

                  <ol className={styles.timeline} aria-label="生成阶段">
                    {JOB_PHASES.map((phase, index) => {
                      const state = index < phaseIndex || job.status === "complete"
                        ? "done"
                        : index === phaseIndex
                          ? job.status === "failed" ? "failed" : job.status === "cancelled" ? "cancelled" : "active"
                          : "pending";
                      return (
                        <li key={phase} data-state={state}>
                          <span className={styles.phaseMarker}>{state === "done" ? <Icon name="check" /> : index + 1}</span>
                          <div><strong>{PHASE_LABELS[phase].title}</strong><p>{PHASE_LABELS[phase].detail}</p></div>
                        </li>
                      );
                    })}
                  </ol>
                </>
              )}

              {pollProblem && <ProblemCard problem={pollProblem} onRetry={retryPolling} retryLabel="重新查询状态" />}
              {job?.error && (
                <ProblemCard
                  problem={{ code: job.error.code, title: "生成任务失败", detail: job.error.message, retryable: job.error.retryable }}
                  onRetry={() => void createJob()}
                  retryLabel="按当前配置重试"
                />
              )}

              {job?.status === "complete" && artifactUrl && (
                <section className={styles.artifactCard} aria-labelledby="artifact-heading">
                  <div className={styles.artifactIcon}><Icon name="check" /></div>
                  <div>
                    <p className={styles.sectionIndex}>VERIFIED ARTIFACT</p>
                    <h3 id="artifact-heading">{job.package?.fileName ?? "内容包已生成"}</h3>
                    <p>{job.package ? `${formatBytes(job.package.bytes)} · SHA-256 ${job.package.sha256.slice(0, 12)}…` : "包体信息可在下载响应与 manifest 中核验。"}</p>
                  </div>
                  <a className={styles.downloadButton} href={artifactUrl} download={job.package?.fileName}>
                    <Icon name="download" />下载 .ink
                  </a>
                </section>
              )}
            </div>
          )}

          <div className={styles.apiNote}>
            <Icon name="api" />
            <div>
              <h3>同一能力，也可以系统对接</h3>
              <p>网页使用公开 v1 API 创建与查询任务。生产服务可在接口前增加鉴权、租户配额和保留策略，无需改变包格式。</p>
              <a href="/api/ink/v1/openapi.json" target="_blank" rel="noreferrer">查看机器可读 OpenAPI <span aria-hidden="true">↗</span></a>
            </div>
          </div>
        </aside>
      </div>

      <footer className={styles.footer}>
        <p><span>inkos.client/v1</span> 可验证、可离线、面向多客户端</p>
        <p>服务器仍会执行独立安全策略与资源上限。</p>
      </footer>
    </main>
  );
}

function ProblemCard({ problem, onRetry, retryLabel }: { problem: ApiProblem; onRetry: () => void; retryLabel: string }) {
  return (
    <section className={styles.problemCard} role="alert">
      <div className={styles.problemCode}><span>ERROR</span><code>{problem.code}</code></div>
      <h3>{problem.title}</h3>
      <p>{problem.detail}</p>
      <div className={styles.problemFooter}>
        <span>{problem.status ? `HTTP ${problem.status} · ` : ""}{problem.retryable ? "服务标记为可重试" : "请修改配置或检查来源后再试"}</span>
        <button type="button" onClick={onRetry}><Icon name="retry" />{retryLabel}</button>
      </div>
    </section>
  );
}
