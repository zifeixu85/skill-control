# Changelog

本文件记录 Skill Control 的重要变化。格式参考
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循
[Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

All notable changes to Skill Control are documented here. The format is based
on Keep a Changelog and the project follows Semantic Versioning.

## [Unreleased]

No unreleased changes yet.

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
