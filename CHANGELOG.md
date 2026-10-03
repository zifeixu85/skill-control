# Changelog

本文件记录 Skill Control 的重要变化。格式参考
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循
[Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

All notable changes to Skill Control are documented here. The format is based
on Keep a Changelog and the project follows Semantic Versioning.

## [Unreleased]

### Added

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

- Skill discovery and fingerprinting can run in a background worker and reuse a
  bounded on-disk fingerprint cache to reduce repeated scanning work.
- TypeScript checking is now an explicit local, CI, and release quality gate.

### Security

- WorkBuddy expert members now reject sensitive paths and files whose resolved
  targets escape the expert package, instead of exposing their contents in
  capability metadata.

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
