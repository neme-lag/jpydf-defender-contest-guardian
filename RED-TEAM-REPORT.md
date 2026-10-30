# Red Team Report — Critical-Only Sweep

**Engagement:** break JPYdf or prove the critical surface is closed.
**Target:** the modules defined by `docs/protocol/spec/` — `CollateralVault`, `Oracle` (the whole `PriceFeeds/` stack), `dToken`, `Liquity-v2-Core-Spec`, `Zapper`, `strategies`, `InterestRouter`, `PILAllocator`, `JpydfToken`.
**Eligibility:** a finding is only *reportable* if it lands in one of the 25 review paths in `SCOPE.md`. Spec coverage is wider than eligibility, and this report keeps the two separate.
**Method:** the workflow in [`CRITICAL-BUG-WORKFLOW.md`](./CRITICAL-BUG-WORKFLOW.md) — C0 impact → C1 reachability → C2 realisation, then a deliberate false-positive filter.
**Date:** 2026-10-30 · final commit `1b453c10…`

---

## 1. Verdict

> **No new critical, unprivileged, reproducible vulnerability was confirmed.**

| Outcome | Count | Notes |
|---|---|---|
| **Critical findings** | **0** | Nothing met all three gates |
| Real defects below critical | 2 | F-1 (Low, unchanged file), F-2 (Low, in-scope `RedemptionHelper.sol`) |
| Candidates rejected as false positives | 15 | §4 — each with the code evidence that kills it |
| Critical-**class** risks confirmed but not reportable | 3 | §5 — privileged or already-known |

This is a **negative result with a defined boundary**, not a claim that the protocol is safe. §6 states exactly what was read, what was not, and how much of the changed surface that leaves. The honest headline for a client is: *the guards that would have to fail for a critical bug are present and correctly ordered on every path reviewed; the remaining critical exposure is concentrated in three privileged/known paths, not in user-reachable code.*

---

## 2. Scope and method

### 2.1 From spec modules to eligible files

| Spec | Module | Eligible review path? |
|---|---|---|
| `CollateralVault.md` (1,132 L) | `CollateralVault.sol` (802 nSLOC) | ✅ |
| `Oracle.md` (1,049 L) | `PriceFeedProxy`, `DFPriceFeedBase`, `DFWstETHPriceFeed`, `JpyFreezeLib`, `JpyUsdRateProvider`, `MainnetPriceFeedBase`, `CompositePriceFeed`, `PriceFeedPlaceholder` | ✅ all |
| `Liquity-v2-Core-Spec.md` (5,521 L) | `BorrowerOperations`, `TroveManager`, `RedemptionHelper`, `DFStabilityPool`, `AddressesRegistry`, `Constants` | ✅ (core files partially changed) |
| `Zapper.md` (786 L) | `CollateralYieldZapper` + archive | ✅ |
| `dToken.md` (500 L) | `DToken.sol` | ❌ byte-identical to baseline — **context only** |
| `JpydfToken.md` (430 L) | `JpydfToken.sol` | ❌ byte-identical — **context only** |
| `strategies/*` | `BaseStrategy`, `MorphoV2Strategy`, `AaveV3Strategy`, `ERC4626*` | ❌ byte-identical — **context only** |
| `InterestRouter.md`, `PILAllocator.md` | `InterestRouterForwarder`, `PILAllocator` | ❌ excluded as changed files |

This table is the first filter. Two of the most attractive critical stories — uncapped `bridgeMint` and a dToken conversion bug — die here, not in the code.

### 2.2 Rules applied

- **Critical** = destroyed solvency, stolen principal ≥ ~1% of a branch's TVL, unbounded supply, or a permanent trap. Nothing weaker was written up as critical.
- **Reachable** = an unprivileged actor with ordinary capital, in a bounded number of transactions. Privileged paths are reported as *trust risks*, never as findings.
- **Realised** = the invariant actually breaks in an executed test, or is unreachable by construction with the guard quoted.
- **False positive** = looks critical on a skim, dies on evidence. Every one is listed in §4 with the killing line, so the filter is auditable rather than a matter of taste.

### 2.3 Execution capability (verified, not assumed)

No Foundry in this environment (`raw.githubusercontent.com` and release assets are unreachable), so the compile/execute path was built and validated instead:

- `solc-js 0.8.24` compiles the repo with its own `remappings.txt`;
- `@ethereumjs/vm` 8.1.1 on Node 22 deploys and calls the real bytecode;
- verified: `CollateralVault` runtime **24,216 B** (360 B under EIP-170), `DToken` 12,108 B, ERC-1967 proxy delegatecall, custom + string revert decoding.

Harness: `tools/critical/` (`node smoke.test.js` passes). What it does **not** do is deploy a whole branch — that is the T2 harness, and its absence bounds this report (§6).

---

## 3. Findings

### F-1 — Authorization bypass on non-risk-increasing `adjustTrove` (Low)

**Where:** `Dependencies/AddRemoveManagers.sol:96-105`, reached from `BorrowerOperations._adjustTrove` (`:594-598`).

```solidity
function _requireSenderIsOwnerOrAddManager(uint256 _troveId, address _owner) internal view {
    address addManager = addManagerOf[_troveId];
    if (msg.sender != _owner && addManager != address(0) && msg.sender != addManager) {
        address removeManager = removeManagerReceiverOf[_troveId].manager;
        if (msg.sender != removeManager) revert NotOwnerNorAddManager();
    }
}
```

**Mechanism.** The extra `addManager != address(0)` conjunct makes the whole guard a **no-op whenever no add manager is set** — which is the default state of every Trove. Truth table:

| sender | addManager | outcome |
|---|---|---|
| owner | any | allowed (correct) |
| addManager | non-zero | allowed (correct) |
| removeManager | zero | allowed (correct) |
| **arbitrary third party** | **zero** | **allowed (incorrect)** |
| arbitrary third party | non-zero | reverts (correct) |

**Impact.** Anyone can call `adjustTrove` / `adjustZombieTrove` on any Trove with no add manager, provided the operation is *not* risk-increasing — i.e. they may **add collateral** or **repay debt** for a stranger. Both directions move value *into* the Trove, so there is no extraction: the caller only spends. Practical effects are griefing-grade: pushing a Trove back above MCR to block a liquidation, or donating collateral to distort someone's position.

**Why it is not critical:** the value-moving branch (`riskIncreasing`) uses a different, correct guard (`_requireSenderIsOwnerOrRemoveManagerAndGetReceiver`, `:107-121`), and `riskIncreasing = (collDecrease | debtIncrease) != 0` (`BorrowerOperations.sol:578`) closes the paths that pay out. No path lets the bypassed guard reach a `safeTransfer` to the caller.

**Eligibility:** `Dependencies/AddRemoveManagers.sol` is **not one of the 25 review paths**, so this is not contest-reportable — the call site is changed code, the defective condition is unchanged code. It is still a genuine defect and should be fixed.

**Fix:** `if (msg.sender != _owner && msg.sender != addManager)` (drop the `!= address(0)` clause), keeping the remove-manager fallback.

---

### F-2 — `truncateRedemption` quotes a fee below what the registry charges (Low, in-scope)

**Where:** `RedemptionHelper.sol:139` vs `CollateralRegistry.sol:133-146`.

`truncateRedemption` computes `feePct` on the **iteration-truncated** amount (`min` over per-branch extrapolations), while `CollateralRegistry.redeemCollateral` computes its fee on the amount truncated **only by total unbacked**. When the iteration limit binds, the registry's real rate exceeds the quote passed as `_maxFeePct`, and the redemption reverts on `require(redemptionRate <= _maxFeePercentage)`.

**Impact.** Integrators that follow the helper's quote get a revert instead of a redemption — a liveness/DoS on the quote path, not a loss. A user can always pass a higher `_maxFeePct`.

**Fix:** quote the conservative (higher) of the two fee bases, or have the helper pass the truncated-by-unbacked amount.

**Related observation (not a finding):** in `simulateRedemption`, a branch that is redeemable but fails the second price read has its proportion added to `totalProportions` *before* being marked non-redeemable (`:52-84`), so the distribution denominator is larger than the set of branches that can actually pay. `availableProportions` is computed and then used only for an early return (`:85-88`) — the structure suggests the intended denominator was the available one. Effect today is a conservative under-quote, so it stays an observation, not a bug.

---

## 4. False-positive filter

Everything below was pursued far enough to *fail*, with the line that killed it. This is the substance of a critical-only sweep: the value is in the closed cases.

| # | Candidate (looks critical) | Why it dies |
|---|---|---|
| 1 | **`bridgeMint` has no cap check** → unbounded supply (`JpydfToken.sol:211-216`) | `JpydfToken.sol` is byte-identical to baseline, and the minter set is empty at the final commit. Not eligible, not reachable. Reported only as pre-activation hardening. |
| 2 | **Writeoff → `backingRatio 0` → 1-wei price → mass liquidation** | Requires `WRITEOFF_ROLE` **and** the Strategy disabled or `pausedAllocation` (`_requireStrategyIncidentReady`). Purely privileged; quantified in §5, not reportable. |
| 3 | **Stale-FX liquidation profit** (liquidate a Trove that is healthy at true FX) | Real and unprivileged, but it is the documented KR-02 policy: the Proxy applies the 30 h JPY gate **only** when `msg.sender == borrowerOperations` (`PriceFeedProxy.sol:220-222`) and lets liquidation keep the source's bounded grace. Window is capped by the provider's 24 h `MAX_JPY_FREEZE_DURATION`. Known risk, not a new bug. |
| 4 | **Stale-FX redemption grind** (KR-01) | `_normalRedemptionJpyStatus` requires `< 30 h` provenance and the provider re-anchors on a newer round; no code path lets a caller extend the window beyond published data. Documented. |
| 5 | **Backing-gate bypass** (`redeem`/`claim`/`deposit` admit an impaired Vault) | The guard is **cache-free and live-only** on every entry point (`CollateralVault.sol:945-965`); `_strategyConservativeValueWithAvailability`'s cache fallback is used only by *pricing* views, never by `_requireConfirmedFullyBacked`. Four call sites verified: `deposit:290`, `_requireValidRedemption:952`, `claim:351`, `allocate:396`. |
| 6 | **Strategy mark inflation** → over-borrow | `_liveStrategyValuation` returns `min(estimatedTotalUnderlying, principal)` (`:1136-1140`) and `principal` only grows via Vault-initiated `deposit` with balance-delta accounting. A donation raises `est` but is clipped by `principal`; `est` cannot exceed realizable value without venue fraud. |
| 7 | **Redemption burns more than it delivers** | `RedemptionHelper.redeemCollateral` refunds `balanceOf(this) − before` after the registry call (`:185-188`), and the registry burns only `totals.redeemedAmount` (`CollateralRegistry.sol:167-170`). Burn ≤ delivered + refunded holds by construction. |
| 8 | **Zapper fund capture** (leftover / receiver / permit) | Leftovers are a *snapshot delta* returned to `msg.sender` (`LeftoversSweep.sol:54-64`) so pre-existing balances are protected; principal always routes to the Trove's configured `receiver` (`AddRemoveManagers.sol:117-120`); the permit fallback re-checks allowance. Residue is dust-scale. |
| 9 | **SP same-block JIT** | `withdrawFromSP` is gated by `_requireWithdrawalAfterDeposit` (`DFStabilityPool.sol:619-621`), claims by `_requireCollGainClaimAfterDeposit` (`:623-625`, applied when `initialDeposit > 0`), and `claimAllCollGains` requires no deposit at all (`:350-351`). Cross-block JIT remains, by design (L-02). |
| 10 | **Read-only reentrancy** during `allocate` (transfer → `deposit`, `totalUnderlying` understated) | No same-transaction consumer of `totalUnderlying` / `backingRatioForPricing` exists in the 25 changed files; both sides hold `nonReentrant`. Watch item, not a finding. |
| 11 | **Placeholder branch priced at ¥1** | Conservative, not exploitable: the sentinel *undervalues* real collateral, the branch has cap 0 and no Troves, and `finalizeRiskParams` requires an empty branch. Distinct from the activation-ordering risk in §5. |
| 12 | **`COLL_GAS_COMPENSATION_CAP` validated but never stored in the registry** | It *is* stored — in the TroveManager: `syncRiskParams` writes `collGasCompensationCap = _riskParams.COLL_GAS_COMPENSATION_CAP` (`TroveManager.sol:239`), consumed at `:362`. |
| 13 | **A source stuck in `PriceSource.lastGoodPrice` serves a stale price with `failure = false`** | Reachable only through `_shutDownAndSwitchToLastGoodPrice`, whose only callers are the archived `DFWBTC` / `sUSDS` feeds. No live branch can enter that state. |
| 14 | **wstETH urgent redemption priced off the normal (lower) quote** | `CompositePriceFeed.fetchUrgentRedemptionPrice` uses `_fetchPricePrimary(false)`, but `DFWstETHPriceFeed` **overrides** it with `PriceUse.UrgentRedemption` (`:158-163`). Dead concern for the deployed feed. |
| 15 | **`_handleFailedFetch` swallows a failing `shutdownFromOracleFailure`** | Deliberate: emits `ShutdownCallReverted` and still returns `failure = true`, and every consumer fails closed on that flag (`batchLiquidateTroves` returns, `fetchRedemptionPrice` latches, `openTrove`/risk-increase revert). Miswire is an observability problem, not a fund path. |

---

## 5. Critical-class risks that are confirmed but **not reportable**

These are real, code-verified, and severe — and none is a contest finding. They are recorded because a client buying a red team deserves to know where the actual catastrophic exposure sits.

| Risk | Trigger | Why not a finding | What would make it one |
|---|---|---|---|
| **Writeoff-induced liquidation cascade** | `writeoffStrategyPrincipal` with `_minBackingRatioAfter = 0` (accepted: only `> 1e18` is rejected, `CollateralVault.sol:719`) → backing 0 → `JpyFreezeLib` floors the price at **1 wei** (`:110-118`) → every Trove liquidatable | Requires `WRITEOFF_ROLE`, plus a Strategy already disabled or allocation paused | Any unprivileged path that makes `backingRatioForPricing()` measure zero. None found: `est` is read live, the floor applies only to a *measured* zero, and unavailability returns `(0,false)` → shutdown instead |
| **Stale-FX liquidation** | JPY leg frozen ≤ 24 h while collateral/USD is live; liquidation skips the 30 h provenance gate | Documented KR-02 trade-off (liquidate-on-stale vs do-not-liquidate) | A way to *choose* the stale window, or a longer bound than the 24 h freeze. Neither exists in code |
| **Uncapped bridge mint** | `bridgeMint` ignores `cap` | Unchanged file; empty minter set | Bridge activation, or any changed file that can grant the minter role |

---

## 6. Coverage and limits

| Module | Depth | Residual |
|---|---|---|
| `CollateralVault.sol` (802) | Full: entry points, guard, queue/claim, strategy accounting, allocate/treasury, writeoff/forceDeallocate, caches | No dynamic branch test (T2) |
| `RedemptionHelper.sol` (141) | Full | Needs T2 for the branch-failure matrix |
| `PriceFeeds/*` (≈770 across 8 files) | Full for the freeze/backing/provenance stack | No live-feed or fork behaviour |
| `DFStabilityPool.sol` (315) | Deposit/withdraw/claim/offset paths | Liquidation-scale interplay only static |
| `CollateralYieldZapper.sol` (592) | Native-ETH route, adjust/close receivers, leftovers, permit | `SkyUsdc` archive untouched |
| `BorrowerOperations.sol` (1,230) | Adjust/close/shutdown/oracle gates, manager guards | ≈60% of the file (batch manager, interest accrual) not line-by-line |
| `TroveManager.sol` (1,495) | Liquidation entry, redemption, urgent redemption, risk-param sync | ≈60% not line-by-line |
| `AddressesRegistry.sol` (251) | Full | — |
| Legacy `StabilityPool.sol` (303) | Spot-checked | Not deployed; deprioritised |

**What this report cannot claim:** that the core files are clean. Roughly 2,700 nSLOC of `BorrowerOperations` + `TroveManager` and the whole legacy pool were reviewed structurally, not line-by-line, and no full branch was ever executed. The critical-only filter is why that is acceptable — those areas are inherited Liquity code with the heaviest prior audit history — but it is a boundary, not a guarantee.

---

## 7. If the engagement continues

Five experiments, in expected-value order. The first is the only one that can still produce an unprivileged critical finding.

1. **T2 branch harness + stale-FX liquidation PnL.** Build the full `AddressVars` wiring, freeze the JPY leg at `t`, move true FX, and measure whether liquidating an on-chain-undercollateralised / real-world-healthy Trove is net-profitable to the liquidator. If yes, it is a *new* instance of KR-02 with a number attached, and the question becomes whether the 24 h bound is defensible.
2. **Writeoff + liquidation sweep trace.** Quantify the privileged blast radius (how many Troves fall, how much collateral moves) so the risk is priced rather than assumed.
3. **Property test:** `burnedJpydf ≤ deliveredValue + refundedJpydf` across the (branch-failure × iteration-limit × zero-unbacked) matrix.
4. **Invariant test:** `A_confirmed ≥ L_effective` is preserved by every external function — the one property that, if it ever fails, is a critical bug by definition.
5. **Mechanical access-control matrix** over every `external` function in the 25 paths (caller × state × expected revert). This is what would have caught F-1 automatically, and it is cheap.

---

## 8. Appendix — evidence

```bash
# environment (verified)
python3 packages/contracts/setup.py            # pinned deps, ~10 s
cd tools/critical && npm install && node smoke.test.js
#   CollateralVault runtime 24216 B (headroom 360) | DToken 12108 B
#   proxy delegatecall OK | revert decoding OK

# key evidence lines
CollateralVault.sol:945-965    # live-only, cache-free backing guard
CollateralVault.sol:719        # _minBackingRatioAfter may be 0
JpyFreezeLib.sol:110-118       # measured zero -> 1 wei price
PriceFeedProxy.sol:220-222     # 30 h JPY gate only when msg.sender == BO
JpyUsdRateProvider.sol:82-108  # freeze lifecycle, 24 h bound, re-anchor
AddRemoveManagers.sol:96-105   # F-1 condition
RedemptionHelper.sol:181-189   # JPYdf refund closes burn>deliver
CollateralRegistry.sol:167-170 # burns totals.redeemedAmount only
DFStabilityPool.sol:619-625    # same-block guards
TroveManager.sol:239,362       # gas-compensation cap actually stored
```

**Reproduce status:** F-1 is proven by the truth table above (three-line predicate) and needs no runtime; F-2 is proven by reading two fee bases. Both are Low. Nothing in this report required a mock that assumes the vulnerability it claims — that is the line between a finding and a design note, and this sweep did not cross it.
