# Changelog

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
