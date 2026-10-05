// Starting points for a column's prompt. Each is plain text with the same
// placeholders the board renders ({ticket.key}, {column.next}, …), so the
// owner edits it like any other prompt; {board.cli} is the board's own
// command line, which agents in Orca terminals run. `icons` suggest where
// it fits.

export type WorkPromptTemplate = { id: string; name: string; icons: string[]; text: string };

export const WORK_PROMPT_TEMPLATES: WorkPromptTemplate[] = [
  {
    id: "start",
    name: "Start the work",
    icons: ["todo", "in_progress"],
    text: [
      "You are working on {ticket.key}: {ticket.title}",
      "{ticket.url}",
      "",
      "{ticket.description}",
      "",
      "Plan the change, make it in this workspace and open a pull request.",
      "When it is ready for review, run: {board.cli} ticket move --ticket {ticket.key} --column \"{column.next}\"",
    ].join("\n"),
  },
  {
    id: "review",
    name: "Address review",
    icons: ["review"],
    text: [
      "{ticket.key} is in review: {ticket.pr}",
      "Read the new review comments and required checks, fix what is asked and push.",
      "When the pull request is approved and merged, run: {board.cli} ticket move --ticket {ticket.key} --column \"{column.next}\"",
    ].join("\n"),
  },
  {
    id: "rework",
    name: "Rework after feedback",
    icons: ["review", "blocked", "in_progress"],
    text: [
      "{ticket.key} came back ({ticket.status}). Read the latest comments on {ticket.url} and on {ticket.pr},",
      "address every point, push, and reply on the pull request with what changed.",
    ].join("\n"),
  },
  {
    id: "qa",
    name: "Verify (QA)",
    icons: ["qa"],
    text: [
      "Verify {ticket.key} ({ticket.title}) end to end: run the tests and the manual checks the ticket describes.",
      "Report what you checked and what you found. If it passes, run: {board.cli} ticket move --ticket {ticket.key} --column \"{column.next}\"",
    ].join("\n"),
  },
  {
    id: "status",
    name: "Status check",
    icons: [],
    text: "Where are you with {ticket.key}? Reply in two lines: progress so far, and the next step or blocker.",
  },
];

/** The templates for a column: those suggested for its icon first. */
export function templatesFor(icon: string): WorkPromptTemplate[] {
  const suggested = WORK_PROMPT_TEMPLATES.filter((t) => t.icons.includes(icon));
  return [...suggested, ...WORK_PROMPT_TEMPLATES.filter((t) => !suggested.includes(t))];
}
