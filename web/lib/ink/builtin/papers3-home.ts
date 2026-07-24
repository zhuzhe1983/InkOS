import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { Solar } from "lunar-javascript";

import { RenderEngine } from "../../rendering/engine";
import {
  INKOS_CLIENT_APP_URLS,
  INKOS_CLIENT_COLLECTION_URLS,
  INKOS_CLIENT_DEVICE_URLS,
} from "../../rendering/contracts";
import { sha256Hex, readInkArchive } from "../archive";
import { packagedDocument, type PackagedDocument } from "../contracts";
import {
  buildRenderedInkPackage,
  createInkDisplayVariant,
  type BuiltInkPackage,
} from "../package-builder";
import { uuidV5 } from "../uuid";
import { generatorJobSchema, generatorJobUrls } from "../generator/contracts";
import {
  PAPERS3_HOME_ENTRY_UUID,
  PAPERS3_HOME_PACKAGE_ID,
} from "./papers3-home-identity";
import {
  PAPERS3_CALIBRATION_ASSET_ID,
  PAPERS3_PORTRAIT_CALIBRATION_ASSET_ID,
  paperS3HomeAssetResolver,
} from "./papers3-calibration-asset";

export {
  PAPERS3_HOME_ENTRY_UUID,
  PAPERS3_HOME_PACKAGE_ID,
} from "./papers3-home-identity";
export const PAPERS3_HOME_GENERATOR_VERSION = "1.7.2";
export const PAPERS3_HOME_LUNAR_LIBRARY = "lunar-javascript 1.7.7";

const LUNAR_SOURCE_URL = "https://github.com/6tail/lunar-javascript";
const PAPER_S3_PROFILE_ID = "m5stack-paper-s3-portrait";
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const [RSS_COLLECTION_URL, WEBSITE_COLLECTION_URL] =
  INKOS_CLIENT_COLLECTION_URLS;
const [RANDOM_IMAGE_APP_URL, BAIDU_MAP_APP_URL] = INKOS_CLIENT_APP_URLS;
const [SETTINGS_DEVICE_URL] = INKOS_CLIENT_DEVICE_URLS;

const CALENDAR_DOCUMENT_UUID = uuidV5("document:month-calendar", PAPERS3_HOME_PACKAGE_ID);
const DISPLAY_TEST_DOCUMENT_UUID = uuidV5("document:display-test", PAPERS3_HOME_PACKAGE_ID);
const DISPLAY_TEST_CONTAIN_UUID = uuidV5(
  "document:display-test-native-contain",
  PAPERS3_HOME_PACKAGE_ID,
);
const DISPLAY_TEST_COVER_UUID = uuidV5(
  "document:display-test-native-cover",
  PAPERS3_HOME_PACKAGE_ID,
);
const DISPLAY_TEST_PORTRAIT_UUID = uuidV5(
  "document:display-test-portrait-native",
  PAPERS3_HOME_PACKAGE_ID,
);
const GUIDE_DOCUMENT_UUID = uuidV5("document:user-guide", PAPERS3_HOME_PACKAGE_ID);
const CLOCK_DOCUMENT_UUID = uuidV5("document:clock", PAPERS3_HOME_PACKAGE_ID);
const paperS3HomeRenderEngine = new RenderEngine({ assetResolver: paperS3HomeAssetResolver });

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;
const FULL_WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"] as const;

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

export interface EnsurePaperS3HomeOptions {
  dataDir?: string;
  date?: CalendarDate;
  /**
   * Optional release-pinned archive. When configured, publication must match
   * this archive byte-for-byte instead of accepting any same-day home build.
   * Production uses the exact archive embedded in the PaperS3 firmware so the
   * online catalog and offline fallback cannot share an identity while serving
   * different content.
   */
  canonicalArchivePath?: string;
}

export interface PaperS3HomePublication {
  packageId: string;
  entryUuid: string;
  revision: number;
  jobId: string;
  fileName: string;
}

interface CalendarCell extends CalendarDate {
  inCurrentMonth: boolean;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function monthKey(date: CalendarDate): string {
  return `${date.year}-${twoDigits(date.month)}`;
}

function dateKey(date: CalendarDate): string {
  return `${monthKey(date)}-${twoDigits(date.day)}`;
}

function revisionForDate(date: CalendarDate): number {
  return date.year * 10_000 + date.month * 100 + date.day;
}

function createdAtForDate(date: CalendarDate): string {
  return `${dateKey(date)}T00:00:00+08:00`;
}

function updatedAtForDate(date: CalendarDate): string {
  return `${dateKey(date)}T00:00:00+08:00`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function assertCalendarDate(date: CalendarDate): CalendarDate {
  if (!Number.isInteger(date.year) || date.year < 1900 || date.year > 2099) {
    throw new Error("PaperS3 home calendar supports years 1900 through 2099");
  }
  if (!Number.isInteger(date.month) || date.month < 1 || date.month > 12) {
    throw new Error("PaperS3 home calendar month must be between 1 and 12");
  }
  if (!Number.isInteger(date.day) || date.day < 1 || date.day > daysInMonth(date.year, date.month)) {
    throw new Error("PaperS3 home calendar day is outside the selected month");
  }
  return date;
}

export function currentShanghaiCalendarDate(now = new Date()): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => {
    const part = parts.find((candidate) => candidate.type === type)?.value;
    if (!part) throw new Error(`Unable to resolve Shanghai calendar ${type}`);
    return Number(part);
  };
  return assertCalendarDate({ year: value("year"), month: value("month"), day: value("day") });
}

function shiftDate(date: CalendarDate, offset: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + offset));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function calendarCells(date: CalendarDate): CalendarCell[] {
  const firstDay = { year: date.year, month: date.month, day: 1 };
  const sundayBasedWeekday = new Date(Date.UTC(date.year, date.month - 1, 1)).getUTCDay();
  const mondayBasedOffset = (sundayBasedWeekday + 6) % 7;
  const gridStart = shiftDate(firstDay, -mondayBasedOffset);
  return Array.from({ length: 42 }, (_unused, index) => {
    const cell = shiftDate(gridStart, index);
    return { ...cell, inCurrentMonth: cell.year === date.year && cell.month === date.month };
  });
}

function dailyDocumentUuid(date: CalendarDate): string {
  return uuidV5(`document:huangli:${dateKey(date)}`, PAPERS3_HOME_PACKAGE_ID);
}

function source(title: string, retrievedAt: string, url?: string): PackagedDocument["source"] {
  return {
    title,
    retrievedAt,
    ...(url ? { url } : {}),
  };
}

function homeDocument(date: CalendarDate, createdAt: string): PackagedDocument {
  const apps = [
    {
      id: "app-network-reader",
      eyebrow: "网络",
      title: "网络阅读器",
      summary: "打开设备中保存的网站收藏",
      target: { kind: "url" as const, url: WEBSITE_COLLECTION_URL },
    },
    {
      id: "app-rss-reader",
      eyebrow: "订阅",
      title: "RSS 阅读器",
      summary: "打开设备中保存的 RSS 与 Atom 订阅",
      target: { kind: "url" as const, url: RSS_COLLECTION_URL },
    },
    {
      id: "app-calendar",
      eyebrow: "日期",
      title: "老黄历",
      summary: `${date.year} 年 ${date.month} 月，点日期查看当日黄历`,
      target: { kind: "document" as const, documentId: CALENDAR_DOCUMENT_UUID },
    },
    {
      id: "app-random-image",
      eyebrow: "图片",
      title: "图片查看器",
      summary: "按设备图片列表逐页浏览；随机来源每次进入换图",
      target: { kind: "url" as const, url: RANDOM_IMAGE_APP_URL },
    },
    {
      id: "app-baidu-map",
      eyebrow: "地图",
      title: "百度地图",
      summary: "基于出口 IP 推测位置，显示墨水屏高对比地图",
      target: { kind: "url" as const, url: BAIDU_MAP_APP_URL },
    },
    {
      id: "app-display-test",
      eyebrow: "设备",
      title: "墨水屏测试",
      summary: "字号、线条、分页与十六级灰阶检查",
      target: { kind: "document" as const, documentId: DISPLAY_TEST_DOCUMENT_UUID },
    },
    {
      id: "app-guide",
      eyebrow: "帮助",
      title: "使用指南",
      summary: "联网抓取、离线包、旋转与导航说明",
      target: { kind: "document" as const, documentId: GUIDE_DOCUMENT_UUID },
    },
    {
      id: "app-clock",
      eyebrow: "本地组件",
      title: "时钟",
      summary: "大号时间、日期、星期与时区",
      target: { kind: "document" as const, documentId: CLOCK_DOCUMENT_UUID },
    },
  ] as const;

  return packagedDocument({
    uuid: PAPERS3_HOME_ENTRY_UUID,
    source: source("InkOS 应用", createdAt),
    content: {
      schemaVersion: "inkos.content/v2",
      id: PAPERS3_HOME_ENTRY_UUID,
      revision: revisionForDate(date),
      locale: "zh-CN",
      updatedAt: createdAt,
      page: {
        kind: "list",
        layout: "grid",
        title: "InkOS - PaperS3 应用首页",
        navigation: [{
          label: "设置",
          target: { kind: "url", url: SETTINGS_DEVICE_URL },
        }],
        items: apps.map((app) => ({
          id: app.id,
          eyebrow: app.eyebrow,
          title: app.title,
          summary: app.summary,
          link: {
            label: `打开${app.title}`,
            target: app.target,
          },
        })),
      },
    },
  });
}

function calendarDocument(date: CalendarDate, createdAt: string, cells: CalendarCell[]): PackagedDocument {
  return packagedDocument({
    uuid: CALENDAR_DOCUMENT_UUID,
    parentUuid: PAPERS3_HOME_ENTRY_UUID,
    source: source(`${date.year} 年 ${date.month} 月老黄历`, createdAt, LUNAR_SOURCE_URL),
    content: {
      schemaVersion: "inkos.content/v2",
      id: CALENDAR_DOCUMENT_UUID,
      revision: revisionForDate(date),
      locale: "zh-CN",
      updatedAt: createdAt,
      page: {
        kind: "list",
        layout: "grid",
        title: `${date.year} 年 ${date.month} 月`,
        description: "完整六周老黄历；深灰日期是今天，点任意日期查看当日农历与传统宜忌。",
        items: cells.map((cell, index) => {
          const lunar = Solar.fromYmd(cell.year, cell.month, cell.day).getLunar();
          const isToday = cell.year === date.year
            && cell.month === date.month
            && cell.day === date.day;
          return {
            id: `calendar-${dateKey(cell)}`,
            eyebrow: WEEKDAYS[index % 7],
            title: String(cell.day),
            summary: `${cell.inCurrentMonth ? "" : `${cell.month}月 · `}${lunar.getDayInChinese()}`,
            metadata: [
              { label: "农历", value: `${lunar.getMonthInChinese()}月` },
              ...(isToday ? [{ label: "状态", value: "今天" }] : []),
            ],
            link: {
              label: `查看 ${cell.year} 年 ${cell.month} 月 ${cell.day} 日黄历`,
              target: { kind: "document" as const, documentId: dailyDocumentUuid(cell) },
            },
          };
        }),
      },
    },
  });
}

function weekdayFor(date: CalendarDate): string {
  return FULL_WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()];
}

function joinOrNone(values: string[]): string {
  return values.length ? values.join("、") : "无";
}

function huangliDocument(
  date: CalendarDate,
  createdAt: string,
  uuid: string,
  parentUuid: string,
  sourceTitle: string,
): PackagedDocument {
  const lunar = Solar.fromYmd(date.year, date.month, date.day).getLunar();
  const jieQi = lunar.getJieQi();
  const festivals = [...lunar.getFestivals(), ...lunar.getOtherFestivals()];
  const yi = joinOrNone(lunar.getDayYi());
  const ji = joinOrNone(lunar.getDayJi());
  const traditionalNotes = [
    `${lunar.getZhiXing()}日 · ${lunar.getDayTianShen()}（${lunar.getDayTianShenType()}，${lunar.getDayTianShenLuck()}）`,
    `冲${lunar.getDayChongDesc()} · 煞${lunar.getDaySha()}`,
    lunar.getPengZuGan(),
    lunar.getPengZuZhi(),
  ];
  if (jieQi) traditionalNotes.push(`节气：${jieQi}`);
  if (festivals.length) traditionalNotes.push(`节日：${festivals.join("、")}`);

  return packagedDocument({
    uuid,
    parentUuid,
    source: {
      ...source(sourceTitle, createdAt, LUNAR_SOURCE_URL),
      license: "MIT",
    },
    content: {
      schemaVersion: "inkos.content/v2",
      id: uuid,
      revision: revisionForDate(date),
      locale: "zh-CN",
      updatedAt: updatedAtForDate(date),
      page: {
        kind: "detail",
        layout: "article",
        eyebrow: `农历${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`,
        title: `${date.year} 年 ${date.month} 月 ${date.day} 日`,
        summary: `${weekdayFor(date)} · ${lunar.getYearInGanZhi()}年 ${lunar.getMonthInGanZhi()}月 ${lunar.getDayInGanZhi()}日`,
        content: [
          { type: "heading", level: 2, text: "历法" },
          {
            type: "list",
            ordered: false,
            items: [
              `公历：${date.year} 年 ${date.month} 月 ${date.day} 日 ${weekdayFor(date)}`,
              `农历：${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`,
              `干支：${lunar.getYearInGanZhi()}年 ${lunar.getMonthInGanZhi()}月 ${lunar.getDayInGanZhi()}日`,
              `生肖：${lunar.getYearShengXiao()}`,
            ],
          },
          { type: "heading", level: 2, text: "宜" },
          { type: "paragraph", text: yi },
          { type: "heading", level: 2, text: "忌" },
          { type: "paragraph", text: ji },
          { type: "heading", level: 2, text: "传统参考" },
          { type: "list", ordered: false, items: traditionalNotes },
          {
            type: "paragraph",
            text: `农历、干支及宜忌由 ${PAPERS3_HOME_LUNAR_LIBRARY} 的本地确定性历法与传统历书规则生成，不调用外网 API。宜忌属于民俗文化资料，仅供参考，不构成生活、医疗、法律或财务建议。`,
          },
        ],
        links: [{
          label: "算法与数据来源（MIT）",
          target: { kind: "url", url: LUNAR_SOURCE_URL },
        }],
      },
    },
  });
}

function dailyHuangliDocument(date: CalendarCell, createdAt: string): PackagedDocument {
  return huangliDocument(
    date,
    createdAt,
    dailyDocumentUuid(date),
    CALENDAR_DOCUMENT_UUID,
    `${dateKey(date)} 黄历`,
  );
}

function clockDocument(date: CalendarDate, createdAt: string): PackagedDocument {
  return packagedDocument({
    uuid: CLOCK_DOCUMENT_UUID,
    parentUuid: PAPERS3_HOME_ENTRY_UUID,
    source: source("时钟", createdAt),
    localWidgets: [{
      id: "clock-main",
      kind: "clock",
      contentPath: "page.title",
      format: "HH:mm:ss",
      timezone: "Asia/Shanghai",
      refreshMs: 1_000,
      fullRefreshEvery: 60,
    }],
    content: {
      schemaVersion: "inkos.content/v2",
      id: CLOCK_DOCUMENT_UUID,
      revision: revisionForDate(date),
      locale: "zh-CN",
      updatedAt: createdAt,
      page: {
        kind: "detail",
        layout: "postcard",
        eyebrow: `${date.year} 年 ${date.month} 月 ${date.day} 日 · ${FULL_WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()]}`,
        title: "校时中",
        content: [
          { type: "paragraph", text: "Asia/Shanghai · UTC+08:00" },
        ],
      },
    },
  });
}

function displayTestDocument(createdAt: string): PackagedDocument {
  return packagedDocument({
    uuid: DISPLAY_TEST_DOCUMENT_UUID,
    parentUuid: PAPERS3_HOME_ENTRY_UUID,
    source: source("墨水屏测试", createdAt),
    content: {
      schemaVersion: "inkos.content/v2",
      id: DISPLAY_TEST_DOCUMENT_UUID,
      revision: 1,
      locale: "zh-CN",
      page: {
        kind: "detail",
        layout: "article",
        eyebrow: "PaperS3 · 阅读检查",
        title: "墨水屏显示测试",
        summary: "检查字级、线条、16 阶灰度、像素细节、抖动、适配与裁剪。",
        content: [
          { type: "heading", level: 2, text: "设备输出" },
          { type: "paragraph", text: "PaperS3 配置使用 gray4 像素格式，共 16 个灰度级。竖屏全像素页是 540×960 原生一比一校准图；另外两页用 960×540 横屏图检查完整适配与满屏裁剪。全部离线可用。" },
          {
            type: "link",
            link: {
              label: "打开竖屏 540×960 全像素测试",
              description: "portrait native：16 灰、渐变、半阶、照片抖动、1/2/4px 线条与棋盘。",
              target: { kind: "document", documentId: DISPLAY_TEST_PORTRAIT_UUID },
            },
          },
          {
            type: "link",
            link: {
              label: "打开完整适配测试图",
              description: "contain：始终显示完整画面，比例不变，空余区域留白。",
              target: { kind: "document", documentId: DISPLAY_TEST_CONTAIN_UUID },
            },
          },
          {
            type: "link",
            link: {
              label: "打开满屏裁剪测试图",
              description: "cover：始终铺满屏幕，比例不变，超出区域居中裁剪。",
              target: { kind: "document", documentId: DISPLAY_TEST_COVER_UUID },
            },
          },
          { type: "heading", level: 2, text: "字级检查" },
          { type: "heading", level: 3, text: "三级标题：InkOS 123 ABC" },
          { type: "paragraph", text: "正文：天地玄黄，宇宙洪荒。PaperS3 可在客户端把字号向上或向下调整两档，服务器会重新换行与分页。" },
          { type: "list", ordered: false, items: ["小号 -2", "小号 -1", "标准 0", "大号 +1", "大号 +2"] },
          { type: "heading", level: 2, text: "线条与灰阶" },
          { type: "paragraph", text: "标题分隔、列表边界和卡片描边由渲染策略生成。PaperS3 固件固定使用白底显示，图片与文字统一映射到十六级灰阶。" },
          { type: "quote", text: "结构化内容保持不变，屏幕元信息决定最终像素。", attribution: "InkOS 渲染原则" },
        ],
      },
    },
  });
}

function displayCalibrationDocument(
  uuid: string,
  layout: "contain" | "cover",
  createdAt: string,
): PackagedDocument {
  const title = layout === "contain" ? "原生像素测试 · 完整适配" : "原生像素测试 · 满屏裁剪";
  return packagedDocument({
    uuid,
    parentUuid: DISPLAY_TEST_DOCUMENT_UUID,
    source: source(title, createdAt),
    content: {
      schemaVersion: "inkos.content/v2",
      id: uuid,
      revision: 1,
      locale: "zh-CN",
      updatedAt: createdAt,
      page: {
        kind: "image",
        layout,
        image: {
          source: { kind: "asset", assetId: PAPERS3_CALIBRATION_ASSET_ID },
          alt: "原生像素灰阶、细节、渐变与抖动测试图",
        },
      },
    },
  });
}

function portraitDisplayCalibrationDocument(createdAt: string): PackagedDocument {
  return packagedDocument({
    uuid: DISPLAY_TEST_PORTRAIT_UUID,
    parentUuid: DISPLAY_TEST_DOCUMENT_UUID,
    source: source("竖屏原生像素测试 · 540×960", createdAt),
    content: {
      schemaVersion: "inkos.content/v2",
      id: DISPLAY_TEST_PORTRAIT_UUID,
      revision: 1,
      locale: "zh-CN",
      updatedAt: createdAt,
      page: {
        kind: "image",
        layout: "contain",
        image: {
          source: { kind: "asset", assetId: PAPERS3_PORTRAIT_CALIBRATION_ASSET_ID },
          alt: "PaperS3 竖屏 540×960 原生全像素灰阶、渐变、半阶、抖动、线条与棋盘测试图",
        },
      },
    },
  });
}

function guideDocument(createdAt: string): PackagedDocument {
  return packagedDocument({
    uuid: GUIDE_DOCUMENT_UUID,
    parentUuid: PAPERS3_HOME_ENTRY_UUID,
    source: source("InkOS 使用指南", createdAt),
    content: {
      schemaVersion: "inkos.content/v2",
      id: GUIDE_DOCUMENT_UUID,
      revision: 1,
      locale: "zh-CN",
      page: {
        kind: "detail",
        layout: "article",
        eyebrow: "帮助",
        title: "InkOS 使用指南",
        content: [
          { type: "heading", level: 2, text: "操作方法" },
          { type: "list", ordered: false, items: ["点卡片、列表项或链接打开内容", "向上滑看下一页，向下滑看上一页", "向左滑返回，向右滑前进", "点首页右上角齿轮进入设置；也可长按屏幕上部进入设置"] },
          { type: "heading", level: 2, text: "修改列表与首页" },
          { type: "paragraph", text: "手机或电脑与设备处于同一局域网时，打开 http://设备IP/ 进入管理后台；设备的当前管理地址会显示在设置页。" },
          { type: "paragraph", text: "管理后台可以修改 Wi-Fi、渲染服务器、RSS、网络阅读收藏和图片查看器列表，也可以上传新的首页 .ink 文件。每行填写一个名称和地址，图片查看器会按列表顺序上下翻页。" },
          { type: "heading", level: 2, text: "打开网页" },
          { type: "paragraph", text: "网页入口把 HTTPS 地址交给服务器。服务器抓取页面、提取标题/正文/图片/链接、生成结构化内容并按 UUID 缓存，再为当前屏幕渲染。" },
          { type: "heading", level: 2, text: "地图定位" },
          { type: "paragraph", text: "当前位置目前由服务器根据出口 IP 推测，只能提供大致位置，并不等同于设备 GPS。未来会增加手机通过蓝牙向 InkOS 同步 GPS 精确位置。" },
          { type: "heading", level: 2, text: "设备收藏" },
          { type: "paragraph", text: "网络阅读器、RSS 阅读器和图片查看器列表保存在设备中。普通 HTTPS 网页收藏统一归入网络阅读器；图片查看器按本机图片列表顺序分页，随机来源每次进入都会换图。首页只携带精确的 InkOS 动作，客户端不会把自定义 scheme 当成网址抓取。" },
          { type: "heading", level: 2, text: "离线与按需渲染" },
          { type: "paragraph", text: "首页包只预置 PaperS3 横竖两个基础方向、标准字号和白底显示。改字号时仅按需渲染当前文档和当前页，不预先枚举所有组合。" },
          { type: "heading", level: 2, text: "旋转与导航" },
          { type: "paragraph", text: "自动方向模式会根据设备方向请求横版或竖版帧；返回操作依据文档层级回到上一级。" },
          { type: "heading", level: 2, text: "完整性" },
          { type: "paragraph", text: "客户端下载 manifest、document、frame 和 sidecar 后会校验声明字节数与 SHA-256；下载的 .ink 压缩包也遵循同一套原子验证规则。" },
        ],
      },
    },
  });
}

export function paperS3HomeDocuments(rawDate: CalendarDate): PackagedDocument[] {
  const date = assertCalendarDate(rawDate);
  const createdAt = createdAtForDate(date);
  const cells = calendarCells(date);
  return [
    homeDocument(date, createdAt),
    calendarDocument(date, createdAt, cells),
    ...cells.map((cell) => dailyHuangliDocument(cell, createdAt)),
    displayTestDocument(createdAt),
    portraitDisplayCalibrationDocument(createdAt),
    displayCalibrationDocument(DISPLAY_TEST_CONTAIN_UUID, "contain", createdAt),
    displayCalibrationDocument(DISPLAY_TEST_COVER_UUID, "cover", createdAt),
    guideDocument(createdAt),
    clockDocument(date, createdAt),
  ];
}

export async function buildPaperS3HomePackage(rawDate: CalendarDate): Promise<BuiltInkPackage> {
  const date = assertCalendarDate(rawDate);
  const createdAt = createdAtForDate(date);
  const documents = paperS3HomeDocuments(date);
  return buildRenderedInkPackage({
    packageId: PAPERS3_HOME_PACKAGE_ID,
    slug: `papers3-home-${monthKey(date)}`,
    revision: revisionForDate(date),
    title: `InkOS PaperS3 应用 · ${date.year} 年 ${date.month} 月`,
    entryUuid: PAPERS3_HOME_ENTRY_UUID,
    createdAt,
    generator: { name: "inkos-papers3-home", version: PAPERS3_HOME_GENERATOR_VERSION },
    provenance: {
      seeds: [{
        url: LUNAR_SOURCE_URL,
        title: `${PAPERS3_HOME_LUNAR_LIBRARY} 本地历法数据与算法`,
        retrievedAt: createdAt,
        license: "MIT",
      }],
      crawl: { maxDepth: 0, maxDocuments: documents.length },
    },
    // Keep the built-in fallback compact: it carries only the two orientations
    // users can switch explicitly, not every font-level permutation.
    variants: (["portrait", "landscape"] as const).map((orientation) =>
      createInkDisplayVariant(PAPER_S3_PROFILE_ID, {
        orientation,
        fontLevel: 0,
        invert: false,
      })),
    documents,
  }, paperS3HomeRenderEngine);
}

function dataRoot(options: EnsurePaperS3HomeOptions): string {
  return path.resolve(options.dataDir ?? process.env.INKOS_DATA_DIR ?? path.join(process.cwd(), ".ink-data"));
}

function jobIdForMonth(date: CalendarDate): string {
  return uuidV5(`builtin-job:${monthKey(date)}`, PAPERS3_HOME_PACKAGE_ID);
}

function fileNameForDate(date: CalendarDate): string {
  return `papers3-home-${dateKey(date)}-r${revisionForDate(date)}.ink`;
}

async function atomicWrite(filePath: string, value: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value);
  await rename(temporary, filePath);
}

function homeArchiveContentsAreValid(
  contents: Awaited<ReturnType<typeof readInkArchive>>,
  date: CalendarDate,
): boolean {
  const clock = contents.documents.get(CLOCK_DOCUMENT_UUID);
  const clockSidecars = [...contents.sidecars.values()].filter((sidecar) =>
    sidecar.documentUuid === CLOCK_DOCUMENT_UUID
  );
  const validClock = clock?.content.page.kind === "detail"
    && clock.content.page.title === "校时中"
    && clock.localWidgets?.length === 1
    && clock.localWidgets[0].kind === "clock"
    && clock.localWidgets[0].contentPath === "page.title"
    && clockSidecars.length === contents.manifest.variants.length
    && clockSidecars.every((sidecar) =>
      sidecar.dynamicRegions?.length === 1
      && sidecar.dynamicRegions[0].id === "clock-main"
      && sidecar.dynamicRegions[0].kind === "clock"
    );
  return contents.manifest.packageId === PAPERS3_HOME_PACKAGE_ID
    && contents.manifest.entryUuid === PAPERS3_HOME_ENTRY_UUID
    && contents.manifest.revision === revisionForDate(date)
    && contents.manifest.createdAt === createdAtForDate(date)
    && contents.manifest.generator.name === "inkos-papers3-home"
    && contents.manifest.generator.version === PAPERS3_HOME_GENERATOR_VERSION
    && contents.manifest.variants.length === 2
    && contents.manifest.variants.every((variant) =>
      variant.profileId === PAPER_S3_PROFILE_ID
      && variant.displayMeta.fontLevel === 0
      && variant.displayMeta.invert === false
    )
    && new Set(contents.manifest.variants.map((variant) => variant.displayMeta.orientation)).size === 2
    && contents.manifest.variants.some((variant) => variant.displayMeta.orientation === "portrait")
    && contents.manifest.variants.some((variant) => variant.displayMeta.orientation === "landscape")
    && validClock;
}

interface CanonicalHomeArchive {
  archive: Uint8Array;
  sha256: string;
  releaseDate: CalendarDate;
}

async function configuredCanonicalHomeArchive(
  options: EnsurePaperS3HomeOptions,
): Promise<CanonicalHomeArchive | undefined> {
  const configuredPath = options.canonicalArchivePath
    ?? process.env.INKOS_PAPERS3_HOME_ARCHIVE;
  if (!configuredPath) return undefined;

  const archivePath = path.resolve(configuredPath);
  const metadata = await stat(archivePath);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_ARCHIVE_BYTES) {
    throw new Error("Configured PaperS3 home archive is not a valid regular file");
  }
  const archive = new Uint8Array(await readFile(archivePath));
  const contents = await readInkArchive(archive, { maxArchiveBytes: MAX_ARCHIVE_BYTES });
  const revision = contents.manifest.revision;
  const releaseDate = assertCalendarDate({
    year: Math.floor(revision / 10_000),
    month: Math.floor(revision / 100) % 100,
    day: revision % 100,
  });
  if (!homeArchiveContentsAreValid(contents, releaseDate)) {
    throw new Error("Configured PaperS3 home archive has an inconsistent release identity");
  }
  return { archive, sha256: await sha256Hex(archive), releaseDate };
}

async function existingPublicationIsValid(
  jobDirectory: string,
  date: CalendarDate,
  expectedArchiveSha256?: string,
): Promise<boolean> {
  try {
    const rawJob = generatorJobSchema.parse(JSON.parse(await readFile(path.join(jobDirectory, "job.json"), "utf8")));
    if (
      rawJob.status !== "complete"
      || rawJob.package?.packageId !== PAPERS3_HOME_PACKAGE_ID
      || rawJob.package.fileName !== fileNameForDate(date)
      || (expectedArchiveSha256 !== undefined && rawJob.package.sha256 !== expectedArchiveSha256)
    ) return false;
    const artifactPath = path.join(jobDirectory, "artifact.ink");
    const metadata = await stat(artifactPath);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_ARCHIVE_BYTES) return false;
    const archive = new Uint8Array(await readFile(artifactPath));
    if (archive.byteLength !== rawJob.package.bytes) return false;
    const archiveSha256 = await sha256Hex(archive);
    if (
      archiveSha256 !== rawJob.package.sha256
      || (expectedArchiveSha256 !== undefined && archiveSha256 !== expectedArchiveSha256)
    ) return false;
    const contents = await readInkArchive(archive, { maxArchiveBytes: MAX_ARCHIVE_BYTES });
    return homeArchiveContentsAreValid(contents, date);
  } catch {
    return false;
  }
}

const builtPackages = new Map<string, Promise<BuiltInkPackage>>();
const publicationLocks = new Map<string, Promise<void>>();
const verifiedPublications = new Map<string, string>();
const MAX_BUILT_PACKAGE_CACHE_ENTRIES = 2;
const MAX_VERIFIED_PUBLICATION_ENTRIES = 64;

function rememberVerifiedPublication(key: string, targetDateKey: string): void {
  verifiedPublications.delete(key);
  verifiedPublications.set(key, targetDateKey);
  while (verifiedPublications.size > MAX_VERIFIED_PUBLICATION_ENTRIES) {
    const oldest = verifiedPublications.keys().next().value;
    if (oldest === undefined) break;
    verifiedPublications.delete(oldest);
  }
}

function builtPackage(date: CalendarDate): Promise<BuiltInkPackage> {
  const key = dateKey(date);
  let pending = builtPackages.get(key);
  if (!pending) {
    pending = buildPaperS3HomePackage(date).catch((error) => {
      builtPackages.delete(key);
      throw error;
    });
    builtPackages.set(key, pending);
    while (builtPackages.size > MAX_BUILT_PACKAGE_CACHE_ENTRIES) {
      const oldest = builtPackages.keys().next().value;
      if (oldest === undefined || oldest === key) break;
      builtPackages.delete(oldest);
    }
  }
  return pending;
}

export async function ensurePaperS3HomePackage(
  options: EnsurePaperS3HomeOptions = {},
): Promise<PaperS3HomePublication> {
  const requestedDate = assertCalendarDate(options.date ?? currentShanghaiCalendarDate());
  const canonical = await configuredCanonicalHomeArchive(options);
  // A configured archive is a firmware-release artifact, not a daily mutable
  // calendar cache. Keep its self-consistent release identity across midnight
  // until the operator deploys a newer paired firmware archive.
  const date = canonical?.releaseDate ?? requestedDate;
  const root = dataRoot(options);
  const jobId = jobIdForMonth(date);
  const jobDirectory = path.join(root, "jobs", jobId);
  const publicationKey = `${root}\0${monthKey(date)}`;
  const targetDateKey = canonical
    ? `${dateKey(date)}\0${canonical.sha256}`
    : dateKey(date);
  const publication = {
    packageId: PAPERS3_HOME_PACKAGE_ID,
    entryUuid: PAPERS3_HOME_ENTRY_UUID,
    revision: revisionForDate(date),
    jobId,
    fileName: fileNameForDate(date),
  } satisfies PaperS3HomePublication;

  if (verifiedPublications.get(publicationKey) === targetDateKey) return publication;

  const previous = publicationLocks.get(publicationKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  publicationLocks.set(publicationKey, tail);
  await previous;
  try {
    if (verifiedPublications.get(publicationKey) === targetDateKey) return publication;
    if (await existingPublicationIsValid(jobDirectory, date, canonical?.sha256)) {
      rememberVerifiedPublication(publicationKey, targetDateKey);
      return publication;
    }

    const built = canonical ? undefined : await builtPackage(date);
    const archive = canonical?.archive ?? built!.archive;
    const archiveSha256 = canonical?.sha256 ?? built!.sha256;
    if (archive.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error(`PaperS3 home package exceeds ${MAX_ARCHIVE_BYTES} bytes`);
    }
    await mkdir(jobDirectory, { recursive: true });
    await atomicWrite(path.join(jobDirectory, "artifact.ink"), archive);
    const urls = generatorJobUrls(jobId);
    const timestamp = createdAtForDate(date);
    const job = generatorJobSchema.parse({
      schemaVersion: "inkos.generator-job/v1",
      jobId,
      status: "complete",
      phase: "complete",
      progress: { completed: 1, total: 1, message: "PaperS3 应用首页已校验并发布" },
      createdAt: timestamp,
      updatedAt: timestamp,
      statusUrl: urls.statusUrl,
      eventsUrl: urls.eventsUrl,
      artifactUrl: urls.artifactUrl,
      package: {
        packageId: PAPERS3_HOME_PACKAGE_ID,
        fileName: publication.fileName,
        bytes: archive.byteLength,
        sha256: archiveSha256,
      },
    });
    await atomicWrite(path.join(jobDirectory, "job.json"), `${JSON.stringify(job, null, 2)}\n`);
    if (!await existingPublicationIsValid(jobDirectory, date, canonical?.sha256)) {
      throw new Error("Published PaperS3 home package failed archive verification");
    }
    rememberVerifiedPublication(publicationKey, targetDateKey);
    return publication;
  } finally {
    release();
    if (publicationLocks.get(publicationKey) === tail) publicationLocks.delete(publicationKey);
  }
}
