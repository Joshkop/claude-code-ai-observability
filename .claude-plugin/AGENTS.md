<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-27 | Updated: 2026-04-27 -->

# .claude-plugin

## Purpose
Claude Code plugin manifest directory. Identifies this repo as an installable plugin and exposes marketplace metadata.

## Key Files
| File | Description |
|------|-------------|
| `plugin.json` | Plugin identity: name, description, version, author, license, repository, keywords. The `version` field is read at runtime as `PLUGIN_VERSION` (see `src/plugin-meta.ts`). |
| `marketplace.json` | Marketplace listing metadata for discovery via `/plugin marketplace add`. |

## For AI Agents

### Working In This Directory
- **Bump `version` here AND in the root `package.json` together** — they must stay in sync. `src/plugin-meta.ts` reads `plugin.json` for the runtime version string used in stale-collector eviction.
- Don't add runtime logic here; this directory is metadata only.

## Dependencies

### Internal
- Read by `src/plugin-meta.ts` at runtime.

<!-- MANUAL: -->
