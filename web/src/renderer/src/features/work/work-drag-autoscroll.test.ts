// Edge auto-scroll speed.
import { describe, expect, test } from "vitest";
import { EDGE_ZONE, MAX_SPEED, edgeScrollSpeed } from "./work-drag-autoscroll";

describe("edgeScrollSpeed", () => {
  test("is 0 outside the zones, toward the start near it and toward the end near that", () => {
    expect(edgeScrollSpeed(500, 0, 1000)).toBe(0);
    expect(edgeScrollSpeed(EDGE_ZONE, 0, 1000)).toBe(0);
    expect(edgeScrollSpeed(10, 0, 1000)).toBeLessThan(0);
    expect(edgeScrollSpeed(990, 0, 1000)).toBeGreaterThan(0);
  });

  test("ramps up toward the edge and tops out at the edge (or past it)", () => {
    const inner = edgeScrollSpeed(1000 - EDGE_ZONE + 5, 0, 1000);
    const outer = edgeScrollSpeed(995, 0, 1000);
    expect(inner).toBeGreaterThanOrEqual(1);
    expect(outer).toBeGreaterThan(inner);
    expect(edgeScrollSpeed(1000, 0, 1000)).toBe(MAX_SPEED);
    expect(edgeScrollSpeed(1200, 0, 1000)).toBe(MAX_SPEED);
    expect(edgeScrollSpeed(-50, 0, 1000)).toBe(-MAX_SPEED);
  });

  test("works on an offset axis and shares a small container between both zones", () => {
    expect(edgeScrollSpeed(305, 300, 1300)).toBeLessThan(0);
    expect(edgeScrollSpeed(800, 300, 1300)).toBe(0);
    // A 100px container: each zone is half of it, and its middle scrolls nowhere.
    expect(edgeScrollSpeed(50, 0, 100)).toBe(0);
    expect(edgeScrollSpeed(10, 0, 100)).toBeLessThan(0);
    expect(edgeScrollSpeed(10, 0, 0)).toBe(0);
  });
});
