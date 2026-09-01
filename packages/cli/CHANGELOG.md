# Changelog

## [1.64.0](https://github.com/mthines/lorekit/compare/cli-v1.63.2...cli-v1.64.0) (2026-09-01)


### Features

* **cli:** add unkinded-state-record lint rule ([79d309f](https://github.com/mthines/lorekit/commit/79d309fc5843a2af2e93eb67a10fc6175044cf25))


### Documentation

* **cli:** sync the local-store frontmatter field list with FIELDS ([8fb1f97](https://github.com/mthines/lorekit/commit/8fb1f97090000ca39b771a92122334f77cc089bb))

## [1.63.2](https://github.com/mthines/lorekit/compare/cli-v1.63.1...cli-v1.63.2) (2026-09-01)


### Documentation

* **cli:** fix stale two-tier frontmatter in lorekit-setup SKILL.md ([b89a801](https://github.com/mthines/lorekit/commit/b89a8015b3634f0533b9daacfc6663b0b6d6d85b))
* **cli:** fix stale two-tier frontmatter in lorekit-setup SKILL.md ([cf7904c](https://github.com/mthines/lorekit/commit/cf7904c27f84df6d4bd5517bd6bd51d53b0ae14c))

## [1.63.1](https://github.com/mthines/lorekit/compare/cli-v1.63.0...cli-v1.63.1) (2026-09-01)


### Documentation

* **cli:** advisory does gate under --strict-all ([1b76eb2](https://github.com/mthines/lorekit/commit/1b76eb2e2af30f35cc4f7dd9742a7d397372d0e8))
* **cli:** bring lorekit-setup skill current with the compile pipeline ([06a6149](https://github.com/mthines/lorekit/commit/06a6149cc346a6518225de5f869e28e57d2dcd79))
* **cli:** bring lorekit-setup skill current with the compile pipeline ([a8a843b](https://github.com/mthines/lorekit/commit/a8a843b8f268aa4650d9c7e4aad9772c6cabd12f))
* **cli:** demotion on false positives is a manual policy, not automation ([b25ab6e](https://github.com/mthines/lorekit/commit/b25ab6e8edbcb2e4100accce9c5099733ccdab28))

## [1.63.0](https://github.com/mthines/lorekit/compare/cli-v1.62.0...cli-v1.63.0) (2026-09-01)


### Features

* **cli:** add digest-contract-doc obligations-map entry ([e514da4](https://github.com/mthines/lorekit/commit/e514da4f5f33862b8357ee6a9ab361b5d4097522))
* **cli:** add digest-contract-doc obligations-map entry ([3e74be8](https://github.com/mthines/lorekit/commit/3e74be808c64400d3be67804cd853f1f353850ca))

## [1.62.0](https://github.com/mthines/lorekit/compare/cli-v1.61.0...cli-v1.62.0) (2026-09-01)


### Features

* Duplicate Clusters panel in the Lore Explorer (+ GET /memories/clusters) ([ceb1cf8](https://github.com/mthines/lorekit/commit/ceb1cf8b196fbfa8676ef2d3835765f11c0cd6c3))

## [1.61.0](https://github.com/mthines/lorekit/compare/cli-v1.60.0...cli-v1.61.0) (2026-08-31)


### Features

* **cli:** add `lorekit invariants candidates` ([6d57dc0](https://github.com/mthines/lorekit/commit/6d57dc0b851ecff52c6548408357134f64e4b922))
* **cli:** join dedupe clusters to named recurrence classes ([cebe076](https://github.com/mthines/lorekit/commit/cebe07656af3ee36c26b0518ae9861c3946287bf))
* **cli:** name recurrence classes and add a state ladder to obligations ([1a46d4a](https://github.com/mthines/lorekit/commit/1a46d4a0765508f6407566786c359c9a97a9974a))
* **cli:** name recurrence classes and add a state ladder to obligations ([499fa25](https://github.com/mthines/lorekit/commit/499fa25550bb45b17902cebf335349a66ea41029))


### Bug Fixes

* **cli:** scope --strict text and allow &gt; in meta comment content ([2554330](https://github.com/mthines/lorekit/commit/2554330d45edaab69b2cd76f2400511124f1e46f))

## [1.60.0](https://github.com/mthines/lorekit/compare/cli-v1.59.1...cli-v1.60.0) (2026-08-30)


### Features

* **retention:** let a policy carry the Explorer's dimension filters ([08e84fb](https://github.com/mthines/lorekit/commit/08e84fb1d04e0208c1ed0a81c32e8d3eaa8b1d64))
* **web:** filter the Lore Explorer by retention-policy conditions ([53389f2](https://github.com/mthines/lorekit/commit/53389f200b315d1552ec657740980b5d6c56b5f7))


### Bug Fixes

* **web:** resolve merge-with-main drift breaking CI ([9e2cd78](https://github.com/mthines/lorekit/commit/9e2cd78efc04146ffb866f2f1e8363ccd8cc749c))

## [1.59.1](https://github.com/mthines/lorekit/compare/cli-v1.59.0...cli-v1.59.1) (2026-08-29)


### Bug Fixes

* **cli:** prefer Cursor's conversation_id over generation_id for session grouping ([d7a50da](https://github.com/mthines/lorekit/commit/d7a50dad22aa52233f5445a69d1672838a8a3795))
* **insights:** unblock Hot & cold lore and Runs; drop the demo feature flags ([5d8feeb](https://github.com/mthines/lorekit/commit/5d8feebe13cf8f6f707665c302342e0bbc28dce3))

## [1.59.0](https://github.com/mthines/lorekit/compare/cli-v1.58.0...cli-v1.59.0) (2026-08-28)


### Features

* retention policies for automatic lore grooming ([9107a60](https://github.com/mthines/lorekit/commit/9107a60109fb8336151c5eb634a1fd2baeeca279))


### Bug Fixes

* **migrations:** renumber grooming migrations past main's 00079/00080 ([6ad137d](https://github.com/mthines/lorekit/commit/6ad137db004f7c845c3480e253d43e36f6214ca2))
* resolve merge conflict with main and renumber grooming migrations ([b35b8bc](https://github.com/mthines/lorekit/commit/b35b8bc081172c9999af53cfd67c8d44228abe3b))

## [1.58.0](https://github.com/mthines/lorekit/compare/cli-v1.57.0...cli-v1.58.0) (2026-08-28)


### Features

* **web:** consolidate memory-consumption analytics into a single Insights page ([ac99e64](https://github.com/mthines/lorekit/commit/ac99e6445d3da0274634ecf4e61b6df40b2659b6))

## [1.57.0](https://github.com/mthines/lorekit/compare/cli-v1.56.0...cli-v1.57.0) (2026-08-27)


### Features

* **cli:** add zsh/fish shell completion + install --completions ([7760e11](https://github.com/mthines/lorekit/commit/7760e118ffe36a1ea3f0d0782fd4d5dbafe4e39d))
* **cli:** zsh/fish shell completion, installable via `install --completions` ([69e17b4](https://github.com/mthines/lorekit/commit/69e17b48fb9ec9f785a1717fc3677a623d99c833))

## [1.56.0](https://github.com/mthines/lorekit/compare/cli-v1.55.3...cli-v1.56.0) (2026-08-26)


### Features

* **cli:** add `lorekit obligations` Surface-Partner Map check ([293de50](https://github.com/mthines/lorekit/commit/293de5093c193de91e87cd7ddd96910693b800ca))
* **cli:** add lorekit obligations Surface-Partner Map check ([99a9c76](https://github.com/mthines/lorekit/commit/99a9c76fb4f89193d684d44397ce51ab2d560fd0))


### Bug Fixes

* **cli:** resolve edge-mirror false positive via a shared pair inventory ([a398416](https://github.com/mthines/lorekit/commit/a398416cd6ef64e21918de723d077fbcedd3ee08))


### Documentation

* **cli:** add obligations to traceCommand JSDoc bounded list ([58ac037](https://github.com/mthines/lorekit/commit/58ac037c6fcdc8bcd443ef017555bf9a697bc5d5))

## [1.55.3](https://github.com/mthines/lorekit/compare/cli-v1.55.2...cli-v1.55.3) (2026-08-25)


### Bug Fixes

* **cli:** resolve scope::key shorthand when the key contains :: ([0c37c69](https://github.com/mthines/lorekit/commit/0c37c69542b9b34f533dc1ef111f5934095f4386))
* **cli:** resolve scope::key shorthand when the key contains :: ([6ddfb9e](https://github.com/mthines/lorekit/commit/6ddfb9e82de707930c551e9d902328769e19a0bc))

## [1.55.2](https://github.com/mthines/lorekit/compare/cli-v1.55.1...cli-v1.55.2) (2026-08-23)


### Bug Fixes

* **mcp:** a tool-originated failure is an isError result, not a protocol error ([dfa8115](https://github.com/mthines/lorekit/commit/dfa8115b92fbd5e754c1c2f4282a3516485d0c4b))
* **mcp:** a tool-originated failure is an isError result, not a protocol error ([2d40563](https://github.com/mthines/lorekit/commit/2d405637e1734f7d574146888670f85e1ac8fe54))

## [1.55.1](https://github.com/mthines/lorekit/compare/cli-v1.55.0...cli-v1.55.1) (2026-08-22)


### Bug Fixes

* **web:** accept a memory UUID in ?lesson=, and say so in the CLI docs ([372e801](https://github.com/mthines/lorekit/commit/372e8012e51e959b2923e2aed339c6564d46a4fb))

## [1.55.0](https://github.com/mthines/lorekit/compare/cli-v1.54.0...cli-v1.55.0) (2026-08-22)


### Features

* **telemetry:** make CLI runs and edge environments differentiable ([ade2bc4](https://github.com/mthines/lorekit/commit/ade2bc4db44520e9edfe2c6fcda5c246af92cbb4))
* **telemetry:** make CLI runs and edge environments differentiable ([5ccae39](https://github.com/mthines/lorekit/commit/5ccae394230e7bb2dcf842a170364d858feecf41))

## [1.54.0](https://github.com/mthines/lorekit/compare/cli-v1.53.0...cli-v1.54.0) (2026-08-22)


### Features

* **cli:** add purge and purge-expired ([b3ccc09](https://github.com/mthines/lorekit/commit/b3ccc09cc6385103c1698b568bf9e93e79ca7a69))
* make the tool catalog the single origin of the operation surface ([b0ca42b](https://github.com/mthines/lorekit/commit/b0ca42b4f3e4f431eb8128231c74a30193e35226))
* **scripts:** add the gen-surfaces generator + freshness gate ([6131a00](https://github.com/mthines/lorekit/commit/6131a0007c1dae4bb6733a88ca0dab1498934e37))


### Bug Fixes

* **cli:** always send an explicit retention window on purge ([83bc001](https://github.com/mthines/lorekit/commit/83bc0011ad0b70757e934d2f4296067ee36df97f))
* **cli:** dispatch memory.restore on the local stdio MCP server ([000e63c](https://github.com/mthines/lorekit/commit/000e63c6621e5407e3267205c6e3b9abd02b43aa))
* **cli:** drive the stdio advertisement from the dispatch keys ([18eed19](https://github.com/mthines/lorekit/commit/18eed198b870933167775a43541ac7f24a2d95a5))
* **cli:** refuse a purge with no retention window, loudly ([ca159fd](https://github.com/mthines/lorekit/commit/ca159fd67efaa00db3d45e9d20564311128e6a40))
* **cli:** reject unknown flags on lorekit bootstrap ([9b191db](https://github.com/mthines/lorekit/commit/9b191db6e96a8ffeb55b0de830fbaccb7775661b))

## [1.53.0](https://github.com/mthines/lorekit/compare/cli-v1.52.3...cli-v1.53.0) (2026-08-21)


### Features

* **auth:** scope-authorized removal and restore for API tokens ([4c097d5](https://github.com/mthines/lorekit/commit/4c097d5cd7b68f6dbec66905e31ca4d1cba03c43))
* **auth:** scope-authorized removal and restore for API tokens ([d3aaad6](https://github.com/mthines/lorekit/commit/d3aaad60f0819b0d2216b7370d7f59c7e083da25))
* scope an API key from the dashboard, and enforce it end to end ([ccc50ee](https://github.com/mthines/lorekit/commit/ccc50eee758be4622ec9dbd6b0612832e7ec119e))

## [1.52.3](https://github.com/mthines/lorekit/compare/cli-v1.52.2...cli-v1.52.3) (2026-08-18)


### Bug Fixes

* **api:** validate the ?scope= filter across the six single-scope routes ([9b463b6](https://github.com/mthines/lorekit/commit/9b463b6da9a0bfbb5f6888e6b58720e982f03f66))


### Documentation

* stop asserting every scope is lowercased on ingest ([1c4ebaf](https://github.com/mthines/lorekit/commit/1c4ebafb713a592f38fe8cd80bcf70c18b526f9c))

## [1.52.2](https://github.com/mthines/lorekit/compare/cli-v1.52.1...cli-v1.52.2) (2026-08-16)


### Documentation

* **lorekit-setup:** CI state records default to a short TTL, not permanent ([0047a55](https://github.com/mthines/lorekit/commit/0047a5529c48a31f9c6ba92e6416a6bc83c49d51))
* **lorekit-setup:** teach the skill programmatic CI state records ([3cea98e](https://github.com/mthines/lorekit/commit/3cea98e768a8f887ddce54aa526f57bd1fbbc302))
* **lorekit-setup:** teach the skill programmatic CI state records ([79c0fa0](https://github.com/mthines/lorekit/commit/79c0fa055bdd591b1572b2c6d64ee455e37cf203))

## [1.52.1](https://github.com/mthines/lorekit/compare/cli-v1.52.0...cli-v1.52.1) (2026-08-16)


### Documentation

* document lorekit migrate --to remote ([05786e9](https://github.com/mthines/lorekit/commit/05786e9a0d2baf8dc35b5437acf266de1ca28f3e))
* document lorekit migrate --to remote ([d5b272f](https://github.com/mthines/lorekit/commit/d5b272f861527d2caa844e33658e738b5bfea138))

## [1.52.0](https://github.com/mthines/lorekit/compare/cli-v1.51.0...cli-v1.52.0) (2026-08-16)


### Features

* **cli:** add lorekit migrate --to remote ([#477](https://github.com/mthines/lorekit/issues/477)) ([459fcfe](https://github.com/mthines/lorekit/commit/459fcfe9aa1f044ae3cb579dddd02f18894895f4))

## [1.51.0](https://github.com/mthines/lorekit/compare/cli-v1.50.0...cli-v1.51.0) (2026-08-15)


### Features

* **cli:** give RemoteStore the migrate-destination write interface ([#476](https://github.com/mthines/lorekit/issues/476)) ([fd2e214](https://github.com/mthines/lorekit/commit/fd2e214560457d43ea10fca16a35d33c80032f87))

## [1.50.0](https://github.com/mthines/lorekit/compare/cli-v1.49.0...cli-v1.50.0) (2026-08-15)


### Features

* **cli:** make the SessionStart lesson ceiling configurable ([b98882f](https://github.com/mthines/lorekit/commit/b98882fa699040dd7ade24c2ee59c7be7b8b4695))
* **cli:** make the SessionStart lesson ceiling configurable ([0d54045](https://github.com/mthines/lorekit/commit/0d54045a3c0a220bbed7d4f7bc7cfe463f2a5c68))
* **cli:** optimize the SessionStart defaults for relevance per token ([7327960](https://github.com/mthines/lorekit/commit/73279607091eeaff5b8341171ea043d8b044c83b))


### Bug Fixes

* **cli:** an unusable maxLessons must fall back, not collapse to one line ([7fa6ae7](https://github.com/mthines/lorekit/commit/7fa6ae7b868a994ad3c972de335e7dbc2e19266e))
* **cli:** never request a per-scope limit the route will reject ([23c08a0](https://github.com/mthines/lorekit/commit/23c08a0b08db23ab0d1f72eb51cd1706a8626863))


### Documentation

* **cli:** name the 100/scope route cap in the README config block ([1f66383](https://github.com/mthines/lorekit/commit/1f6638391dfb98ad5a6427d419b09311e3d66bfa))
* **cli:** resolve the comment drift the retuned defaults left behind ([868738a](https://github.com/mthines/lorekit/commit/868738a407319a8c69ca0aa33e8c3ef650edfd98))
* **cli:** three more stale-default references the last sweep missed ([7257797](https://github.com/mthines/lorekit/commit/72577972c5dc1a81f7ef0c3f6c669d813b88408d))
* document hooks.sessionStart.maxLessons on every surface it belongs to ([8b773db](https://github.com/mthines/lorekit/commit/8b773db245057da2577353c9595f40180080525c))

## [1.49.0](https://github.com/mthines/lorekit/compare/cli-v1.48.0...cli-v1.49.0) (2026-08-15)


### Features

* **memories:** order GET /memories/scopes by count, not scope name ([4338387](https://github.com/mthines/lorekit/commit/4338387143f1825495b108ca3d972f95439fe5d6))


### Bug Fixes

* **memories:** propagate the count-desc scope order to the MCP contract + stdio ([aadca03](https://github.com/mthines/lorekit/commit/aadca030554d41fec3dd805fb09004e7c716177f))


### Documentation

* **cli:** correct the listScopes docblock — count-desc, not ascending ([020a197](https://github.com/mthines/lorekit/commit/020a197dff351528d1a587cc28ace789b742095f))

## [1.48.0](https://github.com/mthines/lorekit/compare/cli-v1.47.0...cli-v1.48.0) (2026-08-15)


### Features

* **mcp:** add kind/host filters and a summary view to memory.list ([fb421fa](https://github.com/mthines/lorekit/commit/fb421faa39d1e7bca13ceb1966fccc8dae453d2b))

## [1.47.0](https://github.com/mthines/lorekit/compare/cli-v1.46.0...cli-v1.47.0) (2026-08-15)


### Features

* **explorer:** filtered-stats drill-down — stats follow the full selection + chip scope selector ([#460](https://github.com/mthines/lorekit/issues/460)) ([1621d03](https://github.com/mthines/lorekit/commit/1621d03f93e6ae0c8e1f29ba63842620d0e99c47))

## [1.46.0](https://github.com/mthines/lorekit/compare/cli-v1.45.0...cli-v1.46.0) (2026-08-15)


### Features

* **cli:** make the SessionStart read knobs configurable ([#463](https://github.com/mthines/lorekit/issues/463)) ([129129f](https://github.com/mthines/lorekit/commit/129129f7b231c2c8e523bd66530b6397d081294d))

## [1.45.0](https://github.com/mthines/lorekit/compare/cli-v1.44.0...cli-v1.45.0) (2026-08-15)


### Features

* **cli:** warm the SessionStart read with a branch-name relevance query ([#461](https://github.com/mthines/lorekit/issues/461)) ([437e17b](https://github.com/mthines/lorekit/commit/437e17be1f310815d86b1a7beee9eb0b3fa6c346))

## [1.44.0](https://github.com/mthines/lorekit/compare/cli-v1.43.0...cli-v1.44.0) (2026-08-15)


### Features

* **cli:** cap each self-improvement loop's share of the SessionStart read ([#458](https://github.com/mthines/lorekit/issues/458)) ([b16a104](https://github.com/mthines/lorekit/commit/b16a104b17b6694159c9f7acb7cc4b66ccf2d761))

## [1.43.0](https://github.com/mthines/lorekit/compare/cli-v1.42.0...cli-v1.43.0) (2026-08-15)


### Features

* **cli:** diversify the SessionStart injection with MMR ([#456](https://github.com/mthines/lorekit/issues/456)) ([e81511e](https://github.com/mthines/lorekit/commit/e81511e9c511f09dca4923191e107f04860ea4b9))

## [1.42.0](https://github.com/mthines/lorekit/compare/cli-v1.41.0...cli-v1.42.0) (2026-08-14)


### Features

* **cli:** inject relevant memories on each substantive prompt ([eeb1e4b](https://github.com/mthines/lorekit/commit/eeb1e4be826fa3259fbaa2a8f43c7ff5927abc07))
* MMR read-time diversification of ranked lesson reads ([43faec9](https://github.com/mthines/lorekit/commit/43faec96ca0cd10348f89438ee72d4747dad5a2b))
* MMR read-time diversification of ranked lesson reads ([0539110](https://github.com/mthines/lorekit/commit/05391103ea955cc020275ba2dbd4fd9d9680112d))


### Bug Fixes

* **rank:** cache MMR tokenisation + quantise score to scope-precedence grid ([f2f0b85](https://github.com/mthines/lorekit/commit/f2f0b85be6ee4f054a5bb22120fdc006a23f59e3))
* **rank:** O(n·k) MMR via running maxSim + doc/lambda parity nits ([e655590](https://github.com/mthines/lorekit/commit/e6555907225064af123d7ee89990e8f39aeb6b9f))

## [1.41.0](https://github.com/mthines/lorekit/compare/cli-v1.40.0...cli-v1.41.0) (2026-08-14)


### Features

* **rank:** add outcome factor + cold-start prior to lesson scorer ([d521b9f](https://github.com/mthines/lorekit/commit/d521b9f45f9150ee92feaf120716f31afaf9be3c))
* **rank:** outcome factor + cold-start prior in lesson scorer ([d8711a2](https://github.com/mthines/lorekit/commit/d8711a2ee77f6145653a6e2ee216102a12db4c40))


### Bug Fixes

* **rank:** report outcome factor + hoist the outcome-signal ladder ([f7e9c4e](https://github.com/mthines/lorekit/commit/f7e9c4e2a347b574221f4bfbbfe8819eceee3380))

## [1.40.0](https://github.com/mthines/lorekit/compare/cli-v1.39.2...cli-v1.40.0) (2026-08-13)


### Features

* **cli:** add `dedupe --cluster-by-key` for coordinate-key families ([#446](https://github.com/mthines/lorekit/issues/446)) ([5576f44](https://github.com/mthines/lorekit/commit/5576f44942f03b7839d9733383e811888395bbe9))


### Bug Fixes

* **cli:** review follow-ups for install --mcp-json ([#399](https://github.com/mthines/lorekit/issues/399)) ([#415](https://github.com/mthines/lorekit/issues/415)) ([b19ceb3](https://github.com/mthines/lorekit/commit/b19ceb3d241736b12a4f4846641bf3dbb68c132b))

## [1.39.2](https://github.com/mthines/lorekit/compare/cli-v1.39.1...cli-v1.39.2) (2026-08-10)


### Bug Fixes

* **cli:** let the frozen outcome win over a command's extraAttrs ([6235513](https://github.com/mthines/lorekit/commit/62355135da76bcc218b38678914ee70c05c991e8))
* **cli:** reserve the whole owned attribute namespace from extraAttrs ([c17df73](https://github.com/mthines/lorekit/commit/c17df73dfe425d4e3ff9522c8ce5ded6ab45672d))

## [1.39.1](https://github.com/mthines/lorekit/compare/cli-v1.39.0...cli-v1.39.1) (2026-08-09)


### Documentation

* **cli:** name the no-listScopes note as the second deliberate divergence ([8ddf8a1](https://github.com/mthines/lorekit/commit/8ddf8a130403f67c0394720b2fbd3c2ef0a1b8c8))
* **cli:** restore the verb the shapeScope extraction dropped ([49a6c9a](https://github.com/mthines/lorekit/commit/49a6c9aa76860b4c570b345deb92e3ed0ef32bfd))
* **cli:** stop claiming normalisation is listScopes' whole job here ([c60c3dd](https://github.com/mthines/lorekit/commit/c60c3dddba14b2f5b350d87138e9a02092aebc87))

## [1.39.0](https://github.com/mthines/lorekit/compare/cli-v1.38.0...cli-v1.39.0) (2026-08-09)


### Features

* **web:** replace the archived toggle with a Status control ([875dbc9](https://github.com/mthines/lorekit/commit/875dbc98a1bfd9ffa8ffaa255fe05dc219b9c288))

## [1.38.0](https://github.com/mthines/lorekit/compare/cli-v1.37.0...cli-v1.38.0) (2026-08-09)


### Features

* **cli:** budget the SessionStart block instead of counting it ([901f2f3](https://github.com/mthines/lorekit/commit/901f2f33ab95602386e48f46b86cc2cf6c64adba))
* **cli:** budget the SessionStart block instead of counting it ([c953d5c](https://github.com/mthines/lorekit/commit/c953d5cbe4300d9af6f1d24f5e4d20399727fb5a))


### Bug Fixes

* **stack:** land PRs 407, 409, 411, 414 and 421 on main ([7bae960](https://github.com/mthines/lorekit/commit/7bae960b26b2241d3dd314d78f77987b2fc6ae3f))


### Documentation

* **cli:** make the docblock header sample reachable too ([acf734e](https://github.com/mthines/lorekit/commit/acf734e2611ef1d22de897dbe7d195c613752c14))
* **config:** correct the hooks.sessionStart fall-through claim ([b32d06a](https://github.com/mthines/lorekit/commit/b32d06acd08e3c45f25045a1c7536725609e37ac))
* retire the MAX_LESSONS cap from the prose that still described it ([15cf352](https://github.com/mthines/lorekit/commit/15cf352831d66c2a39129baa68cce9394ef42e66))

## [1.37.0](https://github.com/mthines/lorekit/compare/cli-v1.36.0...cli-v1.37.0) (2026-08-09)


### Features

* **mcp:** add memory.scopes, the store-wide scope inventory ([5f285b3](https://github.com/mthines/lorekit/commit/5f285b361383832862168c59a09d8e3dd3e74fc7))
* **mcp:** add memory.scopes, the store-wide scope inventory ([b2dce79](https://github.com/mthines/lorekit/commit/b2dce798efd644a24720172c69916786d716d047))


### Bug Fixes

* **cli:** carry httpStatus through RemoteStore.listScopes so the HTTP branch fires ([6aeaafd](https://github.com/mthines/lorekit/commit/6aeaafda299f382a5edb11731384a095fc801f48))
* **cli:** sort memory.scopes by scope ascending on the stdio server ([321b4a1](https://github.com/mthines/lorekit/commit/321b4a102bc727dcc39ef9e669a5e46cdd33fe7e))


### Documentation

* **cli:** state the collation divergence in the memory.scopes sort ([5eb7f62](https://github.com/mthines/lorekit/commit/5eb7f6229c5595c7008433c53c51a06b1328131d))

## [1.36.0](https://github.com/mthines/lorekit/compare/cli-v1.35.0...cli-v1.36.0) (2026-08-08)


### Features

* **cli:** add install --mcp-json for Claude Code on the web ([ffee10c](https://github.com/mthines/lorekit/commit/ffee10ce7121f8f03ef634c088f48fb34092ec91))

## [1.35.0](https://github.com/mthines/lorekit/compare/cli-v1.34.0...cli-v1.35.0) (2026-08-08)


### Features

* **cli,mcp:** scale-aware survey and grooming for large LoreKit scopes ([eb66238](https://github.com/mthines/lorekit/commit/eb66238ced671132139406ed7831a6701435892e))


### Bug Fixes

* **ci:** align dedupe/list tests with the new threshold floor and normalizeEntry field ([d69c87d](https://github.com/mthines/lorekit/commit/d69c87db7dc0b09d8152db91db094c42bb693ba6))
* **cli,mcp:** make dedupe/list --key-prefix a real server-side prefix filter ([218344e](https://github.com/mthines/lorekit/commit/218344e6489ecae7047cd98cbac22c7bad25ff90))

## [1.34.0](https://github.com/mthines/lorekit/compare/cli-v1.33.4...cli-v1.34.0) (2026-08-06)


### Features

* **cli:** add a volatile-key lint rule so per-sighting keys fail CI ([939015c](https://github.com/mthines/lorekit/commit/939015cd7501550d8ae9fb447b9ef8417dfdb79c))


### Bug Fixes

* **cli:** match pr/issue references joined by - or _ in volatile-key ([bdb1abb](https://github.com/mthines/lorekit/commit/bdb1abb740d2f8b7df5b448bb0ebc30dfe60fc91))


### Documentation

* **cli:** list volatile-key in every lint rule enumeration ([46c961f](https://github.com/mthines/lorekit/commit/46c961faf63000f45b007c6ae556c2e9e444261d))

## [1.33.4](https://github.com/mthines/lorekit/compare/cli-v1.33.3...cli-v1.33.4) (2026-08-06)


### Bug Fixes

* **cli:** parse scope::key by scope validity in write and show ([4855df8](https://github.com/mthines/lorekit/commit/4855df8f8f00405bf16f116563c028f1d6fe2a2e))
* **cli:** parse scope::key by scope validity in write and show ([fafea77](https://github.com/mthines/lorekit/commit/fafea7779c2279dd88e288337fffe608fe910be7))
* **cli:** reject leftover positionals in write instead of writing the wrong key ([0c1bc75](https://github.com/mthines/lorekit/commit/0c1bc75aeb773c1039dfc5922040b6f8b7bf35f4))


### Documentation

* **cli:** document link's --key flag in its own help and CLAUDE.md ([dc0f437](https://github.com/mthines/lorekit/commit/dc0f437e74f74b221a3c9d615620aa36421df488))
* **cli:** stop overstating the CLI scope gate in write's docblock ([a0e7d37](https://github.com/mthines/lorekit/commit/a0e7d378ab53b4f62800be2215dd127833a201ff))

## [1.33.3](https://github.com/mthines/lorekit/compare/cli-v1.33.2...cli-v1.33.3) (2026-08-05)


### Documentation

* docs/otel.md + docs/deployment.md. ([7c259c9](https://github.com/mthines/lorekit/commit/7c259c9937a6a20bda0d44668b807de161d4187a))

## [1.33.2](https://github.com/mthines/lorekit/compare/cli-v1.33.1...cli-v1.33.2) (2026-08-05)


### Bug Fixes

* **cli:** flush stdout before exit so a large mcp frame is not truncated ([37ba771](https://github.com/mthines/lorekit/commit/37ba7710a0a30ea6b79ebad9f9bcca11ba818186))
* **cli:** flush stdout before exit so a large mcp frame is not truncated ([8399eb9](https://github.com/mthines/lorekit/commit/8399eb94df086be3ef61ad6949e30da4eeae49b0))

## [1.33.1](https://github.com/mthines/lorekit/compare/cli-v1.33.0...cli-v1.33.1) (2026-08-05)


### Bug Fixes

* **cli:** dedupeRelevant honours a cap of 0 ([74f2e1d](https://github.com/mthines/lorekit/commit/74f2e1d0384adce5267819bec09efc9c279d4a38))


### Performance

* **cli:** one-pass multi-term store search for the failure lookup ([b781be8](https://github.com/mthines/lorekit/commit/b781be8679b2d89254ac49f76ab1c4c677bc938b))


### Documentation

* **cli:** remote store orders by recency, not FTS relevance ([b7f7df7](https://github.com/mthines/lorekit/commit/b7f7df7740b0f0cd06418af28036e873397a7e56))
* **cli:** scope precedence in the failure lookup holds per tier only ([146bde9](https://github.com/mthines/lorekit/commit/146bde9da1deb09e6112d9f82d97448dafea897e))

## [1.33.0](https://github.com/mthines/lorekit/compare/cli-v1.32.1...cli-v1.33.0) (2026-08-05)


### Features

* **cli:** failure hook queries the store for relevant lessons ([#378](https://github.com/mthines/lorekit/issues/378)) ([e9bc851](https://github.com/mthines/lorekit/commit/e9bc8519520d50bf43b527cdad30684b6d24b04a))

## [1.32.1](https://github.com/mthines/lorekit/compare/cli-v1.32.0...cli-v1.32.1) (2026-08-04)


### Documentation

* **lorekit-setup:** add the reconcile-on-re-run flow (resolve + record) ([04c905b](https://github.com/mthines/lorekit/commit/04c905b239dc92c5025531739c9947f7e6c998d4))

## [1.32.0](https://github.com/mthines/lorekit/compare/cli-v1.31.0...cli-v1.32.0) (2026-08-04)


### Features

* **memory:** add kind + host as first-class taxonomy properties ([a62a63a](https://github.com/mthines/lorekit/commit/a62a63aa5c99b6e0d29d8b4929c85d87cc4dd679))
* **memory:** add kind + host as first-class taxonomy properties ([fa5b1cf](https://github.com/mthines/lorekit/commit/fa5b1cfc3a44522bb798fd8e40ff99b72a27d9f1))


### Bug Fixes

* **memory:** address pr-reviewer findings on the kind/host PR ([ea4391e](https://github.com/mthines/lorekit/commit/ea4391e96e8235ca0f11597e18e935e405f180b3))

## [1.31.0](https://github.com/mthines/lorekit/compare/cli-v1.30.3...cli-v1.31.0) (2026-08-03)


### Features

* **cli:** add lorekit-groom skill for memory-store grooming ([52f5d56](https://github.com/mthines/lorekit/commit/52f5d5670dd9c5efe4ae5e3396e5e0678003d294))
* **cli:** add lorekit-groom skill for memory-store grooming ([f281c34](https://github.com/mthines/lorekit/commit/f281c34cb0fdad28806b9da1fece0aad8d6fb39b))


### Documentation

* **groom:** drop the unsupported freshness claim from the scopes row ([51ca263](https://github.com/mthines/lorekit/commit/51ca263648d4733c005c71c2c697db698d62aeda))
* **groom:** drop unsupported `lorekit scopes` last-activity claim ([c69f667](https://github.com/mthines/lorekit/commit/c69f66762343b0e154123034bf6bfc915732ee0e))
* **groom:** use bare `lorekit tree` for the precedence check ([07c1327](https://github.com/mthines/lorekit/commit/07c13270606ebaf19c898b3605b009a92af7e56e))

## [1.30.3](https://github.com/mthines/lorekit/compare/cli-v1.30.2...cli-v1.30.3) (2026-08-03)


### Bug Fixes

* **usage:** stop the dashboard's own reads inflating "Memories read" ([4d65bbb](https://github.com/mthines/lorekit/commit/4d65bbb705fce9289fbc716f574115aa138ea331))

## [1.30.2](https://github.com/mthines/lorekit/compare/cli-v1.30.1...cli-v1.30.2) (2026-08-03)


### Bug Fixes

* **cli:** collapse duplicate lorekit hook entries on install ([8a11000](https://github.com/mthines/lorekit/commit/8a110005eaa1da189a0983064390026a44c6433e))
* **cli:** register the Explorer's `filters` param in the deep-link builder ([d1c029a](https://github.com/mthines/lorekit/commit/d1c029a56ea7dda83a1a9ca662cd4c4318a6122e))

## [1.30.1](https://github.com/mthines/lorekit/compare/cli-v1.30.0...cli-v1.30.1) (2026-08-03)


### Bug Fixes

* **cli:** only mark a span as error when the command crashes ([82b909e](https://github.com/mthines/lorekit/commit/82b909e150f2494ed76d90614726cbb6a02bf1cd))
* **cli:** only mark a span as error when the command crashes ([d66f2a4](https://github.com/mthines/lorekit/commit/d66f2a4899a98492cd005b4dbf03763bb0954070))
* **cli:** register the Explorer filters param in the deep-link builder ([2a63797](https://github.com/mthines/lorekit/commit/2a63797ddf42c14b8cefbd63ec5651ca916a630c))


### Documentation

* **cli:** name STATUS_CODE_OK instead of claiming the span status is unset ([0cb37cc](https://github.com/mthines/lorekit/commit/0cb37ccb510994bb6364037d3b45e17bf3a0220e))

## [1.30.0](https://github.com/mthines/lorekit/compare/cli-v1.29.3...cli-v1.30.0) (2026-08-03)


### Features

* **cli:** gate the OTLP export with `doctor --telemetry` ([7e8eea3](https://github.com/mthines/lorekit/commit/7e8eea335d629861be842ac887f0163cbd9e9eb1))

## [1.29.3](https://github.com/mthines/lorekit/compare/cli-v1.29.2...cli-v1.29.3) (2026-08-03)


### Performance

* **cli:** short-circuit the Stop friction read once the retro has fired ([52633b7](https://github.com/mthines/lorekit/commit/52633b7881ef9f16cef04939922d60c6552b91b6))

## [1.29.2](https://github.com/mthines/lorekit/compare/cli-v1.29.1...cli-v1.29.2) (2026-08-02)


### Bug Fixes

* address [#337](https://github.com/mthines/lorekit/issues/337) review — restore llms docs, dead doctor branch, CORS Vary ([2ea06e6](https://github.com/mthines/lorekit/commit/2ea06e6025bc26412b415001d0583995a02a33f5))
* **cli:** drop the dead tool-count branch in doctor connectivity ([2b4fd31](https://github.com/mthines/lorekit/commit/2b4fd318407abd3d0a84d0624c8b57894bb35bcc))

## [1.29.1](https://github.com/mthines/lorekit/compare/cli-v1.29.0...cli-v1.29.1) (2026-08-02)


### Bug Fixes

* **cli:** a 429 on the verifyAuth probe cannot vouch for the token ([f155c8e](https://github.com/mthines/lorekit/commit/f155c8e5c13327a10dfbb64f05d9dc730c972f3c))
* **cli:** verify the token in doctor and offer to replace it on install --force ([0f15def](https://github.com/mthines/lorekit/commit/0f15defd785d2fb3a14b346b4529d222baf0ad1a))

## [1.29.0](https://github.com/mthines/lorekit/compare/cli-v1.28.0...cli-v1.29.0) (2026-08-02)


### Features

* **cli:** make hook wiring an explicit choice during install ([8af37d9](https://github.com/mthines/lorekit/commit/8af37d9115a7a65d479108fad388786dcc778020))


### Bug Fixes

* **cli:** keep a hand-wired hook set on a non-interactive install ([2c0747f](https://github.com/mthines/lorekit/commit/2c0747fffbbb75c1833cac2ed33323267bad91b9))
* **cli:** refresh a stale hook command when preserving a custom set ([e3d238d](https://github.com/mthines/lorekit/commit/e3d238d16e1c48a6d53236e233b17c3628247a9a))
* **cli:** reject a valueless --hooks instead of falling back silently ([2965e1d](https://github.com/mthines/lorekit/commit/2965e1d93aed126032f5124df994e76bd3ee030b))
* **cli:** report the TTL that landed, not the flag, when --clear-ttl wins ([7590b87](https://github.com/mthines/lorekit/commit/7590b872fb2d486e488ea34840745df9e1b033e6))


### Documentation

* **cli:** align the preserved hook-set copy with the refresh behaviour ([9aac586](https://github.com/mthines/lorekit/commit/9aac58615f561fd61044fbad9df619afcb31611a))
* **cli:** correct the --yes / non-TTY hook default in the three doc surfaces ([45bf80d](https://github.com/mthines/lorekit/commit/45bf80d1934e1a600e6b86e83f8a72442633f4b8))

## [1.28.0](https://github.com/mthines/lorekit/compare/cli-v1.27.0...cli-v1.28.0) (2026-08-02)


### Features

* **cli:** deep-links docs page + `tags` param + web↔CLI drift guard ([#321](https://github.com/mthines/lorekit/issues/321)) ([7b80f90](https://github.com/mthines/lorekit/commit/7b80f904f753f6078bde4d60c38d138812de8b11))

## [1.27.0](https://github.com/mthines/lorekit/compare/cli-v1.26.1...cli-v1.27.0) (2026-08-02)


### Features

* **cli:** friction-gate the Stop retrospective nudge (hooks.stop) ([#315](https://github.com/mthines/lorekit/issues/315)) ([f2d7ebf](https://github.com/mthines/lorekit/commit/f2d7ebf4f7d1649f3297b21a1f272fc14d6f4e76))

## [1.26.1](https://github.com/mthines/lorekit/compare/cli-v1.26.0...cli-v1.26.1) (2026-08-01)


### Bug Fixes

* **cli:** honor TTL/expiry in the local file store (format parity) ([#308](https://github.com/mthines/lorekit/issues/308)) ([13ae559](https://github.com/mthines/lorekit/commit/13ae559d45360449d24c37c2da4e3515989dbf50))

## [1.26.0](https://github.com/mthines/lorekit/compare/cli-v1.25.1...cli-v1.26.0) (2026-08-01)


### Features

* **memory:** record and surface where a memory came from ([#299](https://github.com/mthines/lorekit/issues/299)) ([dab4ca8](https://github.com/mthines/lorekit/commit/dab4ca8f48a3b75845a7a0aba9bb4af0c913d2c6))

## [1.25.1](https://github.com/mthines/lorekit/compare/cli-v1.25.0...cli-v1.25.1) (2026-08-01)


### Bug Fixes

* **smoke:** clean up the data live smoke tests write to real projects ([#297](https://github.com/mthines/lorekit/issues/297)) ([ab5ad0f](https://github.com/mthines/lorekit/commit/ab5ad0f058f499808e73a6de2f9327ae193c9662))

## [1.25.0](https://github.com/mthines/lorekit/compare/cli-v1.24.1...cli-v1.25.0) (2026-07-31)


### Features

* **usage:** usage-statistics API (GET /memories/usage) with record, correlation, and expiry counts ([#289](https://github.com/mthines/lorekit/issues/289)) ([24a8e21](https://github.com/mthines/lorekit/commit/24a8e214a402aed73cc6972b60af8706c0848cf4))

## [1.24.1](https://github.com/mthines/lorekit/compare/cli-v1.24.0...cli-v1.24.1) (2026-07-31)


### Bug Fixes

* **cli:** rename OTel instrumentation scope to cli ([#290](https://github.com/mthines/lorekit/issues/290)) ([f9efb7d](https://github.com/mthines/lorekit/commit/f9efb7de9004d73afa5de2abf825cf770a7ca3e1))

## [1.24.0](https://github.com/mthines/lorekit/compare/cli-v1.23.0...cli-v1.24.0) (2026-07-31)


### Features

* **otel:** CLI service.name "cli" and default dataset "default" ([#271](https://github.com/mthines/lorekit/issues/271)) ([56e0742](https://github.com/mthines/lorekit/commit/56e0742d451fb550c0b8f3227244ed6795c6fceb))

## [1.23.0](https://github.com/mthines/lorekit/compare/cli-v1.22.0...cli-v1.23.0) (2026-07-31)


### Features

* **rest:** org endpoints for API tokens, CLI fully on REST, and MCP traceparent (rollup of [#261](https://github.com/mthines/lorekit/issues/261) + [#232](https://github.com/mthines/lorekit/issues/232)) ([#266](https://github.com/mthines/lorekit/issues/266)) ([60cff35](https://github.com/mthines/lorekit/commit/60cff35d4569c604b850b915af2c08d6f716c376))

## [1.22.0](https://github.com/mthines/lorekit/compare/cli-v1.21.0...cli-v1.22.0) (2026-07-31)


### Features

* REST API completion and end-to-end trace correlation (rollup of [#242](https://github.com/mthines/lorekit/issues/242)–[#249](https://github.com/mthines/lorekit/issues/249)) ([#260](https://github.com/mthines/lorekit/issues/260)) ([24a265c](https://github.com/mthines/lorekit/commit/24a265cb67bd0fde42c2c941b525eaf7d2e5eaf1))

## [1.21.0](https://github.com/mthines/lorekit/compare/cli-v1.20.1...cli-v1.21.0) (2026-07-30)


### Features

* **cli:** switch memory ops to REST API with traceparent propagation ([#233](https://github.com/mthines/lorekit/issues/233)) ([665660d](https://github.com/mthines/lorekit/commit/665660d49b0fdb468bed976a2720a46038534f18))

## [1.20.1](https://github.com/mthines/lorekit/compare/cli-v1.20.0...cli-v1.20.1) (2026-07-30)


### Bug Fixes

* **github-app:** document setup_action requirement in auth callback ([e6b4ec4](https://github.com/mthines/lorekit/commit/e6b4ec45eed8073018a75d6e8b143799bfe3aaf0))
* **github-app:** drop dead lorekit_is_app_covered from migration ([437d63b](https://github.com/mthines/lorekit/commit/437d63badfc3d30762239f6ef3000e6c9930e377))
* **github-app:** use direct identities lookup in handleSetupReturn ([089d038](https://github.com/mthines/lorekit/commit/089d038641226127fc16775e925b0b70b489ae1f))
* **security:** add safeNextPath open-redirect fix to GitHub App callback route ([c5c3bbb](https://github.com/mthines/lorekit/commit/c5c3bbb8dfc8e2fbc52090aaabbc10853d149dfa))
* update middleware.ts from main (PR [#225](https://github.com/mthines/lorekit/issues/225) open-redirect fix) ([95d95f2](https://github.com/mthines/lorekit/commit/95d95f2eaf44239128f98873cfda67966807a269))
* update write.ts from main (PR [#225](https://github.com/mthines/lorekit/issues/225)) ([1342a28](https://github.com/mthines/lorekit/commit/1342a28b7cbda4c6ee809b80d7aa394fc595de91))

## [1.20.0](https://github.com/mthines/lorekit/compare/cli-v1.19.0...cli-v1.20.0) (2026-07-29)


### Features

* **byod:** Bring Your Own Database support ([#208](https://github.com/mthines/lorekit/issues/208)) ([69cbf07](https://github.com/mthines/lorekit/commit/69cbf07130e689d9d2389f87d5c3c5fb262d9e23))

## [1.19.0](https://github.com/mthines/lorekit/compare/cli-v1.18.0...cli-v1.19.0) (2026-07-29)


### Features

* **cli:** add write command and scope::key shorthand for show ([#215](https://github.com/mthines/lorekit/issues/215)) ([9276ab2](https://github.com/mthines/lorekit/commit/9276ab2284d03f2f4083293e5b9eafba25562997))

## [1.18.0](https://github.com/mthines/lorekit/compare/cli-v1.17.1...cli-v1.18.0) (2026-07-29)


### Features

* **cli:** confirm memory writes with deep link + add lore URL to Stop nudge ([#203](https://github.com/mthines/lorekit/issues/203)) ([efa1d7b](https://github.com/mthines/lorekit/commit/efa1d7b8e25eecba0305ab360a0d0945bf3c7a2c))

## [1.17.1](https://github.com/mthines/lorekit/compare/cli-v1.17.0...cli-v1.17.1) (2026-07-28)


### Bug Fixes

* **cli:** send telemetry to default dataset instead of lorekit-cli ([#195](https://github.com/mthines/lorekit/issues/195)) ([83a71c4](https://github.com/mthines/lorekit/commit/83a71c4f5127cef0ade5df76d3aa1489c33bfa56))

## [1.17.0](https://github.com/mthines/lorekit/compare/cli-v1.16.0...cli-v1.17.0) (2026-07-28)


### Features

* **cli:** improve install UX — graceful re-install, token reuse, remove endpoint prompt ([#192](https://github.com/mthines/lorekit/issues/192)) ([443afc4](https://github.com/mthines/lorekit/commit/443afc4bdc504b76b7b95f55cd646f0c895f3a2a))

## [1.16.0](https://github.com/mthines/lorekit/compare/cli-v1.15.0...cli-v1.16.0) (2026-07-28)


### Features

* **cli:** add hooks.instructions config for user-customizable hook output ([#188](https://github.com/mthines/lorekit/issues/188)) ([df59900](https://github.com/mthines/lorekit/commit/df59900f717e3d77a1bcd69747108b16ae25268b))

## [1.15.0](https://github.com/mthines/lorekit/compare/cli-v1.14.0...cli-v1.15.0) (2026-07-28)


### Features

* **cli:** add 7 new .lorekit.json config properties ([#167](https://github.com/mthines/lorekit/issues/167)) ([13905c9](https://github.com/mthines/lorekit/commit/13905c910db1c136979a38d372056b62ed9c1307))


### Bug Fixes

* **web,cli:** unify "memory" terminology and polish Explorer filters/heatmap ([#168](https://github.com/mthines/lorekit/issues/168)) ([ce0cb00](https://github.com/mthines/lorekit/commit/ce0cb001d78505be0a6eab8a8769d461b418bd66))


### Documentation

* fix drift in otel.md CLI command list, install.md Step 9, and CLAUDE.md key files ([#165](https://github.com/mthines/lorekit/issues/165)) ([6e83aaf](https://github.com/mthines/lorekit/commit/6e83aaf1ee7ca5c354ced0b54f8b0861ac9dcb08))

## [1.14.0](https://github.com/mthines/lorekit/compare/cli-v1.13.1...cli-v1.14.0) (2026-07-27)


### Features

* **cli:** add `scopes` store-wide scope inventory command ([#159](https://github.com/mthines/lorekit/issues/159)) ([4221a7f](https://github.com/mthines/lorekit/commit/4221a7ff2b3df1cf58065a5ed13a97eb99553f6d))

## [1.13.1](https://github.com/mthines/lorekit/compare/cli-v1.13.0...cli-v1.13.1) (2026-07-27)


### Bug Fixes

* **cli:** mcp readiness banner + correct tree scope help ([#157](https://github.com/mthines/lorekit/issues/157)) ([57128be](https://github.com/mthines/lorekit/commit/57128beb55756e4917122ac9e9f0091e7e80a4bf))

## [1.13.0](https://github.com/mthines/lorekit/compare/cli-v1.12.0...cli-v1.13.0) (2026-07-27)


### Features

* add lorekit-setup skill (self-improvement-loop authoring) + multi-skill CLI ([#137](https://github.com/mthines/lorekit/issues/137)) ([24d8906](https://github.com/mthines/lorekit/commit/24d8906aa4434e12ae5b69566871ffdf9c4a6123))


### Bug Fixes

* **cli:** de-binary two source files (raw NUL → `\x00` escape) + regression guard ([#147](https://github.com/mthines/lorekit/issues/147)) ([9406e2c](https://github.com/mthines/lorekit/commit/9406e2c4f33d357bd9c887d10a1bdfc6e414cf00))

## [1.12.0](https://github.com/mthines/lorekit/compare/cli-v1.11.0...cli-v1.12.0) (2026-07-27)


### Features

* **cli:** smart hooks — failure-relevant lesson injection + unified scope precedence ([#145](https://github.com/mthines/lorekit/issues/145)) ([bf22e4e](https://github.com/mthines/lorekit/commit/bf22e4e3cbbfc30a0f6e4e2dd05221f3fdda0a15))

## [1.11.0](https://github.com/mthines/lorekit/compare/cli-v1.10.0...cli-v1.11.0) (2026-07-27)


### Features

* **cli:** add read-only `tree`, `lint`, and `dedupe` commands ([#143](https://github.com/mthines/lorekit/issues/143)) ([36b8086](https://github.com/mthines/lorekit/commit/36b808615cf6863661113bb614f564e193423492))

## [1.10.0](https://github.com/mthines/lorekit/compare/cli-v1.9.0...cli-v1.10.0) (2026-07-27)


### Features

* **cli:** add read-only `stats` and `diff` commands ([#141](https://github.com/mthines/lorekit/issues/141)) ([1aa4995](https://github.com/mthines/lorekit/commit/1aa4995401be06896f3664e7b3f5052ce9f7dc55))

## [1.9.0](https://github.com/mthines/lorekit/compare/cli-v1.8.0...cli-v1.9.0) (2026-07-27)


### Features

* **cli:** add read-only `search` and `show` commands ([#138](https://github.com/mthines/lorekit/issues/138)) ([18aec96](https://github.com/mthines/lorekit/commit/18aec96108a66684130e55815a726fd4d08463f7))

## [1.8.0](https://github.com/mthines/lorekit/compare/cli-v1.7.1...cli-v1.8.0) (2026-07-27)


### Features

* **cli:** add `list` command surfacing scoped lessons across offline + remote stores ([#132](https://github.com/mthines/lorekit/issues/132)) ([297b3e1](https://github.com/mthines/lorekit/commit/297b3e1b01825941ee4d5a6d58823df9d47fdbc2))

## [1.7.1](https://github.com/mthines/lorekit/compare/cli-v1.7.0...cli-v1.7.1) (2026-07-26)


### Bug Fixes

* **cli:** normalize object exit code on telemetry fast-path (fixes doctor crash) ([#127](https://github.com/mthines/lorekit/issues/127)) ([7ac48f5](https://github.com/mthines/lorekit/commit/7ac48f57d5f0c1475e355b898ba0c2d2b3992c22))

## [1.7.0](https://github.com/mthines/lorekit/compare/cli-v1.6.0...cli-v1.7.0) (2026-07-26)


### Features

* **cli:** surface failed check names in doctor telemetry span ([#122](https://github.com/mthines/lorekit/issues/122)) ([a99658d](https://github.com/mthines/lorekit/commit/a99658d7ce1471e3fd45c164c6007cf195717a23))

## [1.6.0](https://github.com/mthines/lorekit/compare/cli-v1.5.0...cli-v1.6.0) (2026-07-26)


### Features

* **mcp:** add org.create, org.list, org.rename, org.delete tools ([#116](https://github.com/mthines/lorekit/issues/116)) ([d5ccfa4](https://github.com/mthines/lorekit/commit/d5ccfa42c8bfd0f658118e26bbf6d9d081630d5b))

## [1.5.0](https://github.com/mthines/lorekit/compare/cli-v1.4.1...cli-v1.5.0) (2026-07-26)


### Features

* **cli:** add .env.example for telemetry token configuration ([2a75f16](https://github.com/mthines/lorekit/commit/2a75f16552b40a62996adb73693f19a35ae67980))
* **cli:** implement zero-dependency .env loader and add tests ([abb9bca](https://github.com/mthines/lorekit/commit/abb9bcae32a4578b18a5e4e629fc16009b66f66d))


### Bug Fixes

* **cli:** update telemetry endpoint to new GCP location and add default dataset to .env.example ([c8151ba](https://github.com/mthines/lorekit/commit/c8151ba412155ea432428df6d742608b7ee4d142))

## [1.4.1](https://github.com/mthines/lorekit/compare/cli-v1.4.0...cli-v1.4.1) (2026-07-26)


### Documentation

* optimize root and CLI READMEs for above-the-fold clarity ([#111](https://github.com/mthines/lorekit/issues/111)) ([62aecf2](https://github.com/mthines/lorekit/commit/62aecf2486b979d4128db183ca5b03d64314b762))

## [1.4.0](https://github.com/mthines/lorekit/compare/cli-v1.3.0...cli-v1.4.0) (2026-07-26)


### Features

* **cli:** reject unknown flags and add per-command help ([#101](https://github.com/mthines/lorekit/issues/101)) ([ddb84d9](https://github.com/mthines/lorekit/commit/ddb84d9977dc08254b89399c8b5bbd4088ac2f9a))

## [1.3.0](https://github.com/mthines/lorekit/compare/cli-v1.2.0...cli-v1.3.0) (2026-07-26)


### Features

* **cli:** add OpenTelemetry usage instrumentation ([#98](https://github.com/mthines/lorekit/issues/98)) ([e331988](https://github.com/mthines/lorekit/commit/e3319889d7f910049fb6a40d5440cbe40eceab27))

## [1.2.0](https://github.com/mthines/lorekit/compare/cli-v1.1.0...cli-v1.2.0) (2026-07-26)


### Features

* **cli:** add uninstall command with atomic, fail-safe config writes ([#96](https://github.com/mthines/lorekit/issues/96)) ([fa33f91](https://github.com/mthines/lorekit/commit/fa33f9104cdf7d835368c3a918a655d055be2fa9))
* **cli:** interactive arrow-key picker for install scope ([#97](https://github.com/mthines/lorekit/issues/97)) ([877e77a](https://github.com/mthines/lorekit/commit/877e77a34caa01147f091a44f68d2d1939b5a7c2))


### Bug Fixes

* **cli:** add repository.url so npm provenance verification passes ([#93](https://github.com/mthines/lorekit/issues/93)) ([d7de196](https://github.com/mthines/lorekit/commit/d7de19679d5b344bb9b23b1ebd14ed495af53228))

## [1.1.0](https://github.com/mthines/lorekit/compare/cli-v1.0.1...cli-v1.1.0) (2026-07-26)


### Features

* **auth:** add write-only API token tier (lk_wo_*) ([#72](https://github.com/mthines/lorekit/issues/72)) ([ee52808](https://github.com/mthines/lorekit/commit/ee52808952005574916288824671688b2911ebdb))
* **cli:** install the deterministic hooks, not just the skill ([#66](https://github.com/mthines/lorekit/issues/66)) ([d085b78](https://github.com/mthines/lorekit/commit/d085b78f4d4213254ccc8b63beaea94f20afcf2f))
* **cli:** let install choose project or global scope ([#63](https://github.com/mthines/lorekit/issues/63)) ([6daf357](https://github.com/mthines/lorekit/commit/6daf3579365b626a7b2f038b6e072a23887208cd))
* **memory:** accept optional created_at on memory.write for migration ([#69](https://github.com/mthines/lorekit/issues/69)) ([e6361f7](https://github.com/mthines/lorekit/commit/e6361f7b1f6d1448fcf31eb5077f0a1fbe4996d2))


### Bug Fixes

* **cli:** doctor finds global-installed skill + release smoke gates for LoreKit ([#79](https://github.com/mthines/lorekit/issues/79)) ([da00458](https://github.com/mthines/lorekit/commit/da0045896fd715b809766252da407a7f86439bd1))
