// Column icon names and the icon a column's name suggests.
import { describe, expect, test } from "vitest";
import { WORK_COLUMN_ICONS } from "../../../../shared/work-contract";
import { iconForColumnName, workColumnIconLabel } from "./work-icons";

describe("iconForColumnName", () => {
  test("follows the daemon's rules for imported columns", () => {
    expect(iconForColumnName("Backlog")).toBe("backlog");
    expect(iconForColumnName("Blocked by vendor")).toBe("blocked");
    expect(iconForColumnName("Code Review")).toBe("review");
    expect(iconForColumnName("QA")).toBe("qa");
    expect(iconForColumnName("Testing")).toBe("qa");
    expect(iconForColumnName("Verification")).toBe("qa");
    expect(iconForColumnName("Done")).toBe("done");
    expect(iconForColumnName("Closed")).toBe("done");
    expect(iconForColumnName("In Progress")).toBe("in_progress");
    expect(iconForColumnName("Doing")).toBe("in_progress");
    expect(iconForColumnName("Ready to Deploy")).toBe("todo");
    expect(iconForColumnName("")).toBe("todo");
  });

  test("only ever suggests an icon the board has", () => {
    for (const name of [
      "Backlog",
      "Blocked",
      "Review",
      "QA",
      "Done",
      "Doing",
      "Anything",
    ]) {
      expect(WORK_COLUMN_ICONS).toContain(iconForColumnName(name));
    }
  });
});

test("workColumnIconLabel reads as words", () => {
  expect(workColumnIconLabel("in_progress")).toBe("In progress");
  expect(workColumnIconLabel("qa")).toBe("Qa");
  expect(workColumnIconLabel("todo")).toBe("Todo");
});
