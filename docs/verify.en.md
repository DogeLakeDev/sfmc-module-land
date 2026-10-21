# Testing and verification

[中文](verify.md) · [Documentation](README.md)

Automation validates domain state, persistence and recovery. Minecraft events, server loading and UI behavior need separate live-server checks. The manual cases below are expectations and **have not been run on real BDS**.

## Development checks

From the module root, using Node >=22.13.0 and pnpm 10.8.0:

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run test
```

build currently runs type checking only; it does not emit a standalone behavior pack. Tests use Node's test runner, node:sqlite and the existing TypeScript dependency. A SQLite experimental warning is not itself a failure; inspect the exit code and summary.

Current baseline: **36 passing tests, type checking and ESLint passing**. Tests execute the real repository, codecs and domain services, replacing Minecraft/economy/platform boundaries. Restart simulation retains database/economy state and rebuilds modules and indexes.

| File | Coverage |
| --- | --- |
| `test/land-regression.test.cjs` | Claim replay/reclaim, market transactions, rollback/lost acknowledgements, finance/deletion concurrency, lease revocation retries, reward recovery |
| `test/events.test.mjs` | Permission/member notifications corresponding to committed changes |
| `test/presence.test.mjs` | Adjacent land/area transitions, ordering, offline and repeated observations |
| `test/harness.cjs` | In-memory SQLite, boundary adapters, fault injection and restart setup; not production Minecraft |

For focused investigation, run node --test test/land-regression.test.cjs. Run fault injection in tests rather than altering production ledger states.

## Live setup and record

Use a test world, ordinary players A/B and an administrator with land.admin. Load economy and activity-log, back up first, and use disposable lands. Give A/B controlled balances to exercise both success and insufficient funds.

Defaults are claim price 50, no unclaim refund, empty initial bank, upkeep enabled, tax off, wilderness unprotected and ban_eject off. Record the configuration actually in use.

```text
Date / operator:
Full BDS version:
SFMC / SDK version:
Land version / Git commit:
Script module versions / experiments:
Configuration copy / backup:
Case / player / coordinates / dimension:
Expected / actual / logs / pass or fail:
```

## Live acceptance checklist

Every case below is currently **pending**. Replace Home, Store and B with real test names. Invoke all actions through /c:land.

| Case | Action | Expected |
| --- | --- | --- |
| Loading | Check ready/help, restart | No missing service/event errors; persisted lands and grants survive |
| Create/query | A creates Home; here, info, bank | First claim, owner and default area correct; player pays 50, bank is not auto-funded |
| Negative coordinates/dimensions | Query/claim around -1/-16/-17 and in multiple dimensions | Chunk -1/-1/-2 respectively; equal X/Z in different dimensions do not collide |
| Visitor protection | A/B break/place, use doors/containers and interact with entities | Owner allowed, unassigned B denied; check each block classification |
| Area boundaries | Select/create, test touching/overlapping boxes and unclaimed footprint | Both selected endpoint blocks included; touching succeeds, overlap/out-of-claim fails |
| Area role override | Give B an area role with only container.open | Only that role applies inside; outside falls back to land relation; no merged build permission |
| Relations | invite→accept; kick/ban confirm; unban confirm | No land member grant before acceptance; removal clears old area grants; ban wins; unban does not restore old role |
| Role changes | grant/revoke; delete referenced role with replacement | Next action uses new permissions; references migrate without dangling roles |
| Release/delete | Release area-used/final chunk, delete funded land | Refused until relevant constraints are satisfied |
| Bank | deposit, withdraw confirm, insufficient funds | Correct account deltas; failure creates no entitlement; avoid blind command reissue |
| Transfer | transfer Home B confirm | B owns land, A becomes administrator; bank and leases retained |
| Upkeep | Due with sufficient/insufficient bank; fund and pay | Due date advances on success; delinquency/grace/freezing follow settings; no automatic deletion |
| Upgrade | Meet next-level claims/member requirements, fund bank, upgrade confirm | Correct level, caps and charges; reward and durable marker agree |
| Rental | publish→take, renew, end confirm or expiry | Bank payment, tenant override and listing state agree; end removes tenant-preset override |
| Sale | sell_area/sell_land→buy confirm | Area grants a role only; whole-land sale transfers ownership and marks listing sold |
| Flags | Test melee/projectiles, explosions and registered hostile types | Record real coverage against matrix; block filtering is not entity immunity; spawn removal is after-event |
| Admin bypass | Toggle on/off in another land | Ordinary world actions follow toggle; test the earlier PvP flag restriction separately |
| Presence | A→B, area changes, logout | Subscribers observe left→entered; default area ID empty, one offline left |
| Restart/recovery | Restart, inspect diag/tx, repair a test copy | Database/index agree; recovery respects scope; attempt count is not success count |

Shorten upkeep/lease periods only in test configuration and reload; minimum periods and scheduler intervals still apply. Do not shift a production clock to run these cases.

## Gaps to record separately

Pistons, fluids, fire, automation and cross-boundary effects do not pass merely because direct block actions pass. Record unsupported behavior or observed gaps as described in [compatibility](compatibility.en.md).

API integration also needs checks for manifest permissions, authenticated actorId origin, callback unavailability, reward deduplication and cleanup on reload. Event consumers should query current state at startup rather than depend on complete replay.

On failure, retain logs, config, actor, dimension/coordinates and balance/ledger comparisons. Reproduce a minimal case before classifying it as a module defect, platform mismatch or documented limitation. See [recovery](data-and-recovery.en.md).
