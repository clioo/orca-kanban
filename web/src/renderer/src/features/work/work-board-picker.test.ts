// The board picker's filter and "Recommended for you" grouping.
import { describe, expect, test } from "vitest";
import {
  RECOMMENDED_LIMIT,
  assignedLabel,
  filterBoards,
  groupBoards,
  visibleRecommendations,
  type PickerBoard,
} from "./work-board-picker";

function board(
  id: string,
  name: string,
  extra: Partial<PickerBoard> = {},
): PickerBoard {
  return {
    id,
    name,
    kind: "kanban",
    projectKey: null,
    projectName: null,
    importedBoardId: null,
    ...extra,
  };
}

const BOARDS = [
  board("1", "ZOPR Decommision Requests", {
    projectKey: "ZOPR",
    projectName: "Zillow Operations Production Release",
  }),
  board("2", "Renter Transactions Web and Services"),
  board("3", "Pathfinders OnCall", {
    projectKey: "ZHLCX",
    projectName: "Zillow Home Loans - Pathfinders",
  }),
  board("4", "Diseño de Producto", { projectKey: "DP" }),
];

describe("filterBoards", () => {
  test("a blank query keeps every board", () => {
    expect(filterBoards(BOARDS, "   ")).toBe(BOARDS);
  });

  test("matches the name, the project key and the project name, ignoring case", () => {
    expect(filterBoards(BOARDS, "renter").map((b) => b.id)).toEqual(["2"]);
    expect(filterBoards(BOARDS, "zhlcx").map((b) => b.id)).toEqual(["3"]);
    expect(filterBoards(BOARDS, "home loans").map((b) => b.id)).toEqual(["3"]);
    expect(filterBoards(BOARDS, "zillow").map((b) => b.id)).toEqual(["1", "3"]);
  });

  test("every word must match, in any order, and accents do not matter", () => {
    expect(filterBoards(BOARDS, "release zopr").map((b) => b.id)).toEqual([
      "1",
    ]);
    expect(filterBoards(BOARDS, "zopr renter")).toEqual([]);
    expect(filterBoards(BOARDS, "diseno").map((b) => b.id)).toEqual(["4"]);
  });
});

describe("groupBoards", () => {
  test("boards holding your issues themselves come first, most first, ties in listed order", () => {
    const boards = [
      board("a", "A"),
      board("b", "B", { assignedOpen: 1 }),
      board("c", "C", { assignedOpen: 4 }),
      board("d", "D", { assignedOpen: 1 }),
      board("e", "E", { assignedOpen: 0 }),
    ];
    const { recommended, rest } = groupBoards(boards);
    expect(recommended.map((b) => b.id)).toEqual(["c", "b", "d"]);
    expect(rest.map((b) => b.id)).toEqual(["a", "e"]);
  });

  test("a project's other boards are its views: they stay out once one of them holds your issues", () => {
    // The FT case: 63 of your issues in FT, 5 of them in board 1's sprints.
    const ft = (id: string, own = 0) =>
      board(id, `FT ${id}`, {
        projectKey: "FT",
        assignedOpen: own,
        assignedInProject: 63,
      });
    const boards = [ft("views-1"), ft("1", 5), ft("views-2"), ft("views-3")];
    const { recommended, rest } = groupBoards(boards);
    expect(recommended.map((b) => b.id)).toEqual(["1"]);
    expect(rest.map((b) => b.id)).toEqual(["views-1", "views-2", "views-3"]);
  });

  test("a project with no board of its own is recommended through the project, after the direct ones", () => {
    const boards = [
      board("ops-1", "Ops One", { projectKey: "OPS", assignedInProject: 3 }),
      board("mob", "Mobile", {
        projectKey: "MOB",
        assignedOpen: 1,
        assignedInProject: 1,
      }),
      board("dat", "Data", { projectKey: "DS", assignedInProject: 9 }),
      board("ops-2", "Ops Two", { projectKey: "OPS", assignedInProject: 3 }),
      board("nokey", "No key", { assignedInProject: 4 }),
    ];
    const { recommended, rest } = groupBoards(boards);
    expect(recommended.map((b) => b.id)).toEqual([
      "mob",
      "dat",
      "ops-1",
      "ops-2",
    ]);
    expect(rest.map((b) => b.id)).toEqual(["nokey"]);
  });

  test("a daemon without counts recommends nothing", () => {
    const { recommended, rest } = groupBoards(BOARDS);
    expect(recommended).toEqual([]);
    expect(rest).toEqual(BOARDS);
  });
});

describe("assignedLabel", () => {
  test("says whether the issues are the board's own or its project's", () => {
    expect(
      assignedLabel(
        board("1", "B", {
          projectKey: "FT",
          assignedOpen: 1,
          assignedInProject: 63,
        }),
      ),
    ).toBe("1 assigned to you");
    expect(
      assignedLabel(
        board("2", "B", {
          projectKey: "FT",
          assignedOpen: 0,
          assignedInProject: 63,
        }),
      ),
    ).toBe("63 in FT assigned to you");
    expect(assignedLabel(board("3", "B", { assignedInProject: 2 }))).toBeNull();
    expect(assignedLabel(board("4", "B"))).toBeNull();
  });
});

describe("visibleRecommendations", () => {
  const seven = [1, 2, 3, 4, 5, 6, 7];

  test("shows the first five until expanded, and says how many wait", () => {
    expect(RECOMMENDED_LIMIT).toBe(5);
    expect(
      visibleRecommendations(seven, { expanded: false, filtering: false }),
    ).toEqual({ shown: [1, 2, 3, 4, 5], hidden: 2 });
    expect(
      visibleRecommendations(seven, { expanded: true, filtering: false }),
    ).toEqual({ shown: seven, hidden: 0 });
  });

  test("a filter shows every match; five or fewer never hide", () => {
    expect(
      visibleRecommendations(seven, { expanded: false, filtering: true }),
    ).toEqual({ shown: seven, hidden: 0 });
    expect(
      visibleRecommendations([1, 2, 3, 4, 5], {
        expanded: false,
        filtering: false,
      }),
    ).toEqual({ shown: [1, 2, 3, 4, 5], hidden: 0 });
  });
});
