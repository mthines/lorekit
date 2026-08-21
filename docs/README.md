# LoreKit — Documentation

| Document | Audience | What it covers |
|----------|----------|----------------|
| [architecture.md](./architecture.md) | All | System diagram, package map, auth tiers, data model |
| [decisions.md](./decisions.md) | All | Key architectural decisions (do not relitigate) — full rationale behind the CLAUDE.md index |
| [key-files.md](./key-files.md) | Developers | Annotated file index (~133 files) — the full-detail version of the CLAUDE.md "Key files" pointer |
| [cli.md](./cli.md) | Developers | `@lorekit/cli` command reference (install/doctor/read commands/hook/mcp) |
| [mcp-tools.md](./mcp-tools.md) | Agents + developers | All 10 MCP tools with request/response examples |
| [scope-format.md](./scope-format.md) | Agents + developers | Canonical scope string spec and resolution strategy |
| [org-sharing.md](./org-sharing.md) | Users + operators | Organizations & shared lore: roles, invites, ownership, deletion + recovery, invite emails |
| [github-app.md](./github-app.md) | Developers + operators | GitHub App integration: architecture, data model, fail-safe pending identity, Setup-URL bounce, post-merge operational runbook |
| [api-tokens.md](./api-tokens.md) | Developers | Token types, permissions, generation, CI usage |
| [embeddings.md](./embeddings.md) | Developers + operators | Semantic-search embeddings: the dormant schema, the opt-in pipeline, the manual backfill, cost measurement, rollback |
| [limits.md](./limits.md) | Agents + developers | Memory cap, rate limiting, per-user overrides, 429 semantics |
| [otel.md](./otel.md) | Developers | Dash0 setup, custom spans, environment variables |
| [telemetry-quality-review.md](./telemetry-quality-review.md) | Developers | Cross-service `traceparent` correlation contract, telemetry-quality review vs OTel semantic conventions, and the tests that guard it |
| [deployment.md](./deployment.md) | Developers | Step-by-step deployment for all three pieces |
| [storybook.md](./storybook.md) | Developers | Web Storybook: MSW-mocked full-page stories, determinism, and deploying Storybook as a second Vercel project |
| [releasing.md](./releasing.md) | Developers | Automated `@lorekit/cli` npm releases via release-please + conventional commits |

---

**For agents:** Start with [scope-format.md](./scope-format.md) and [mcp-tools.md](./mcp-tools.md).

**For new humans:** Start with [architecture.md](./architecture.md), then [deployment.md](./deployment.md).
