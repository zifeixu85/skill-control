# Skill Control

[简体中文](./README.md) · [English](./README_EN.md)

Skill Control is a local-first visual manager for Agent Skills. It scans
`SKILL.md` directories on your computer and provides one place to search,
inspect, compare, import, export, and synchronize Skills across tools.

![Skill Control overview](./docs/images/overview.png)

> Current version: the first public `v0.1.0` release. Source code and desktop
> artifacts that passed smoke tests on their target platforms are available on
> the [Releases](../../releases) page.

## Why Skill Control

The same Skill often needs to be installed in Codex, Claude Code, and other
Agent tools. Copying directories manually makes it easy to miss an installation,
overwrite the wrong version, or let copies drift. Skill Control groups local
installations by Skill name and shows a plan before it writes:

- which tools are missing the Skill;
- whether installations with the same name contain identical content;
- whether an operation will create, replace, or skip a directory;
- where an existing version will be backed up.

Core scanning and synchronization happen locally. Skill content does not need
to be uploaded to a remote service.

## Features

### Manage local Skills

- Scan local directories compatible with `SKILL.md` and group Skills by their
  frontmatter `name`;
- switch between Agents and inspect the Skills installed for each tool;
- search names, localized names, descriptions, and tags, and filter by status;
- progressively reveal large Skill and synchronization lists instead of
  rendering every row on the first screen;
- display installation coverage, content fingerprints, modification time, file
  count, size, and symbolic-link state;
- identify aligned, incomplete, single-tool, and conflicting installations;
- prefer a Chinese name and description when they are present in `SKILL.md`.

### Inspect and exchange

- browse a Skill file tree (very large trees are truncated at the safety
  limit), with directories collapsed by default in installed-Skill details;
- select `SKILL.md` by default;
- switch Markdown files between rendered preview and source;
- preview text files and inspect metadata for non-previewable files;
- reveal a Skill directory in the system file manager;
- export a local Skill as a portable `.skill` archive;
- drag or choose a `.skill` file, inspect it first, and then select installation
  targets;
- use collapsible directories, rendered Markdown, and source view in `.skill`
  import previews as well.

![Skill Control Skill detail and Markdown preview](./docs/images/skill-detail.png)

### Synchronize safely

- Generate a create, replace, and skip plan before synchronization;
- use copy mode for independent copies;
- use symbolic-link mode when multiple tools should share one live directory;
- back up existing directories before replacement;
- write only after the user has previewed and explicitly confirmed the plan;
- keep synchronization and import history on the local machine.

Creating directory symlinks on Windows may require Developer Mode or an account
with the corresponding privilege. Use the default copy mode when unsure.

## Supported Agent tools

The built-in directory rules are listed below. A tool becomes a data source only
when it is detected locally or configured manually. By default, the Skill list
shows Codex and Claude Code; this can be changed under Tool Sources.

| Tool | Default directories |
| --- | --- |
| Codex | `~/.codex/skills`, `~/.agents/skills`, `~/.codex/vendor_imports/skills` |
| Claude Code | `~/.claude/skills` |
| WorkBuddy | `~/.workbuddy/skills`, `~/.workbuddy/connectors/skills` |
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
and one or more Skill directories.

## Install and run

### Desktop application

The `v0.1.0` desktop release provides artifacts for macOS, Windows, and Linux.
Consult the [Releases](../../releases) page for the actual
packaging and signing status. If no artifact is available for your platform,
use the source workflow below.

| Your system | Choose this artifact |
| --- | --- |
| Apple Silicon Mac (M1/M2/M3/M4/M5…) | `Skill-Control-0.1.0-mac-arm64.dmg` |
| Intel Mac | `Skill-Control-0.1.0-mac-x64.dmg` |
| Windows x64 | filename containing `win-x64-setup`; `portable` needs no install |
| Linux x64 | `.AppImage` or `.deb` |

Apple Silicon users should not choose `mac-x64`, which macOS treats as an Intel
application and may show a compatibility notice for. The first release is not
signed or notarized; see the Release notes for operating-system warnings.

### Run from source

Requirements:

- Node.js `22.13.0` or later;
- npm;
- Git.

```bash
git clone https://github.com/zifeixu85/skill-control.git
cd skill-control
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). `npm run dev` launches both
the UI and the local manager service, which listens only on
`127.0.0.1:43110`.

To run a production build:

```bash
npm run build
npm start
```

To develop the desktop shell:

```bash
npm run desktop:dev
```

This starts an Electron development window connected to the local development
UI and manager service. Desktop packaging commands are listed in `package.json`;
release maintainers should build and validate each artifact on its target
platform.

## The `.skill` format

Skill Control treats `.skill` files as ZIP containers. An archive must include
one `SKILL.md`, either at its root or inside one top-level directory.

Import limits:

- archive size up to 25 MB;
- up to 1,500 entries;
- individual file size up to 25 MB;
- total uncompressed size up to 100 MB;
- path traversal and multiple Skill roots are rejected.

An imported archive is extracted into a local staging area for preview. Merely
selecting a file does not modify an Agent directory.
Export applies the same per-file, total-size, and entry limits. It also stops
when the compressed result exceeds 25 MB, avoiding unbounded desktop-process
memory use for oversized directories.

## Data and privacy

Configuration, operation history, staged imports, and pre-replacement backups
are stored under:

```text
~/.agent-skill-manager/
├── config.json
├── history.jsonl
├── imports/
└── backups/
```

Skill Control includes no telemetry service and does not upload Skill content to
the project's maintainers. See [PRIVACY.md](./PRIVACY.md) for the data scope,
deletion instructions, and network boundaries.

## Development

Common commands:

```bash
npm run dev      # Local manager service + development UI
npm run build    # Build the UI
npm start        # Built UI + local manager service
npm run desktop:dev # Electron development window
npm test         # Build and run the Node test suite
npm run lint     # ESLint
```

Main directories:

```text
app/                     React UI
desktop/                 Electron main process, preload, and development runner
server/local-server.mjs  Local scanning, preview, archive, and sync service
scripts/                 Local development/runtime orchestration
tests/                   Local service and rendering tests
resources/               Desktop icon and platform resources
worker/                  Web build entry point
```

By default, the local service accepts requests only from
`http://localhost:3000` and `http://127.0.0.1:3000`. To use different settings
during development:

```bash
SKILL_MANAGER_PORT=43110 \
SKILL_MANAGER_ORIGINS=http://localhost:3000 \
npm run manager
```

Before changing file writes, archive parsing, or path resolution, read the
security constraints in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Roadmap

- application signing, notarization, and secure updates;
- finer-grained backup browsing and restoration;
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

## License

Licensed under the [MIT License](./LICENSE).
