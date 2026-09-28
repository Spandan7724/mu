import { findModel } from "mu";
import type { Tab } from "../browser/tabs.ts";

export const MAX_SCREENSHOT_WIDTH = 1280;
const MAX_FULL_PAGE_HEIGHT = 10_000;

export interface Screenshot {
  data: string;
  mimeType: "image/jpeg";
  // CSS pixels covered by the image, and image pixels per CSS pixel.
  cssWidth: number;
  cssHeight: number;
  scale: number;
  // Viewport-relative CSS origin of the image (non-zero for element shots).
  originX: number;
  originY: number;
}

export type VisionMode = "auto" | "on" | "off";

export function visionEnabled(mode: VisionMode, modelRef: string | undefined): boolean {
  if (mode !== "auto") return mode === "on";
  if (!modelRef) return false;
  return findModel(modelRef)?.modalities.includes("image") ?? false;
}

export function screenshotHeader(shot: Screenshot): string {
  const size = `${shot.cssWidth}x${shot.cssHeight} css px`;
  const scale =
    shot.scale === 1 ? "" : `, image scaled ${shot.scale.toFixed(2)}× (divide image pixels by it)`;
  const origin =
    shot.originX || shot.originY ? `, top-left at viewport (${shot.originX}, ${shot.originY})` : "";
  return `screenshot: ${size}${scale}${origin}`;
}

export async function captureScreenshot(
  tab: Tab,
  options: {
    signal?: AbortSignal | undefined;
    box?: { x: number; y: number; w: number; h: number } | undefined;
    fullPage?: boolean | undefined;
    quality?: number | undefined;
  } = {},
): Promise<Screenshot> {
  const send = { signal: options.signal, timeoutMs: 10_000 };
  const [metrics, ratio] = await Promise.all([
    tab.session.send("Page.getLayoutMetrics", undefined, send),
    tab.session.send(
      "Runtime.evaluate",
      { expression: "window.devicePixelRatio", returnByValue: true },
      send,
    ),
  ]);
  const viewport = metrics.cssVisualViewport;
  const dpr = Number(ratio.result.value) || 1;
  let region: { x: number; y: number; width: number; height: number };
  if (options.box) {
    const x = Math.max(0, Math.floor(options.box.x));
    const y = Math.max(0, Math.floor(options.box.y));
    region = {
      x: viewport.pageX + x,
      y: viewport.pageY + y,
      width: Math.max(1, Math.ceil(Math.min(options.box.w, viewport.clientWidth - x))),
      height: Math.max(1, Math.ceil(Math.min(options.box.h, viewport.clientHeight - y))),
    };
  } else if (options.fullPage) {
    region = {
      x: 0,
      y: 0,
      width: Math.ceil(metrics.cssContentSize.width),
      height: Math.ceil(Math.min(metrics.cssContentSize.height, MAX_FULL_PAGE_HEIGHT)),
    };
  } else {
    region = {
      x: viewport.pageX,
      y: viewport.pageY,
      width: Math.round(viewport.clientWidth),
      height: Math.round(viewport.clientHeight),
    };
  }
  const scale = Math.min(1, MAX_SCREENSHOT_WIDTH / region.width);
  const shot = await tab.session.send(
    "Page.captureScreenshot",
    {
      format: "jpeg",
      quality: options.quality ?? 70,
      clip: { ...region, scale: scale / dpr },
      captureBeyondViewport: options.fullPage === true,
      optimizeForSpeed: true,
    },
    send,
  );
  return {
    data: shot.data,
    mimeType: "image/jpeg",
    cssWidth: region.width,
    cssHeight: region.height,
    scale: Math.round(scale * 100) / 100,
    originX: options.box ? Math.round(region.x - viewport.pageX) : 0,
    originY: options.box ? Math.round(region.y - viewport.pageY) : 0,
  };
}
