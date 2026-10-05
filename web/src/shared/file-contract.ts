import type { Result } from "./session-contract";

export const FILES_CAPABILITY = "files.v1";
export const MAX_FILE_BYTES = 65_536;
export const MAX_DIRECTORY_ENTRIES = 1_000;

export type FileScope = {
  hostId: string;
  workspaceId: string;
  path: string;
};
export type WorkspaceFileEntry = {
  name: string;
  kind: "file" | "directory" | "symlink";
  size: number;
  mtime: string;
};
export type FileListResult = FileScope & {
  entries: WorkspaceFileEntry[];
  truncated: boolean;
};
export type FileReadResult = FileScope & {
  content: string;
  size: number;
  mtime: string;
};
export type FileWriteResult = FileScope & { size: number; mtime: string };
/** Target kind for `files.create`, mirroring the explorer's New File / New Folder actions. */
export type FileCreateKind = "file" | "directory";
export type FileCreateResult = FileScope & { kind: FileCreateKind };
export type FileRenameResult = {
  hostId: string;
  workspaceId: string;
  from: string;
  to: string;
};
/** Byte-preserving server-side copy for `files.duplicate` (issue #334). */
export type FileDuplicateResult = {
  hostId: string;
  workspaceId: string;
  from: string;
  to: string;
};
export type FileDeleteResult = {
  hostId: string;
  workspaceId: string;
  deleted: string[];
};
/** Upper bound on one `files.delete` call; larger batches must be split by the caller. */
export const MAX_DELETE_PATHS = 128;
/**
 * Coarse workspace-changed tick (R16-L #157): main's filesystem watcher
 * reports WHICH workspace changed, never what — the renderer re-reads its
 * loaded directories (bounded by MAX_DIRECTORY_ENTRIES) to reconcile, the
 * fork's `fs:changed` ordering without its per-path payload.
 */
export type FilesChangedTick = {
  workspaceId: string;
};
/**
 * Live change subscription for one mounted explorer. OPTIONAL until the
 * preload exposes the channel: an absent method means change events never
 * arrive and the tree refreshes on its own mutations only, never a crash.
 */
export interface FilesWatchBridge {
  onFilesChanged(
    listener: (tick: FilesChangedTick) => void,
  ): () => void;
}
/**
 * Upper bound on one `files.search` call, mirroring the protocol's
 * `MAX_FILE_SEARCH_RESULTS`. Quick open ranks client-side, so the daemon
 * only ever returns a bounded candidate list.
 */
export const MAX_FILE_SEARCH_RESULTS = 500;
/** Default candidate count when the caller omits `limit`. */
export const DEFAULT_FILE_SEARCH_LIMIT = 100;
/** Byte cap on a `files.search` query (reference quick-open parity). */
export const MAX_FILE_SEARCH_QUERY_BYTES = 2048;
export type FileSearchScope = {
  hostId: string;
  workspaceId: string;
  query: string;
  limit?: number;
};
export type FileSearchResult = {
  hostId: string;
  workspaceId: string;
  query: string;
  files: string[];
  truncated: boolean;
};
export interface FileBridge {
  fileList(
    input: FileScope & { limitEntries?: number; includeHidden?: boolean },
  ): Promise<Result<FileListResult>>;
  fileRead(
    input: FileScope & { maxBytes?: number },
  ): Promise<Result<FileReadResult>>;
  fileWrite(
    input: FileScope & { content: string; requestId: string },
  ): Promise<Result<FileWriteResult>>;
  /**
   * Explorer mutations. OPTIONAL until the daemon wires `files.create` /
   * `files.rename` / `files.delete` dispatch and the preload exposes the
   * channels: the explorer treats an absent method as unavailable (disabled
   * UI with an explanatory title), never as a crash. Present in fakes and
   * tests so the wire mapping is covered before the daemon lands.
   */
  fileCreate?(
    input: FileScope & { kind: FileCreateKind },
  ): Promise<Result<FileCreateResult>>;
  fileRename?(
    input: { hostId: string; workspaceId: string; from: string; to: string },
  ): Promise<Result<FileRenameResult>>;
  /**
   * Server-side duplicate for the explorer's Duplicate row (additive,
   * issue #334). OPTIONAL like the other explorer mutations: an absent
   * method disables the row with an explanatory title, never a crash.
   */
  fileDuplicate?(
    input: { hostId: string; workspaceId: string; from: string; to: string },
  ): Promise<Result<FileDuplicateResult>>;
  fileDelete?(
    input: { hostId: string; workspaceId: string; paths: string[] },
  ): Promise<Result<FileDeleteResult>>;
  /**
   * Bounded workspace-relative path search for quick open (additive R12-B).
   * OPTIONAL until the daemon wires `files.search` dispatch and the preload
   * exposes the channel: quick open treats an absent method as unavailable
   * (falls back to the `files.list` walk), never as a crash.
   */
  fileSearch?(input: FileSearchScope): Promise<Result<FileSearchResult>>;
  /**
   * Git-ignored query for the explorer's visible rows (additive R16-AM):
   * reports which of the given workspace-relative paths git ignores so the
   * tree can dim them like the reference. OPTIONAL until the daemon wires
   * `files.ignored` dispatch and the preload exposes the channel: an
   * absent method means no row is ever decorated, never a crash.
   */
  fileIgnored?(input: FileIgnoredScope): Promise<Result<FileIgnoredResult>>;
}
/**
 * Upper bound on one `files.ignored` call. Mirrors the daemon's
 * `MAX_IGNORED_PATHS` in `crates/drogon-core/src/workspace_files.rs`
 * exactly; the renderer batches visible rows to stay under it.
 */
export const MAX_IGNORED_PATHS = 200;
export type FileIgnoredScope = {
  hostId: string;
  workspaceId: string;
  paths: string[];
};
export type FileIgnoredResult = {
  hostId: string;
  workspaceId: string;
  ignored: string[];
};
