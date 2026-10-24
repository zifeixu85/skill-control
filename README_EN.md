# Skill Control

[简体中文](./README.md) · [English](./README_EN.md)

Skill Control is a local-first workbench for your AI Agents. It scans Codex,
Claude Code, WorkBuddy, Hermes, OpenClaw and other Agents on your computer and
brings their Skills, plugins, experts, connectors and MCP servers, secret
locations, updates, usage and estimated cost into one place, judged against the
Agents you actually use.

<!-- TODO(v0.2.0): re-take screenshots (overview, Skills, usage) from sample data in a temporary HOME, replace the v0.1 images in docs/images/, and reference them here. Never use real user data. -->

> Latest version: `v0.2.0`. See [Releases](../../releases) for downloadable
> desktop artifacts and their platform-validation status.

## Why Skill Control

The same Skill is often installed in several Agents, while plugins, MCP servers,
secrets and usage live in each product's own configuration folders. Maintaining
them by hand makes it easy to miss an installation, let copies drift, overwrite
the wrong version, or lose track of what you actually used this month. Skill
Control reads it all together:

- which Skills differ across your primary Agents, and which copy is newer;
- which Skills, plugins and Agents have new versions;
- how many tokens each Agent, Skill and project used, and roughly what that
  costs at official prices;
- which configurations have problems, and how to fix them.

Scanning happens locally. Every write shows a plan first, runs only after you
confirm, and can be undone.

## Features

### Built around your primary Agents

- Choose up to four Agents you use most; Skill status is judged against them,
  with suggestions from 30-day session activity when you have not chosen.
- Newly detected Agents are announced on the overview and in Settings; unknown
  folders that contain `skills/*/SKILL.md` can be added as custom Agents.
- One page per Agent: Skills, instruction / memory / rule files (redacted),
  tools and permissions, and usage.

### Skills and the Skill library

- See which Skills differ across primary Agents, which copy is newest,
  duplicates and shared folders.
- Browse Skill files, switch Markdown between rendered and source views, and
  preview common images and security-filtered SVG.
- 90-day Skill usage counts, labelled exact or inferred.
- Open each conflicting version, compare files, lines and images side by side,
  and pick the authoritative source.
- Synchronize by copy or symbolic link, with a backup before any replacement.
- Import, preview, install and export `.skill` archives, or export a standard
  `.zip`.
- **Skill library**: manage the shared `~/.agents/skills` library and simulate
  what each Agent actually sees under its own rules; adopt copies, switch to
  links, disable or uninstall to a trash, always from a confirmed plan.
- Skills, plugins, experts, MCP servers and the library sort by recently used,
  newest, most used or name.

### Updates

- **Skills and plugins**: provenance for every copy (skills CLI, Claude / Codex
  plugins, WorkBuddy, SkillHub, ClawHub, git and more) and upstream checks; local
  edits require your choice before they are replaced.
- **Agent software**: a daily version check against official sources only; CLI
  tools with an official update command get a one-click update that shows the
  command and its effects before it runs.
- **Skill Control itself**: in-app updates, see "App updates" below.

### Usage and estimated cost

- Tokens, sessions, Skill calls and projects across Claude Code, Codex,
  WorkBuddy, Hermes, OpenClaw, QClaw and Office Raccoon (办公小浣熊), for today, 7,
  30 and 90 days and all time.
- Every figure is labelled exact, inferred or reported by the product; only
  counts are stored, never conversation content.
- **Estimated cost** at each vendor's official API prices (long context, cache
  reads and writes, off-peak pricing). Subscription usage is estimated at API
  prices too; it is not your bill.
- **Model price table** with official sources and review dates, and a warning
  when prices may be out of date.

### Health checks and AI prompts

- Broken links, missing or invalid `SKILL.md`, oversized Skills, differing
  copies, missing commands and environment variables, literal secrets in
  configuration, plugin state and library problems.
- Every finding has "copy AI prompt": it only copies instructions for your own
  AI and changes nothing.
- Safe fixes have "preview fix": the files that will change are listed first,
  the fix runs after you confirm, and it can be undone from history.

### Experts, plugins, connectors and secrets

- **Experts and Agents**: WorkBuddy's own and marketplace experts and teams,
  Hermes profiles, OpenClaw agents, and Office Raccoon experts and teams.
- **Plugins** from Codex, Claude Code, WorkBuddy, Hermes, OpenClaw and QClaw.
- **Connectors and MCP**: a cross-Agent inventory, read-only with secrets masked.
- **Secrets**: which services keep keys where, who uses them and whether they
  changed. Only names and locations are shown; values are never read or shown.

### History, restore and uninstall

- Sync, import, update, library and fix operations are recorded and can be
  restored from history.
- Uninstalling a Skill from an Agent moves it to Skill Control's trash first.

Creating directory symlinks on Windows may require Developer Mode. Use the
default copy mode when unsure.

## Supported Agents

A tool becomes a data source only when it is detected locally or added manually.
Detected Agents are visible by default; change this in Settings → Primary Agents.

| Agent | Default Skill directories |
| --- | --- |
| Codex | `~/.codex/skills`, `~/.agents/skills`, `~/.codex/vendor_imports/skills` |
| Claude Code | `~/.claude/skills` |
| WorkBuddy | `~/.workbuddy/skills`, `~/.workbuddy/connectors/skills` |
| Hermes Agent | `~/.hermes/skills` (recursive, with profiles and external dirs, per Hermes rules) |
| OpenClaw | `~/.openclaw/skills` and OpenClaw's other Skill sources |
| QClaw | `~/.qclaw/skills` (read-only) |
| Office Raccoon (办公小浣熊) | `~/.box-agent/skills` (copies only, no symlinks) |
| SmartOrder (订单来了) | `~/.smartorder/skills` and skill directories of explicitly enabled plugins |
| Cursor | `~/.cursor/skills` |
| Gemini CLI | `~/.gemini/skills` |
| Kiro | `~/.kiro/skills` |
| Trae | `~/.trae/skills` |
| OpenCode | `~/.config/opencode/skills`, `~/.opencode/skills` |
| Windsurf | `~/.windsurf/skills` |
| Cline | `~/.cline/skills` |
| Roo Code | `~/.roo/skills`, `~/.roo-code/skills` |
| CodeBuddy | `~/.codebuddy/skills` |
| Qwen Code | `~/.qwen/skills`, `~/.qwen-code/skills` |
| GitHub Copilot | `~/.copilot/skills`, `~/.github/copilot/skills` |

Other compatible tools can be added manually with a name, short label, color,
and one or more Skill directories. Removing an Agent removes only its
configuration, never the Skill files. LumiClaw, MotiClaw and Clawith are shown
read-only (presence, version and counts).

### SmartOrder skills and connectors

Local, built-in and explicitly enabled plugin Skills are listed; disabled Skills
and marketplace/history caches are excluded, and managed plugin and system
Skills are read-only. Connectors show configuration summaries only, without
running commands or contacting services; credentials, environment values,
command arguments and URL paths/query strings are omitted.

## Install and run

### Desktop application

Download the file for your system from [Releases](../../releases):

| Your system | Choose this file |
| --- | --- |
| Apple Silicon Mac (M1/M2/M3/M4/M5…) | `Skill-Control-0.2.0-mac-arm64.dmg` |
| Intel Mac | `Skill-Control-0.2.0-mac-x64.dmg` |
| Windows x64 | `Skill-Control-0.2.0-win-x64-setup.exe` (installer) or `…-portable.exe` |
| Linux x64 | `Skill-Control-0.2.0-linux-x86_64.AppImage` or `…-linux-amd64.deb` |

Apple Silicon users should not choose `mac-x64`, which macOS treats as an Intel
application. The `*.zip`, `latest*.yml` and `*.blockmap` files in a release are
used by the in-app updater; `SHA256SUMS.txt` lists checksums for every file.

Installers are not yet code-signed or notarized: macOS may ask you to confirm
the first launch in System Settings → Privacy & Security, Windows SmartScreen may
show an unknown-publisher warning, and the AppImage needs execute permission.

### App updates

Starting with v0.2.0, Skill Control checks GitHub Releases at start (when the
last check is older than 24 hours), then daily, or on demand in Settings → About.

- **macOS**: verifies the sha512, checks the new app's bundle id and version,
  replaces the current app (the old one goes to the Trash) and relaunches; any
  failure restores the previous version. Keep the app in Applications: run from
  the DMG or from a read-only location, it opens the download page instead.
- **Windows**: the installer build downloads and installs in place (installers
  are unsigned, so SmartScreen may warn); the portable build is updated manually.
- **Linux**: the AppImage updates in place; the `.deb` is updated manually.
- Only full releases are offered, never pre-releases. Offline mode and source
  runs never check.

### Run from source

Requires Node.js `22.13.0` or later, npm and Git.

```bash
git clone https://github.com/zifeixu85/skill-control.git
cd skill-control
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). `npm run dev` launches both
the UI and the local manager service, which listens only on `127.0.0.1:43110`.

```bash
npm run build && npm start   # run a production build
npm run desktop:dev          # Electron development window
```

Desktop packaging commands are listed in `package.json`; maintainers should
build and validate each artifact on its target platform (see the
[release guide](./docs/RELEASING.md)).

## `.skill` and ZIP export

`.skill` files are ZIP containers with one `SKILL.md`, at the root or inside one
top-level directory. Exports can keep the `.skill` extension or use a standard
`.zip`. Import limits: archives and individual files up to 25 MB, up to 1,500
entries, up to 100 MB uncompressed; path traversal and multiple Skill roots are
rejected. Imports are extracted to a local staging area for preview; selecting
a file does not modify an Agent directory.

## Data and privacy

Skill Control stores its data under:

```text
~/.agent-skill-manager/
├── config.json            configuration (primary and visible Agents, custom directories)
├── history.jsonl          operation history
├── backups/               backups taken before replacements
├── trash/                 Skills removed by uninstall or clean-up
├── imports/               staged .skill imports
├── usage-index.json       usage index (counts only, no conversation content)
├── fingerprint-cache.json content fingerprint cache
└── …                      update, Agent version and secret-change caches
```

App update results live in the desktop app's user data folder (on macOS
`~/Library/Application Support/Skill Control/app-update.json`); downloaded
updates go to the system temp folder and are deleted after install or failure.

There is no telemetry and Skill content is never uploaded. Network access is
limited to app update checks (this repository's releases on `api.github.com` and
`github.com`), Agent version checks and Skill / plugin update detection (npm
registry, GitHub and each product's own update source), and one-click updates
you confirm. `SKILL_MANAGER_UPDATES_OFFLINE=1` turns all checks off. See
[PRIVACY.md](./PRIVACY.md).

## Development

```bash
npm run dev         # local manager service + development UI
npm run dev:ui      # UI development on side ports
npm run build       # build the UI
npm start           # built UI + local manager service
npm run desktop:dev # Electron development window
npm test            # build and run the Node test suite
npm run lint        # ESLint
npm run typecheck   # TypeScript type checking
```

```text
app/       React UI
desktop/   Electron main process, preload, app updates and development runner
server/    local scanning, preview, sync, updates, usage and health service
scripts/   development, packaging and release scripts
tests/     Node tests
resources/ desktop icon, licenses and platform resources
worker/    web build entry point
```

By default the local service accepts requests only from
`http://localhost:3000` and `http://127.0.0.1:3000`. Before changing file
writes, archive parsing, or path resolution, read the security constraints in
[CONTRIBUTING.md](./CONTRIBUTING.md); the architecture is described in
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Roadmap

- application signing and notarization;
- an optional CLI for automation and advanced users;
- an auditable extension mechanism for Agent directory rules.

The roadmap describes direction and does not imply that an item is available in
the current release.

## Contributing

Bug reports, interaction improvements, Agent adapters, and security fixes are
welcome:

- [Contributing guide](./CONTRIBUTING.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Security policy](./SECURITY.md)
- [Third-party notices](./THIRD_PARTY_NOTICES.md)
- [Changelog](./CHANGELOG.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Release guide](./docs/RELEASING.md)
- [GitHub repository setup](./docs/REPOSITORY_SETUP.md)

## Author

Built and maintained by A梦.

- Repository: [github.com/zifeixu85/skill-control](https://github.com/zifeixu85/skill-control)
- Website: [ameng.blog](https://ameng.blog)

Please report problems and ideas in
[GitHub Issues](https://github.com/zifeixu85/skill-control/issues).

## License

Licensed under the [MIT License](./LICENSE).
