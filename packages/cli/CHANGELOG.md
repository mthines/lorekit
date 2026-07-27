# Changelog

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
