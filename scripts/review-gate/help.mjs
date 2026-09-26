export const HELP = `Rove Sentinel — committed code review with Claude Code and Codex

Start here:
  rove-sentinel doctor                 Check tools and authentication
  rove-sentinel init                   Create configuration and hook adapters
  rove-sentinel install --dry-run      Preview trusted policy installation
  rove-sentinel install                Install and start the local watcher
  rove-sentinel status                 Inspect health and local records
  rove-sentinel update-check           Check for a newer stable release
  rove-sentinel updates                Inspect automatic engine updates

Review:
  gate [--base REF] [--head REF] [--branch NAME]
       [--author auto|claude|codex|grok|human] [--risk low|medium|high]
       [--native-evidence TEXT] [--force] [--dry-run] [--json]
       [--detach [--log PATH]] [--state-root PATH]
  defer --report ID --finding ID[,ID...]|all --reason TEXT
       [--base REF] [--head REF] [--branch NAME]

Operations:
  watch [--once] [--no-github] [--daemon]
  pause --reason TEXT
  resume
  recover --reason TEXT
  uninstall [--dry-run]
  install [--dry-run] [--no-start]
  update-check [--force] [--json] [--no-update-check]
  updates [--enable|--disable]         Configure background engine updates
  update                              Retry an update now (normally automatic)

status and doctor include an advisory update check (cached for 24 hours).
Use --no-update-check or ROVE_SENTINEL_UPDATE_CHECK=0 to disable network checks.
Windows watchers update the engine automatically in separate versioned folders.
Existing reviews finish first. Use updates --disable to keep the current engine.
ROVE_SENTINEL_AUTO_UPDATE=0 disables background installation, separately from notices.

Optional integrations:
  ledger --pr N [--write] [--heading TEXT] [--json]
  design-evidence [--base REF] [--head REF] [--branch NAME]

Use --repo ROOT to target a checkout. Default review base: origin/main.
Both AI CLIs must be installed and authenticated. The grok author label does
not enable a Grok provider. Uncommitted changes are not reviewed.

--detach starts a hidden background review and returns its PID and log path;
it does not mean PASS. Read the log's final [review-gate] exit <code> marker.
Verified P0/P1 always block. Copy the report's complete deferral command for
eligible findings; a recorded reason is required before pushing advisories.

The pre-push command is reserved for Git hooks. design-evidence validates
the optional Rove evidence format; it does not take screenshots.

Installation and examples: https://github.com/jayyanez/rove-sentinel#readme`;
