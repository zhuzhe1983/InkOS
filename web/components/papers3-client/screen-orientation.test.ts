import { describe, expect, it, vi } from "vitest";

import { currentScreenOrientation, observeScreenOrientation } from "./screen-orientation";

describe("PaperS3 screen orientation", () => {
  it("prefers the sensor-backed Screen Orientation API", () => {
    expect(currentScreenOrientation({
      innerWidth: 390,
      innerHeight: 844,
      screen: { orientation: { type: "landscape-primary" } },
    })).toBe("landscape");
  });

  it("falls back to the active visual viewport", () => {
    expect(currentScreenOrientation({
      innerWidth: 390,
      innerHeight: 844,
      visualViewport: { width: 844, height: 390 } as never,
    })).toBe("landscape");
  });

  it("publishes the initial orientation and deduplicates repeated events", () => {
    const handlers = new Map<string, () => void>();
    const orientationHandlers = new Map<string, () => void>();
    const listener = vi.fn();
    let width = 390;
    let height = 844;
    const source = {
      get innerWidth() { return width; },
      get innerHeight() { return height; },
      screen: {
        orientation: {
          get type() { return width > height ? "landscape-primary" : "portrait-primary"; },
          addEventListener: (type: string, handler: () => void) => orientationHandlers.set(type, handler),
          removeEventListener: (type: string) => orientationHandlers.delete(type),
        },
      },
      addEventListener: (type: string, handler: () => void) => handlers.set(type, handler),
      removeEventListener: (type: string) => handlers.delete(type),
      requestAnimationFrame: (handler: () => void) => { handler(); return 1; },
      cancelAnimationFrame: vi.fn(),
    };

    const stop = observeScreenOrientation(source, listener);
    expect(listener).toHaveBeenLastCalledWith("portrait");
    handlers.get("resize")?.();
    expect(listener).toHaveBeenCalledTimes(1);
    width = 844;
    height = 390;
    orientationHandlers.get("change")?.();
    expect(listener).toHaveBeenLastCalledWith("landscape");
    stop();
    expect(handlers.size).toBe(0);
    expect(orientationHandlers.size).toBe(0);
  });

  it("can establish an initial baseline without publishing it", () => {
    const handlers = new Map<string, () => void>();
    const orientationHandlers = new Map<string, () => void>();
    const listener = vi.fn();
    let width = 390;
    let height = 844;
    const source = {
      get innerWidth() { return width; },
      get innerHeight() { return height; },
      screen: {
        orientation: {
          get type() { return width > height ? "landscape-primary" : "portrait-primary"; },
          addEventListener: (type: string, handler: () => void) => orientationHandlers.set(type, handler),
          removeEventListener: (type: string) => orientationHandlers.delete(type),
        },
      },
      addEventListener: (type: string, handler: () => void) => handlers.set(type, handler),
      removeEventListener: (type: string) => handlers.delete(type),
      requestAnimationFrame: (handler: () => void) => { handler(); return 1; },
      cancelAnimationFrame: vi.fn(),
    };

    const stop = observeScreenOrientation(source, listener, { publishInitial: false });
    expect(listener).not.toHaveBeenCalled();
    handlers.get("resize")?.();
    expect(listener).not.toHaveBeenCalled();

    width = 844;
    height = 390;
    orientationHandlers.get("change")?.();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith("landscape");

    handlers.get("resize")?.();
    expect(listener).toHaveBeenCalledOnce();
    stop();
  });
});
