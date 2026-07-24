import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { unzipSync, zipSync } from "fflate";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { buildInkArchive, readInkArchive, sha256Hex } from "../archive";
import {
  getInkCatalogPackage,
  getInkDocumentArtifact,
  getInkDownloadArtifact,
  getInkFrameArtifact,
  getInkManifestArtifact,
  listInkCatalogPackages,
} from "../catalog-store";
import { inkFrameSidecarSchema } from "../contracts";
import { generatorJobSchema, generatorJobUrls } from "../generator/contracts";
import { uuidV5 } from "../uuid";
import { getScreenProfile, orientScreenProfile } from "../../rendering/profiles";
import { layoutSemanticDocument } from "../../rendering/semantic-layout";
import {
  buildPaperS3HomePackage,
  currentShanghaiCalendarDate,
  ensurePaperS3HomePackage,
  PAPERS3_HOME_ENTRY_UUID,
  PAPERS3_HOME_LUNAR_LIBRARY,
  PAPERS3_HOME_PACKAGE_ID,
  paperS3HomeDocuments,
} from "./papers3-home";
import {
  PAPERS3_CALIBRATION_ASSET_ID,
  PAPERS3_PORTRAIT_CALIBRATION_ASSET_ID,
} from "./papers3-calibration-asset";

const temporaryDirectories: string[] = [];

async function temporaryDataDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "inkos-home-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("PaperS3 built-in home .ink package", () => {
  it("uses Asia/Shanghai calendar boundaries instead of the server's local timezone", () => {
    expect(currentShanghaiCalendarDate(new Date("2026-07-15T16:00:00.000Z")))
      .toEqual({ year: 2026, month: 7, day: 16 });
    expect(currentShanghaiCalendarDate(new Date("2026-07-31T16:00:00.000Z")))
      .toEqual({ year: 2026, month: 8, day: 1 });
  });

  it("contains eight two-column apps, current actions and one clickable old-almanac month grid", () => {
    const documents = paperS3HomeDocuments({ year: 2026, month: 7, day: 16 });
    const byUuid = new Map(documents.map((document) => [document.uuid, document]));
    const home = byUuid.get(PAPERS3_HOME_ENTRY_UUID)!;
    expect(home.content.page).toMatchObject({
      kind: "list",
      layout: "grid",
      title: "InkOS - PaperS3 应用首页",
    });
    if (home.content.page.kind !== "list") throw new Error("Expected list home");
    expect(home.content.page.items.map((item) => item.title)).toEqual([
      "网络阅读器",
      "RSS 阅读器",
      "老黄历",
      "图片查看器",
      "百度地图",
      "墨水屏测试",
      "使用指南",
      "时钟",
    ]);
    for (const item of home.content.page.items) {
      if (item.link?.target.kind === "document") {
        expect(byUuid.has(item.link.target.documentId)).toBe(true);
        expect(byUuid.get(item.link.target.documentId)?.parentUuid).toBe(PAPERS3_HOME_ENTRY_UUID);
      }
    }
    expect(home.content.page.items.flatMap((item) =>
      item.link?.target.kind === "url" ? [item.link.target.url] : []
    )).toEqual([
      "inkos://collection/website",
      "inkos://collection/rss",
      "inkos://app/random-image",
      "inkos://app/baidu-map",
    ]);

    const paperS3 = getScreenProfile("m5stack-paper-s3-portrait");
    const portraitLayout = layoutSemanticDocument(home.content, paperS3);
    expect(portraitLayout.pages).toHaveLength(1);
    const portraitInteractions = portraitLayout.pages.flatMap((page) => page.interactions)
      .filter((interaction) => /^page\.items\[\d+\]\.link$/u.test(interaction.contentPath));
    const portraitSvg = portraitLayout.pages[0].svg;
    expect(new Set(portraitInteractions.map((interaction) => interaction.bounds.x)).size).toBe(2);
    expect(portraitSvg).toMatch(
      /<text[^>]*font-weight="700"[^>]*>InkOS - PaperS3 应用首页<\/text>/u,
    );
    expect(portraitLayout.pages.flatMap((page) => page.interactions)).toContainEqual(
      expect.objectContaining({
        contentPath: "page.navigation[0]",
        action: { type: "open-url", url: "inkos://device/settings" },
      }),
    );
    expect(portraitSvg).toMatch(/<text[^>]*font-weight="700"[^>]*>网络阅读器<\/text>/u);
    expect(portraitSvg).not.toMatch(/>PaperS3 应用首页<\/text>/u);

    const landscapeLayout = layoutSemanticDocument(
      home.content,
      orientScreenProfile(paperS3, "landscape"),
      { displayMeta: { orientation: "landscape", fontLevel: 0, invert: false } },
    );
    const landscapeInteractions = landscapeLayout.pages.flatMap((page) => page.interactions)
      .filter((interaction) => /^page\.items\[\d+\]\.link$/u.test(interaction.contentPath));
    expect(new Set(landscapeInteractions.map((interaction) => interaction.bounds.x)).size).toBe(4);

    const calendar = documents.find((document) => document.source.title === "2026 年 7 月老黄历")!;
    if (calendar.content.page.kind !== "list") throw new Error("Expected calendar list");
    expect(calendar.content.page).toMatchObject({ layout: "grid", title: "2026 年 7 月" });
    expect(calendar.content.page.items).toHaveLength(42);
    expect(calendar.content.page.items.slice(0, 7).map((item) => item.eyebrow))
      .toEqual(["周一", "周二", "周三", "周四", "周五", "周六", "周日"]);

    const clock = documents.find((document) => document.source.title === "时钟")!;
    expect(clock.localWidgets).toEqual([{
      id: "clock-main",
      kind: "clock",
      contentPath: "page.title",
      format: "HH:mm:ss",
      timezone: "Asia/Shanghai",
      refreshMs: 1_000,
      fullRefreshEvery: 60,
    }]);
    expect(clock.content.page).toMatchObject({
      kind: "detail",
      layout: "postcard",
      eyebrow: "2026 年 7 月 16 日 · 星期四",
      title: "校时中",
    });
    expect(clock.content.page).not.toHaveProperty("summary");
    if (clock.content.page.kind !== "detail") throw new Error("Expected clock detail");
    expect(clock.content.page.content).toEqual([{
      type: "paragraph",
      text: "Asia/Shanghai · UTC+08:00",
    }]);
    expect(JSON.stringify(clock.content)).not.toContain("静态占位");
    expect(JSON.stringify(clock.content)).not.toContain("渲染区域");
    const clockLayout = layoutSemanticDocument(clock.content, paperS3, {
      localWidgets: clock.localWidgets,
    });
    expect(clockLayout.pages).toHaveLength(1);
    expect(clockLayout.pages[0].svg).not.toContain("1 / 1");
    expect(clockLayout.pages[0].svg).not.toContain("88:88:88");
    expect(clockLayout.pages[0].svg).not.toContain("校时中");
    const clockTitleRegion = clockLayout.pages[0].textRegions.find((region) =>
      region.contentPath === "page.title"
    );
    expect(clockTitleRegion?.style.fontSize).toBeGreaterThan(70);
    expect(clockTitleRegion?.bounds.height).toBeGreaterThanOrEqual(140);
    expect(clockTitleRegion?.bounds.height).toBeLessThanOrEqual(170);
    const clockDateRegion = clockLayout.pages[0].textRegions.find((region) =>
      region.contentPath === "page.eyebrow"
    );
    expect(clockDateRegion?.style.fontSize).toBeGreaterThanOrEqual(30);
    expect(clockDateRegion?.style.fontWeight).toBe(700);

    const displayTest = documents.find((document) => document.source.title === "墨水屏测试")!;
    const contain = documents.find((document) =>
      document.source.title === "原生像素测试 · 完整适配"
    )!;
    const cover = documents.find((document) =>
      document.source.title === "原生像素测试 · 满屏裁剪"
    )!;
    const portrait = documents.find((document) =>
      document.source.title === "竖屏原生像素测试 · 540×960"
    )!;
    if (displayTest.content.page.kind !== "detail") throw new Error("Expected display test detail");
    expect(displayTest.content.page.content.filter((block) => block.type === "link"))
      .toEqual([
        expect.objectContaining({
          link: expect.objectContaining({
            target: { kind: "document", documentId: portrait.uuid },
          }),
        }),
        expect.objectContaining({
          link: expect.objectContaining({
            target: { kind: "document", documentId: contain.uuid },
          }),
        }),
        expect.objectContaining({
          link: expect.objectContaining({
            target: { kind: "document", documentId: cover.uuid },
          }),
        }),
      ]);
    expect(portrait.parentUuid).toBe(displayTest.uuid);
    expect(contain.parentUuid).toBe(displayTest.uuid);
    expect(cover.parentUuid).toBe(displayTest.uuid);
    expect(contain.content.page).toMatchObject({
      kind: "image",
      layout: "contain",
      image: { source: { kind: "asset", assetId: PAPERS3_CALIBRATION_ASSET_ID } },
    });
    expect(cover.content.page).toMatchObject({
      kind: "image",
      layout: "cover",
      image: { source: { kind: "asset", assetId: PAPERS3_CALIBRATION_ASSET_ID } },
    });
    expect(portrait.content.page).toMatchObject({
      kind: "image",
      layout: "contain",
      image: { source: { kind: "asset", assetId: PAPERS3_PORTRAIT_CALIBRATION_ASSET_ID } },
    });
    const today = calendar.content.page.items.find((item) => item.id === "calendar-2026-07-16")!;
    expect(today.summary).toBe("初三");
    expect(today.metadata).toContainEqual({ label: "状态", value: "今天" });
    const calendarLayout = layoutSemanticDocument(calendar.content, paperS3);
    expect(calendarLayout.pages.flatMap((page) => page.svg.match(/fill="#444444"/gu) ?? []))
      .toHaveLength(1);
    expect(calendarLayout.pages.some((page) =>
      /fill="#444444"[^>]*stroke="#111111"/u.test(page.svg)
      && /fill="#FFFFFF"[^>]*>16<\/text>/u.test(page.svg)
    )).toBe(true);
    for (const item of calendar.content.page.items) {
      expect(item.link?.target.kind).toBe("document");
      if (item.link?.target.kind === "document") {
        expect(byUuid.has(item.link.target.documentId)).toBe(true);
        expect(byUuid.get(item.link.target.documentId)?.parentUuid).toBe(calendar.uuid);
      }
    }
  });

  it("generates known lunar and traditional almanac fields locally with an explicit source", () => {
    const daily = paperS3HomeDocuments({ year: 2026, month: 7, day: 16 })
      .find((document) => document.source.title === "2026-07-16 黄历")!;
    expect(daily.source).toMatchObject({
      url: "https://github.com/6tail/lunar-javascript",
      license: "MIT",
    });
    expect(daily.content.page).toMatchObject({
      kind: "detail",
      eyebrow: "农历六月初三",
      summary: "星期四 · 丙午年 乙未月 辛卯日",
    });
    if (daily.content.page.kind !== "detail") throw new Error("Expected daily detail");
    const text = daily.content.page.content.map((block) =>
      block.type === "paragraph" ? block.text : block.type === "list" ? block.items.join("、") : ""
    ).join("\n");
    expect(text).toContain("嫁娶");
    expect(text).toContain("掘井");
    expect(text).toContain(PAPERS3_HOME_LUNAR_LIBRARY);
    expect(text).toContain("不调用外网 API");
    expect(text).toContain("仅供参考");
  });

  it("builds compact portrait and landscape variants and passes full archive/hash/sidecar validation", async () => {
    const built = await buildPaperS3HomePackage({ year: 2026, month: 7, day: 16 });
    expect(built.manifest).toMatchObject({
      packageId: PAPERS3_HOME_PACKAGE_ID,
      entryUuid: PAPERS3_HOME_ENTRY_UUID,
      revision: 20260716,
      createdAt: "2026-07-16T00:00:00+08:00",
      generator: { name: "inkos-papers3-home", version: "1.7.2" },
    });
    expect(built.manifest.variants).toHaveLength(2);
    expect(built.manifest.compatibility.requiredCapabilities).toEqual([
      "navigation.parent-v1",
      "navigation.hitbox-v1",
      "display.font-level-v1",
      "device.settings-v1",
      "content-ota.atomic-v1",
    ]);
    expect(built.manifest.variants).toEqual(expect.arrayContaining([
      expect.objectContaining({
        profileId: "m5stack-paper-s3-portrait",
        displayMeta: { orientation: "portrait", fontLevel: 0, invert: false },
        logicalSize: { width: 540, height: 960 },
        displayRotation: 90,
        pixelFormat: "gray4",
      }),
      expect.objectContaining({
        profileId: "m5stack-paper-s3-portrait",
        displayMeta: { orientation: "landscape", fontLevel: 0, invert: false },
        logicalSize: { width: 960, height: 540 },
        displayRotation: 0,
        pixelFormat: "gray4",
      }),
    ]));
    expect(built.manifest.documents).toHaveLength(50);
    // The immutable fallback must also fit either raw A/B uploaded-home slot,
    // so the same package can be selected as a device-storage demo.
    expect(built.archive.byteLength).toBeLessThan(0x440000);
    expect(await sha256Hex(built.archive)).toBe(built.sha256);

    const archive = await readInkArchive(built.archive);
    expect(archive.manifest).toEqual(built.manifest);
    expect(archive.documents.size).toBe(50);

    const clock = [...archive.documents.values()]
      .find((document) => document.source.title === "时钟")!;
    const contain = [...archive.documents.values()]
      .find((document) => document.source.title === "原生像素测试 · 完整适配")!;
    const cover = [...archive.documents.values()]
      .find((document) => document.source.title === "原生像素测试 · 满屏裁剪")!;
    const portrait = [...archive.documents.values()]
      .find((document) => document.source.title === "竖屏原生像素测试 · 540×960")!;
    for (const variant of built.manifest.variants) {
      const rootInteractions = [...archive.sidecars.values()]
        .filter((sidecar) =>
          sidecar.documentUuid === PAPERS3_HOME_ENTRY_UUID && sidecar.variantId === variant.id
        )
        .flatMap((sidecar) => inkFrameSidecarSchema.parse(sidecar).interactions);
      expect(rootInteractions).toHaveLength(9);
      expect(rootInteractions.flatMap((interaction) =>
        interaction.targetUrl ? [interaction.targetUrl] : []
      )).toEqual([
        "inkos://device/settings",
        "inkos://collection/website",
        "inkos://collection/rss",
        "inkos://app/random-image",
        "inkos://app/baidu-map",
      ]);

      const clockSidecars = [...archive.sidecars.values()].filter((sidecar) =>
        sidecar.documentUuid === clock.uuid && sidecar.variantId === variant.id
      );
      expect(clockSidecars).toHaveLength(1);
      expect(clockSidecars[0].pageCount).toBe(1);
      expect(clockSidecars[0].dynamicRegions).toEqual([
        expect.objectContaining({
          id: "clock-main",
          kind: "clock",
          format: "HH:mm:ss",
          timezone: "Asia/Shanghai",
          refreshMs: 1_000,
          fullRefreshEvery: 60,
          style: expect.objectContaining({
            fontFamily: "monospace",
            fontSize: expect.any(Number),
            fontWeight: 400,
            textAlign: "center",
            verticalAlign: "middle",
            foreground: "black",
            background: "white",
          }),
        }),
      ]);
      const clockRegion = clockSidecars[0].dynamicRegions?.[0];
      expect(clockRegion?.style.fontSize).toBeGreaterThan(60);
      expect(clockRegion!.style.fontSize).toBeLessThanOrEqual(
        Math.floor(clockRegion!.bounds.height * 0.72),
      );
    }

    const frameFor = (documentUuid: string, orientation: "portrait" | "landscape") => {
      const variant = built.manifest.variants.find((candidate) =>
        candidate.displayMeta.orientation === orientation
      )!;
      const document = built.manifest.documents.find((candidate) =>
        candidate.uuid === documentUuid
      )!;
      const page = document.variants.find((candidate) => candidate.variantId === variant.id)!
        .pages[0];
      const frame = built.files.get(page.imagePath);
      if (!frame) throw new Error(`Missing calibration frame '${page.imagePath}'`);
      return frame;
    };
    const nativeContain = await sharp(frameFor(contain.uuid, "landscape"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(nativeContain.info).toMatchObject({ width: 960, height: 540 });
    const nativeGrayValues = new Set<number>();
    for (let offset = 0; offset < nativeContain.data.length; offset += nativeContain.info.channels) {
      nativeGrayValues.add(nativeContain.data[offset]);
    }
    expect(nativeGrayValues.size).toBe(16);

    const nativePortrait = await sharp(frameFor(portrait.uuid, "portrait"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(nativePortrait.info).toMatchObject({ width: 540, height: 960 });
    const portraitGrayValues = new Set<number>();
    for (let offset = 0; offset < nativePortrait.data.length; offset += nativePortrait.info.channels) {
      portraitGrayValues.add(nativePortrait.data[offset]);
    }
    expect(portraitGrayValues.size).toBe(16);

    const portraitContain = await sharp(frameFor(contain.uuid, "portrait"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const portraitCover = await sharp(frameFor(cover.uuid, "portrait"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const topCenter = (decoded: typeof portraitContain) =>
      decoded.data[(20 * decoded.info.width + Math.floor(decoded.info.width / 2))
        * decoded.info.channels];
    // Gray4 PNG palette entries sit at M5GFX bucket centers. Index 15 decodes
    // to 248 in software, then Panel_EPD maps it to exact panel white.
    expect(topCenter(portraitContain)).toBe(248);
    expect(topCenter(portraitCover)).toBeLessThan(248);
    expect([...archive.sidecars.values()]
      .filter((sidecar) => sidecar.documentUuid !== clock.uuid)
      .every((sidecar) => sidecar.dynamicRegions === undefined)).toBe(true);
  }, 60_000);

  it("atomically publishes into the existing catalog and serves declared artifacts", async () => {
    const dataDir = await temporaryDataDirectory();
    const date = currentShanghaiCalendarDate();
    const publication = await ensurePaperS3HomePackage({ dataDir, date });
    expect(publication).toMatchObject({
      packageId: PAPERS3_HOME_PACKAGE_ID,
      entryUuid: PAPERS3_HOME_ENTRY_UUID,
      revision: date.year * 10_000 + date.month * 100 + date.day,
    });
    expect(await ensurePaperS3HomePackage({ dataDir, date })).toEqual(publication);

    const catalog = await listInkCatalogPackages({ dataDir });
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      packageId: PAPERS3_HOME_PACKAGE_ID,
      entryUuid: PAPERS3_HOME_ENTRY_UUID,
      revision: publication.revision,
      fileName: publication.fileName,
    });
    const loaded = (await getInkCatalogPackage(PAPERS3_HOME_PACKAGE_ID, { dataDir }))!;
    expect(getInkManifestArtifact(loaded).bytes.byteLength).toBeGreaterThan(0);
    expect(getInkDocumentArtifact(loaded, PAPERS3_HOME_ENTRY_UUID)?.bytes.byteLength).toBeGreaterThan(0);
    const variantId = loaded.manifest.variants[0].id;
    expect(getInkFrameArtifact(loaded, variantId, PAPERS3_HOME_ENTRY_UUID, 0)?.contentType)
      .toBe("image/png");
    expect(getInkDownloadArtifact(loaded).bytes).toEqual(loaded.archive);
  }, 60_000);

  it("pins canonical firmware bytes and release identity across wall-clock dates", async () => {
    const dataDir = await temporaryDataDirectory();
    const releaseDate = { year: 2026, month: 7, day: 19 };
    const canonical = await buildPaperS3HomePackage(releaseDate);
    const canonicalPath = path.join(dataDir, "firmware-home.ink");
    await writeFile(canonicalPath, canonical.archive);

    // Repack the same fully valid package with a different compression policy.
    // Identity fields and semantic validation still pass, but the archive SHA
    // deliberately differs from the release-pinned firmware artifact.
    const staleArchive = zipSync(unzipSync(canonical.archive), { level: 0 });
    const staleSha256 = await sha256Hex(staleArchive);
    expect(staleSha256).not.toBe(canonical.sha256);
    expect((await readInkArchive(staleArchive)).manifest.packageId).toBe(PAPERS3_HOME_PACKAGE_ID);

    const jobId = uuidV5("builtin-job:2026-07", PAPERS3_HOME_PACKAGE_ID);
    const jobDirectory = path.join(dataDir, "jobs", jobId);
    const fileName = "papers3-home-2026-07-19-r20260719.ink";
    const timestamp = "2026-07-19T00:00:00+08:00";
    const urls = generatorJobUrls(jobId);
    const staleJob = generatorJobSchema.parse({
      schemaVersion: "inkos.generator-job/v1",
      jobId,
      status: "complete",
      phase: "complete",
      progress: { completed: 1, total: 1, message: "同版本旧首页" },
      createdAt: timestamp,
      updatedAt: timestamp,
      statusUrl: urls.statusUrl,
      eventsUrl: urls.eventsUrl,
      artifactUrl: urls.artifactUrl,
      package: {
        packageId: PAPERS3_HOME_PACKAGE_ID,
        fileName,
        bytes: staleArchive.byteLength,
        sha256: staleSha256,
      },
    });
    await mkdir(jobDirectory, { recursive: true });
    await writeFile(path.join(jobDirectory, "artifact.ink"), staleArchive);
    await writeFile(path.join(jobDirectory, "job.json"), JSON.stringify(staleJob));

    const publication = await ensurePaperS3HomePackage({
      dataDir,
      date: { year: 2026, month: 7, day: 20 },
      canonicalArchivePath: canonicalPath,
    });
    expect(publication).toMatchObject({ revision: 20260719, jobId, fileName });
    expect(await ensurePaperS3HomePackage({
      dataDir,
      date: { year: 2026, month: 8, day: 1 },
      canonicalArchivePath: canonicalPath,
    })).toEqual(publication);
    const published = new Uint8Array(await readFile(path.join(jobDirectory, "artifact.ink")));
    expect(published).toEqual(canonical.archive);
    expect(await sha256Hex(published)).toBe(canonical.sha256);
    expect((await listInkCatalogPackages({ dataDir }))[0]).toMatchObject({
      bytes: canonical.archive.byteLength,
      sha256: canonical.sha256,
    });
  }, 60_000);

  it("rebuilds a same-day archive produced by an older home generator", async () => {
    const dataDir = await temporaryDataDirectory();
    const date = { year: 2026, month: 7, day: 16 };
    const current = await buildPaperS3HomePackage(date);
    const portraitVariant = current.manifest.variants.find((variant) =>
      variant.displayMeta.orientation === "portrait"
    )!;
    const oldDocuments = current.manifest.documents.map((document) => ({
      ...document,
      variants: document.variants.filter((variant) => variant.variantId === portraitVariant.id),
    }));
    const oldManifest = {
      ...current.manifest,
      generator: { name: "inkos-papers3-home", version: "1.2.0" },
      variants: [portraitVariant],
      documents: oldDocuments,
    };
    const oldPaths = new Set(oldDocuments.flatMap((document) => [
      document.documentPath,
      ...document.variants.flatMap((variant) => variant.pages.flatMap((page) => [
        page.imagePath,
        page.sidecarPath,
      ])),
    ]));
    const oldFiles = new Map([...current.files].filter(([filePath]) => oldPaths.has(filePath)));
    const oldArchive = await buildInkArchive(oldManifest, oldFiles);
    const oldSha256 = await sha256Hex(oldArchive);
    const jobId = uuidV5("builtin-job:2026-07", PAPERS3_HOME_PACKAGE_ID);
    const jobDirectory = path.join(dataDir, "jobs", jobId);
    const fileName = "papers3-home-2026-07-16-r20260716.ink";
    const timestamp = "2026-07-16T00:00:00+08:00";
    const urls = generatorJobUrls(jobId);
    const oldJob = generatorJobSchema.parse({
      schemaVersion: "inkos.generator-job/v1",
      jobId,
      status: "complete",
      phase: "complete",
      progress: { completed: 1, total: 1, message: "旧版首页" },
      createdAt: timestamp,
      updatedAt: timestamp,
      statusUrl: urls.statusUrl,
      eventsUrl: urls.eventsUrl,
      artifactUrl: urls.artifactUrl,
      package: {
        packageId: PAPERS3_HOME_PACKAGE_ID,
        fileName,
        bytes: oldArchive.byteLength,
        sha256: oldSha256,
      },
    });
    await mkdir(jobDirectory, { recursive: true });
    await writeFile(path.join(jobDirectory, "artifact.ink"), oldArchive);
    await writeFile(path.join(jobDirectory, "job.json"), JSON.stringify(oldJob));

    await ensurePaperS3HomePackage({ dataDir, date });
    const refreshedBytes = new Uint8Array(await readFile(path.join(jobDirectory, "artifact.ink")));
    const refreshed = await readInkArchive(refreshedBytes);
    expect(await sha256Hex(refreshedBytes)).not.toBe(oldSha256);
    expect(refreshed.manifest.generator).toEqual({
      name: "inkos-papers3-home",
      version: "1.7.2",
    });
    expect(refreshed.manifest.variants.map((variant) => variant.displayMeta.orientation))
      .toEqual(["portrait", "landscape"]);
  }, 60_000);

  it("moves the old-almanac today marker and revision without accumulating daily jobs", async () => {
    const dataDir = await temporaryDataDirectory();
    const july16 = { year: 2026, month: 7, day: 16 };
    const july17 = { year: 2026, month: 7, day: 17 };

    const first = await ensurePaperS3HomePackage({ dataDir, date: july16 });
    const firstCatalog = await listInkCatalogPackages({ dataDir });
    expect(first.revision).toBe(20260716);
    expect(firstCatalog[0]).toMatchObject({ revision: 20260716, fileName: first.fileName });

    const second = await ensurePaperS3HomePackage({ dataDir, date: july17 });
    const secondCatalog = await listInkCatalogPackages({ dataDir });
    expect(second.jobId).toBe(first.jobId);
    expect(second.revision).toBe(20260717);
    expect(second.fileName).not.toBe(first.fileName);
    expect(secondCatalog).toHaveLength(1);
    expect(secondCatalog[0]).toMatchObject({ revision: 20260717, fileName: second.fileName });

    const july16Home = paperS3HomeDocuments(july16)[0];
    const july17Home = paperS3HomeDocuments(july17)[0];
    if (july16Home.content.page.kind !== "list" || july17Home.content.page.kind !== "list") {
      throw new Error("Expected list homes");
    }
    expect(july16Home.content.revision).toBe(20260716);
    expect(july17Home.content.revision).toBe(20260717);
    const july16Calendar = paperS3HomeDocuments(july16)
      .find((document) => document.source.title === "2026 年 7 月老黄历")!;
    const july17Calendar = paperS3HomeDocuments(july17)
      .find((document) => document.source.title === "2026 年 7 月老黄历")!;
    if (july16Calendar.content.page.kind !== "list"
        || july17Calendar.content.page.kind !== "list") {
      throw new Error("Expected old-almanac list documents");
    }
    expect(july16Calendar.content.revision).toBe(20260716);
    expect(july17Calendar.content.revision).toBe(20260717);
    expect(july16Calendar.content.page.items.find((item) =>
      item.metadata?.some((entry) => entry.label === "状态" && entry.value === "今天")
    )?.id).toBe("calendar-2026-07-16");
    expect(july17Calendar.content.page.items.find((item) =>
      item.metadata?.some((entry) => entry.label === "状态" && entry.value === "今天")
    )?.id).toBe("calendar-2026-07-17");
  }, 60_000);
});
