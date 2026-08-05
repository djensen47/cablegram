# Changelog

## 1.0.0 (2026-08-05)


### Features

* **auth:** JWT user accounts + auth; remove the static API key ([#18](https://github.com/djensen47/cablegram/issues/18)) ([212b46a](https://github.com/djensen47/cablegram/commit/212b46a41adf2a203f0287259dee69251bb9aa96))
* **auth:** password reset, magic-link login, login timing fix ([#20](https://github.com/djensen47/cablegram/issues/20)) ([761061e](https://github.com/djensen47/cablegram/commit/761061e258625f7a295410530b3daa23a280200f))
* automate releases with release-please and npm trusted publishing (ADR-026) ([#42](https://github.com/djensen47/cablegram/issues/42)) ([8b3bec5](https://github.com/djensen47/cablegram/commit/8b3bec5614d595387430741f3f8fcb3e564ea405))
* campaign test send — a proof that is the same send (ADR-025, [#36](https://github.com/djensen47/cablegram/issues/36)) ([#37](https://github.com/djensen47/cablegram/issues/37)) ([205f89e](https://github.com/djensen47/cablegram/commit/205f89e00da86d9eb20091784018242008fb90ff))
* **campaigns:** record unrecognized Postmark webhook events (ADR-021, [#29](https://github.com/djensen47/cablegram/issues/29)) ([#31](https://github.com/djensen47/cablegram/issues/31)) ([83e5316](https://github.com/djensen47/cablegram/commit/83e53168e10bbb392201b2741988b952dad55b11))
* **campaigns:** send pipeline, Postmark webhook receiver, send record — the integrator ([#8](https://github.com/djensen47/cablegram/issues/8)) ([e7956a1](https://github.com/djensen47/cablegram/commit/e7956a1bb0f9b573d36ad6785e4eaf5e8108e91d))
* **cli:** first-party `cablegram` CLI as an HTTP client of /v1 (ADR-016) ([#22](https://github.com/djensen47/cablegram/issues/22)) ([e316e38](https://github.com/djensen47/cablegram/commit/e316e38758ba5efabacd6aa77e46a47d7af68a0c))
* **deliverability:** count soft-bounce streaks instead of discarding them (ADR-020) ([#26](https://github.com/djensen47/cablegram/issues/26)) ([d051827](https://github.com/djensen47/cablegram/commit/d051827515aed2d480266f079a0c506bd353e5f3))
* **deliverability:** global suppression list + shared email-address normalizer ([#5](https://github.com/djensen47/cablegram/issues/5)) ([614de74](https://github.com/djensen47/cablegram/commit/614de74fcf0ba877094249d40014fd12eb2d34ec))
* Docker deployment + CI, DO Functions best-effort config ([#9](https://github.com/djensen47/cablegram/issues/9)) ([ec4d5c5](https://github.com/djensen47/cablegram/commit/ec4d5c58c32bf09816f3d52ce4cc144f24b464f2))
* **email:** Postmark anti-corruption layer (shared module) ([#4](https://github.com/djensen47/cablegram/issues/4)) ([5186eda](https://github.com/djensen47/cablegram/commit/5186eda1a3d6da4eb644d1948089a583a035d922))
* hardening — scheduled campaigns, Mongo contract tests, structured logging, Idempotency-Key ([#10](https://github.com/djensen47/cablegram/issues/10)) ([0486b4c](https://github.com/djensen47/cablegram/commit/0486b4c9b4743d5737ad18ead8711b537202a45a))
* **newsletters:** reference vertical + complete boundary lint + OpenAPI ([#3](https://github.com/djensen47/cablegram/issues/3)) ([b3f6531](https://github.com/djensen47/cablegram/commit/b3f653151cecc95489ef2a6a145c27de740f31b7))
* **pkg:** make cablegram installable from npm (MIT, v1.0.0, exports ./function) ([#41](https://github.com/djensen47/cablegram/issues/41)) ([89966d5](https://github.com/djensen47/cablegram/commit/89966d57f332ccca9f253e77bd7763bfdce4302b))
* project foundation — tooling, shared kernel, Hono app ([d02e15c](https://github.com/djensen47/cablegram/commit/d02e15cfdd71ebe5b75f08850bbc42d4e68d7d22))
* subscriber import that preserves existing status (ADR-022, [#30](https://github.com/djensen47/cablegram/issues/30)) ([#33](https://github.com/djensen47/cablegram/issues/33)) ([77bbbfb](https://github.com/djensen47/cablegram/commit/77bbbfbb87c2ae72ee62df14a24bad3aec80684c))
* **subscriptions:** flat per-newsletter membership with DOI + recipient resolution ([#7](https://github.com/djensen47/cablegram/issues/7)) ([b0d904e](https://github.com/djensen47/cablegram/commit/b0d904e2b7ad59301c5bdc4276b361151379fbcb))
* **subscriptions:** per-newsletter suppression scope; complaints stop going global (ADR-018) ([#25](https://github.com/djensen47/cablegram/issues/25)) ([b0edb64](https://github.com/djensen47/cablegram/commit/b0edb64bc8e4077f1646a2db7e8556b8791e9eab))
* **subscriptions:** public token unsubscribe + RFC 8058 List-Unsubscribe ([#21](https://github.com/djensen47/cablegram/issues/21)) ([bafd47c](https://github.com/djensen47/cablegram/commit/bafd47cbfc6263368e7994287fce36bbe07723d1))
* **templates:** reusable templates + Handlebars rendering ([#6](https://github.com/djensen47/cablegram/issues/6)) ([5c24abe](https://github.com/djensen47/cablegram/commit/5c24abe82ba75e4d74139f5ce9636a0fd6f53a35))


### Bug Fixes

* **build:** exclude the integration setup from the production bundle ([#27](https://github.com/djensen47/cablegram/issues/27)) ([5861b6b](https://github.com/djensen47/cablegram/commit/5861b6bbd454dd2fbe1acf71b5269e464aefa30b))
* **campaigns:** remove the dead `rejected` outcome status ([#28](https://github.com/djensen47/cablegram/issues/28)) ([#32](https://github.com/djensen47/cablegram/issues/32)) ([a4f33ed](https://github.com/djensen47/cablegram/commit/a4f33ed5951770e220613634886a8f43511c0b38))
* **deploy:** drop the bogus `main:` key from the DO Functions action ([#40](https://github.com/djensen47/cablegram/issues/40)) ([96356ae](https://github.com/djensen47/cablegram/commit/96356ae890c437bd1cadc15b53d1dc8d64ae0f0b))


### Refactors

* **campaigns:** per-recipient outcome documents; fix lost updates at scale (ADR-019) ([#24](https://github.com/djensen47/cablegram/issues/24)) ([1e23967](https://github.com/djensen47/cablegram/commit/1e23967db997c6252a0fa7feb2c8373d0410cfed))
* **campaigns:** remove the stored stats snapshot (ADR-019 §7) ([#38](https://github.com/djensen47/cablegram/issues/38)) ([25fb944](https://github.com/djensen47/cablegram/commit/25fb9440e26f9fb8090074e40918f7101c0e9c9b))
* hoist duplicated presentation scaffolding into shared/http ([#12](https://github.com/djensen47/cablegram/issues/12)) ([add5369](https://github.com/djensen47/cablegram/commit/add5369b266effbbb9080808a40fe74f2563b896))
* **persistence:** component-owned collections + &lt;component&gt;_&lt;aggregate&gt; naming (ADR-017) ([#23](https://github.com/djensen47/cablegram/issues/23)) ([630f1ef](https://github.com/djensen47/cablegram/commit/630f1ef8e34cd83b6c4f7351ac9acf6eb39f3e7e))
* remove scheduled campaigns (Phase 1); defer scheduling to Phase 2 ([#16](https://github.com/djensen47/cablegram/issues/16)) ([1ccc723](https://github.com/djensen47/cablegram/commit/1ccc723096fd2e7c6662e126407a611b6c77bc2e))
* rename mergeFields to customFields (ADR-024) ([#35](https://github.com/djensen47/cablegram/issues/35)) ([fb27961](https://github.com/djensen47/cablegram/commit/fb279616ff8dae52f82650d59e24d1548e16ca6b))
* replace Prisma with the MongoDB native driver ([#13](https://github.com/djensen47/cablegram/issues/13)) ([f8f7c3c](https://github.com/djensen47/cablegram/commit/f8f7c3ce1b95d043182b7603282c8614c81590b1))
