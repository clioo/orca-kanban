// Where a ticket's agents work: an Orca repo or an Orca folder project
// (such as `pre-sales`, whose folder workspaces hold one context per
// ticket). Pickers list both, folder projects in their own group, since a
// folder project and a repo can share a name.
import type { ReactNode } from "react";

export type WorkProject = { id: string; name: string; kind?: string };

export const isFolderProject = (project: WorkProject) => project.kind === "folder-group";

/** The `<option>`s of a native project picker. */
export function ProjectOptions({ projects }: { projects: WorkProject[] }): ReactNode {
  const folders = projects.filter(isFolderProject);
  const repos = projects.filter((p) => !isFolderProject(p));
  const options = (list: WorkProject[]) =>
    list.map((p) => (
      <option key={p.id} value={p.id}>
        {p.name}
      </option>
    ));
  if (folders.length === 0) return options(repos);
  return (
    <>
      {repos.length ? <optgroup label="Repositories">{options(repos)}</optgroup> : null}
      <optgroup label="Folder projects">{options(folders)}</optgroup>
    </>
  );
}
