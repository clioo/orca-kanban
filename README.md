# Orca Kanban — macOS Apple Silicon distribution

This tag contains the ready-to-install plugin, not its source checkout.

In Orca, open **Settings → Plugins → Install plugin → Git URL** and paste:

```
https://github.com/clioo/orca-kanban.git#macos-arm64-v0.2.0
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
