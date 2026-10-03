# Changelog

本文件记录 Skill Control 的重要变化。格式参考
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循
[Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

All notable changes to Skill Control are documented here. The format is based
on Keep a Changelog and the project follows Semantic Versioning.

## [Unreleased]

### Added

- Primary agents ("常用 Agent"): `primaryAgentIds` in the configuration, a
  stat-only session activity scan (`GET /api/agents/activity`) that suggests up
  to two primary agents by recent session bytes, and a primary-scoped status
  model on every skill (`primaryStatus`, `newest`, `behind`, `diverged`,
  `installedPrimary`, `missingPrimary`, `managed`, `duplicates`) plus a scan
  `summary`. Existing `status` fields are unchanged.
- Shared-directory awareness: roots and skills are resolved to real paths,
  `sharedRoots` reports roots that point at the same directory (for example a
  Mirasim-managed `~/.mirasim/skills`), and one physical skill is counted once
  per agent.
- Read-only Agent integrations: Codex plugins and connected apps, Claude Code
  plugins, and an MCP server inventory across Codex, Claude Code, Cursor and
  Gemini, via `GET /api/integrations`, `/api/plugins`, `/api/mcp`,
  `/api/plugin-asset` and a `codex` section in `/api/connectors`.
- WorkBuddy "我的专家" (user-created experts) alongside marketplace experts, with
  origin, version, install/in-use state, distributable package, skills, default
  and quick prompts, tags, avatars for experts and team members
  (`GET /api/expert-avatar`), and best-effort, read-only usage counts from
  WorkBuddy's local database (expert id, count and last use only).
- WorkBuddy installed plugins in `/api/integrations` and `/api/plugins`.
- Read-only configuration details (`GET /api/config-detail`) for Agents
  (Chinese setting rows), MCP servers (their own section in the native TOML or
  JSON format with secrets masked), experts, plugins and skills.
- Codex bundled system skills (`~/.codex/skills/.system`) and Mirasim-synced
  skills are recognized as managed copies, so they no longer show up as
  differing versions or duplicates.
- SmartOrder (订单来了) local and enabled-plugin skill discovery, with disabled
  entries excluded and managed plugin/system skills protected from overwrite.
- Read-only connector configuration view under Other, with MCP summaries from
  SmartOrder and its enabled plugins. Credentials and command arguments are
  omitted; scanning does not contact or run connector services.
- WorkBuddy expert and expert-team discovery, plus Hermes default and named
  Agent Profile inspection with localized metadata and safe configuration
  summaries.
- Image preview for common raster formats and security-filtered SVG, including
  installed Skills, imported archives, expert packages, and visual comparison.
- Full conflict-version inspection with file-level changes, line-level text
  differences, and side-by-side image comparison.
- Portable ZIP export alongside the `.skill` archive format.

### Changed

- Skill display names now come from explicit frontmatter display keys, else the
  first H1 that precedes any deeper heading (≤ 40 characters, never inside code
  fences), else the technical name. `description` stays the frontmatter text;
  a Chinese first paragraph is exposed separately as `descriptionZh`.
- Sync and import plans never write twice into the same real directory: shared
  targets become `noop` with a reason, and each action reports
  `realDestination` and the other agents that will see the write.
- Agent `installationCount` and `totals.installations` count distinct physical
  skill directories.
- Sync and import write through a symlinked destination to its real directory
  (which must lie inside a configured Agent root) instead of replacing the
  link, so Agents that share a skill stay in sync; the backup holds the real
  content.
- Duplicate detection ignores managed copies, reports whether copies are
  identical, and the summary counts primary agents only.
- Integration and activity scans are cached with single-flight loading and a
  forced-refresh debounce; one failing scanner no longer fails the request.
- Skill discovery and fingerprinting can run in a background worker and reuse a
  bounded on-disk fingerprint cache to reduce repeated scanning work.
- TypeScript checking is now an explicit local, CI, and release quality gate.

### Security

- WorkBuddy expert members now reject sensitive paths and files whose resolved
  targets escape the expert package, instead of exposing their contents in
  capability metadata.
- Integration scanners read bounded files only, refuse plugin directories and
  assets that resolve outside their roots, and never return MCP commands,
  arguments, header/env values or full URLs — only the names of fields that
  hold literal secrets.
- A symlink-mode sync whose target is the same physical directory as its
  source is now planned as a no-op instead of replacing the directory with a
  link to itself.
- Copy-mode sync no longer dereferences every symlink: links whose real target
  is outside the source skill (for example `notes -> ~/.ssh/id_rsa`), dangling
  links and loops are skipped and reported instead of being copied into every
  target.
- Requests whose `Host` header is not a loopback address with the service port
  are rejected, closing a DNS-rebinding bypass of the Origin check.
- Markdown metadata parsing and MCP secret detection use clamped inputs and
  bounded patterns (ReDoS), and background scans are stopped by a 60 second
  watchdog.
- MCP `secretFields` now also covers every literal header/env value, credential
  value shapes, arguments, URL userinfo and token-like path segments, while
  still returning field locations only; `likelySecretFields` marks the subset
  that looks like a credential.
- Configuration details use default-deny masking: key names stay visible, but
  a value is shown only when it is a boolean, short integer, known enum,
  environment reference, hostname, credential-free path, URL reduced to host and
  non-token path segments, identifier under a known identifier key, or redacted
  text under a known descriptive key. Secret-named keys mask their whole
  subtree; command lines and argument lists are tokenized so values after
  credential flags, `K=V` values and header values are masked. Whole plugin and
  expert manifests are masked, and manifest-declared files must be non-sensitive
  `.json` files inside the plugin.
- Free text (SKILL.md, agent prompts, SOUL.md, descriptions, permission rules,
  status-line commands) is redacted for PEM private keys, URL credentials in any
  scheme, secret-named assignments, `-u user:pass`, `-H "Name: value"`,
  "key is …" phrases and common token formats; `Bearer`/`Basic` only before a
  token-shaped value.
- `/api/capability-file` masks or redacts WorkBuddy expert and Hermes files the
  same way and refuses `.mcp.json`, `.npmrc`, `.netrc`, `*.pem`, `*.key` and
  `id_*`.
- Cross-site requests (`Sec-Fetch-Site: cross-site`) to configuration and asset
  routes are rejected; SVG previews are capped at 256 KB with bounded
  validation; Windows home paths are compacted; absolute symlink targets are
  no longer returned; WorkBuddy's database is queried with `query_only`.
- Error messages no longer include the home directory, configuration files are
  opened non-blocking (FIFO-safe), outbound strings drop bidi/zero-width
  characters, and SVG previews additionally reject namespaced scripts,
  `<set>`/`<animate>`, `image-set()` and escaped CSS.

## [0.1.0] - 2026-07-26

### Added

- Electron desktop applications for macOS arm64/x64, Windows x64, and Linux
  x64, with packaged application smoke tests in the release workflow.
- Open-source governance, contribution, security, privacy, release, and
  bilingual project documentation.
- Local discovery for Codex, Claude Code, WorkBuddy, and a built-in catalog of
  additional Agent Skill directories.
- Custom Agent names, labels, colors, paths, and visibility.
- Skill aggregation by frontmatter name, content fingerprints, coverage, and
  conflict detection.
- Chinese-first metadata display when localized information is available.
- Skill detail browser with collapsed folders, default `SKILL.md` selection,
  Markdown rendering, and source view.
- `.skill` archive preview with collapsed folders and rendered/source Markdown,
  import, multi-Agent installation, and export.
- Progressive rendering for large Skill and synchronization lists.
- Cross-platform reveal-in-file-manager behavior for macOS, Windows, and Linux.
- Copy and symbolic-link synchronization modes.
- Dry-run plans, explicit write confirmation, pre-replacement backups, and
  local operation history.
- Loopback-only local manager service with origin checks and archive/path
  safety limits.

### Changed

- Desktop services now choose free loopback ports automatically when a default
  port is occupied.
- Skill replacement prepares the new directory first and restores the previous
  directory if the final switch fails.
- Modal focus, responsive navigation, large-list rendering, contrast, spacing,
  and scroll behavior were refined for a production-ready first release.

### Security

- Added `.skill` export size limits, strict target-root checks, sandboxed
  renderer boundaries, a production Content Security Policy, and full-SHA
  pinning for release Actions.
