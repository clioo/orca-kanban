// The import dialog's board picker: a name filter over the listed boards
// and a "Recommended for you" group — the boards holding your open
// assigned issues, most first. Pure, so the dialog only renders.
import type { WorkProviderBoard } from "../../../../shared/work-contract";

/** A listed board with a newer daemon's counts of your open assigned
 *  issues (absent from an older one, which recommends nothing):
 *  `assignedOpen` on the board itself (its open sprints; a Linear team),
 *  `assignedInProject` in its project — shared by every board of it. */
export type PickerBoard = WorkProviderBoard & {
  assignedOpen?: number;
  assignedInProject?: number;
};

/** Recommendations shown before "Show all". */
export const RECOMMENDED_LIMIT = 5;

/** The recommendations to render: the first `RECOMMENDED_LIMIT` until
 *  expanded; a filter always shows every match. `hidden` is how many wait
 *  behind "Show all". */
export function visibleRecommendations<B>(
  recommended: B[],
  { expanded, filtering }: { expanded: boolean; filtering: boolean },
): { shown: B[]; hidden: number } {
  if (expanded || filtering || recommended.length <= RECOMMENDED_LIMIT)
    return { shown: recommended, hidden: 0 };
  return {
    shown: recommended.slice(0, RECOMMENDED_LIMIT),
    hidden: recommended.length - RECOMMENDED_LIMIT,
  };
}

/** Case- and accent-insensitive form for matching. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Boards whose name, project key or project name hold every word of the
 *  query, in listed order; a blank query keeps them all. */
export function filterBoards<B extends PickerBoard>(
  boards: B[],
  query: string,
): B[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return boards;
  return boards.filter((board) => {
    const haystack = fold(
      [board.name, board.projectKey ?? "", board.projectName ?? ""].join(" "),
    );
    return words.every((word) => haystack.includes(word));
  });
}

const own = (board: PickerBoard) => board.assignedOpen ?? 0;
const inProject = (board: PickerBoard) => board.assignedInProject ?? 0;

/** Recommended, then the rest in listed order. Boards holding your issues
 *  themselves come first, most first. A board known only through its
 *  project is recommended when no board of that project holds them itself
 *  (then it is one of that team's views, not where your work lives). Ties
 *  keep listed order. */
export function groupBoards<B extends PickerBoard>(
  boards: B[],
): { recommended: B[]; rest: B[] } {
  const byCount = (count: (board: B) => number) => (list: B[]) =>
    list
      .map((board, index) => ({ board, index }))
      .sort((a, b) => count(b.board) - count(a.board) || a.index - b.index)
      .map(({ board }) => board);
  const direct = byCount(own)(boards.filter((board) => own(board) > 0));
  const projectsWithDirect = new Set(
    direct.map((board) => board.projectKey).filter(Boolean),
  );
  const viaProject = byCount(inProject)(
    boards.filter(
      (board) =>
        own(board) === 0 &&
        inProject(board) > 0 &&
        board.projectKey &&
        !projectsWithDirect.has(board.projectKey),
    ),
  );
  const recommended = [...direct, ...viaProject];
  const chosen = new Set<B>(recommended);
  return { recommended, rest: boards.filter((board) => !chosen.has(board)) };
}

/** What a recommended board says about your issues: its own ("4 assigned
 *  to you") or its project's ("63 in FT assigned to you"). */
export function assignedLabel(board: PickerBoard): string | null {
  if (own(board) > 0) return `${own(board)} assigned to you`;
  if (inProject(board) > 0 && board.projectKey)
    return `${inProject(board)} in ${board.projectKey} assigned to you`;
  return null;
}
