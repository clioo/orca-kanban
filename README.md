# Orca Kanban — macOS Apple Silicon distribution

This tag contains the ready-to-install plugin, not its source checkout.

In Orca, open **Settings → Plugins → Install plugin → Git URL** and paste:

```
https://github.com/clioo/orca-kanban.git#macos-arm64-v0.2.3
```

Review the permissions and enable the plugin. Press **Command + J** and run
**Open Work board**. No Node.js, Rust toolchain, or compilation is required.

**Compatibility:** macOS on Apple Silicon (M-series); tested with Orca 1.4.209.
This binary is not compatible with Intel Macs, Windows, or Linux. Orca's
plugin API is experimental. The executable is ad-hoc signed, not notarized.
The service uses your installed Orca CLI and configured agent commands.
Provider integrations may require additional tools, such as GitHub's `gh` CLI.

Board data is local to this laptop. Installation does not transfer tickets,
credentials, or sessions from another machine.

Source and development documentation: https://github.com/clioo/orca-kanban

`distribution.json` records the source revision and SHA-256 file checksums.
See `LICENSE` and `THIRD_PARTY_NOTICES.md` for copyright and attribution.

## Folder projects (0.2.2)

**Agents work in** lists your Orca repositories and folder projects (such as
`pre-sales`) in one picker. In a folder project each ticket works in its own
folder workspace: one already named for its key, else a new one named
`<key> <title>`. The per-worktree selector of 0.2.1 is gone.

Upgrading from 0.2.0 backs up the board database as
`work-board-before-v7-<id>.db` in the plugin data folder first.

## Open Work board (0.2.3)

**Open Work board** shows the board in the worktree or folder workspace you
are in, reusing that worktree's board tab, instead of silently switching to a
tab left in another worktree.
