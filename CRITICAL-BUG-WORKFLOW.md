# Critical-Bug Workflow

**Scope: critical only.** This is the execution plan derived from [`THREAT_MODEL.md`](./THREAT_MODEL.md). It pursues the small set of failure modes that can destroy solvency or take user principal, and explicitly refuses everything else. Every target below is already filtered by impact; the work is to decide, per target, whether it is **reproducible and exploitable** at the final commit.

Companion documents: [`CONTEXT.md`](./CONTEXT.md) (protocol facts), [`THREAT_MODEL.md`](./THREAT_MODEL.md) (full threat catalogue), [`SCOPE.md`](./SCOPE.md) (25-file contest scope).

---

## 0. Operating rule

> **No critical claim without a reproduction. No reproduction without an exploit path. No exploit path without an actor who can actually take it.**

Three ordered gates. A target that fails any gate is closed and written down as closed — it does not get "kept warm".

| Gate | Question | Evidence required | If failed |
|---|---|---|---|
| **C0 — Impact** | Can this destroy solvency, take principal, or mint supply without backing? | A number: how much, and whose | Reject as non-critical |
| **C1 — Reachability** | Who can trigger it, with what capital, in how many transactions? | Call graph from an externally reachable function | Reject or reclassify as privileged/ops risk |
| **C2 — Realisation** | Does an executed PoC show the value actually moving or the invariant actually breaking? | Failing assertion on a real harness, plus a trace | Reject as theoretical |

Only `C0 ∧ C1 ∧ C2` produces a critical finding. Everything else becomes an Info/Medium note at most — and this workflow does not spend time on those.

### 0.1 The impact test (C0)

A target is critical only if **at least one** holds with material magnitude:

1. **Solvency break** — `A_confirmed < L_effective` becomes true without a corresponding real loss, *or* a real loss stays invisible to `backingRatio` long enough to be cashed out.
2. **Principal loss** — an actor ends a transaction sequence with more value than they started, funded by other users' deposits, at ≥ 1% of a branch's TVL or ≥ ¥1M, whichever is smaller.
3. **Supply integrity** — `JpydfToken` or dToken supply can exceed what the system can redeem (including the uncapped bridge path), or be burned without delivery.
4. **Permanent trap** — all exits close with no permissionless recovery and no timelocked fix.

### 0.2 The exploitability test (C1)

Record, per target: **actor class** (unprivileged / funded / privileged / external), **capital required**, **number of transactions**, **atomicity** (single tx or multi-block), **MEV exposure** (can a searcher front-run the fix or the exploit), and **repeatability** (one-shot or drainable in a loop). A privileged-only path is still worth *understanding* but is not a contest finding under a "critical bugs only" filter — file it as a design/trust note.

### 0.3 The scope test

Findings must reproduce at the **final commit** (`1b453c10…`) inside the **25 changed files / 535 nSLOC** from `SCOPE.md`. A bug in an unchanged Liquity file is inherited and out of scope unless a changed file is what makes it reachable. Check the diff boundary first; it costs 10 minutes and saves days.

---

## 1. Ranked target register

Ordered by **damage ceiling** (solvency → user funds → supply), then by expected value. `Actor` uses the threat-model classes: `U` unprivileged, `M` funded/MEV, `P` privileged, `X` external.

**Eligibility is decided before damage.** From `SCOPE.md`, the 25 review paths *are* the contest. Several critical-looking targets live in files that are byte-identical to the baseline (`DToken.sol`, `JpydfToken.sol`, `MorphoV2Strategy.sol`, `CollateralRegistry.sol`): those are **context**, and a finding must land in a changed file to be eligible. The `Eligible?` column encodes exactly that, and it is why C-09 is not a contest finding.

| Rank | ID | Failure | Damage ceiling | Actor | Eligible? (`SCOPE.md` 25 paths) | Verdict to prove | Effort | Expected value |
|---|---|---|---|---|---|---|---|---|
| 1 | **C-01** | Backing guard admits phantom backing → branch-wide insolvency | Entire branch TVL (¥35M / ¥100M) | U | **`CollateralVault.sol`** ✅ | Can any value-removing path skip `A_confirmed`? | M | **Highest** — max damage, no privilege |
| 2 | **C-02** | Vault valuation inflates the mark → over-borrow → bad debt | Branch solvency, bounded by strategy weight | U/M | **`CollateralVault.sol`** ✅ (adapters are context) | Can a third party raise the value the Vault *counts* while realizable value stays? | M | High |
| 3 | **C-03** | Redemption burns JPYdf without delivering equivalent collateral | Repeatable, per-redemption, whole branch | U | **`RedemptionHelper.sol`, `TroveManager.sol`, feeds** ✅ | Can `burned > delivered + refunded` in any branch ordering? | H | High |
| 4 | **C-04** | Writeoff → 1-wei price → mass liquidation of solvent Troves | All borrower collateral in the branch | P | **`CollateralVault.sol`, `JpyFreezeLib.sol`** ✅ | Is there a non-privileged trigger for a measured-zero mark? | M | Medium (privileged) |
| 5 | **C-05** | Vault deposit/redeem arithmetic mints dToken claims on value that never arrived | Branch-wide, permanent dilution | U | **`CollateralVault.sol`** ✅ (`DToken.sol` is context) | Can a token quirk (fee/rebase/decimals) break mint↔backing in the Vault? | M | Medium-high |
| 6 | **C-06** | Vault redeem/claim captures or duplicates funds | Per-request, drainable | U/M | **`CollateralVault.sol`** ✅ | Can a request be paid twice, or paid to the wrong owner? | M | Medium |
| 7 | **C-07** | Stability-pool gain accounting leak | SP depositors' collateral gains | U/M | **`DFStabilityPool.sol`** ✅ (`StabilityPool.sol` is legacy context) | Can the same-block guard be bypassed via the claim path? | M | Medium |
| 8 | **C-08** | Reentrancy / read-only reentrancy with a same-tx price consumer | Critical *if reachable* | U | **`CollateralVault.sol`** ✅ | Is `totalUnderlying` or the price consumed mid-call? | H | Low-medium |
| 9 | **C-10** | Zapper captures or misdirects user funds | Per-user, bounded by flow size | U/M | **`Zappers/CollateralYieldZapper.sol`** ✅ | Can residue be made material, or the receiver redirected? | L | Low |
| 10 | **C-09** | `bridgeMint` bypasses the cap → unbounded supply | Protocol-wide, total | P/X | ❌ **`JpydfToken.sol` is unchanged** — context only | Is any minter registered, and can a *changed* file reach one? | L | **Not a finding** (context note) |

**Why this order.** Ranks 1–4 can break the branch itself. Ranks 5–8 take money from identifiable users. Rank 9 is a cheap close-out. Rank 10 is context: it cannot be submitted as a contest finding, but it must still be *proved* closed because it would cap the protocol's blast radius if a bridge minter ever exists.

---

## 2. The loop

Each target runs the same six phases. Time boxes assume one focused engineer; they are ceilings, not targets.

### Phase 0 — Environment (once, ~15 min)

```bash
cd /home/user/jpydf-defender-contest-guardian
python3 packages/contracts/setup.py          # pinned libs; ~10s, verified

# Preferred runner (if available):
forge build --root packages/contracts
forge test  --root packages/contracts --match-path 'test/critical/*'

# Fallback runner (verified working in this sandbox, no Foundry):
cd tools/critical && npm install && node smoke.test.js
```

**Verified environment facts** (do not re-derive):

| Fact | Value |
|---|---|
| Foundry binaries | **Absent.** `raw.githubusercontent.com` / release assets are not reachable, so `foundryup` cannot complete |
| Dependency install | `python3 packages/contracts/setup.py` → 5 libs at pinned revs in ~10 s |
| Compiler | `solc-js` 0.8.24 (`npm i solc@0.8.24`) compiles `src/CollateralVault.sol` in ~2.5 s using the repo's `remappings.txt` |
| Vault size | creation 24,496 B / runtime **24,216 B** → **360 B EIP-170 headroom** |
| Execution | `@ethereumjs/vm` 8.1.1 on Node 22 deploys and calls the compiled Vault (deploy gas 4,872,481) |
| Broken | **ganache 7.9.2 does not run on Node 22** (missing `uws_linux_x64_127.node`) — do not spend time on it |
| Test suite in this snapshot | only 5 oracle test files; **no Vault/core harness exists** — PoCs are built from scratch |

The size number is load-bearing: **any PoC that requires adding production code is undeployable**. Prefer harness-only mocks; if a fix would add bytes, say so in the report.

### Phase 1 — Exploit-path mapping (~2 h per target, no code)

Produce a **path card** before writing any test:

1. Enumerate every externally reachable entry point on the path (`grep -n "external\|public"` on the changed files).
2. For each, list the guards it passes: role modifier, pause modifier, `nonReentrant`, `whenUnderlyingReady`, backing guard, price-failure handling.
3. Write the state delta the attacker needs (which storage variable must move, in which direction, by how much).
4. Mark every place where the attacker's input reaches that storage variable.
5. Decide: **is there a guard on every edge?** If yes, the target is dead unless the guard itself is wrong. Kill it in writing.

Deliverable: a paragraph + a call graph. If you cannot draw the graph, you cannot write the PoC.

### Phase 2 — Instrument (~2–4 h)

Two harness tiers, chosen by what the target needs:

| Tier | Contents | Use for | Status |
|---|---|---|---|
| **T1 unit** | Vault (UUPS proxy) + DToken (UUPS proxy) + mock ERC20 + mock Strategy + mock backing-ratio consumer | C-01, C-02, C-05, C-06 | Build once, reuse |
| **T2 branch** | Full `AddressVars` wiring (19 addresses) via `AddressesRegistry`, PriceFeedProxy + mock source, TroveManager stack | C-03, C-04, C-07 | Expensive; only after Phase 1 justifies it |

**Deployment order for T1** (the initializers are circular — this order works):

1. Deploy Vault implementation; deploy `ERC1967Proxy` with **empty** init data → `vaultProxy`.
2. Deploy DToken implementation; deploy proxy; `DToken.initialize(vaultProxy, owner)`.
3. `vaultProxy.initialize(underlying, dToken, treasury, admin)` — this checks `dToken.vault() == address(this)`, so step 2 must come first.
4. `dToken.setTokenInfo(name, symbol, underlying)` — requires `allowedUnderlying[underlying] == true`, so allow the underlying **before** this call (owner-only setter).
5. `vault.setUnderlying(underlying)` and wire roles.

**Gotchas that will cost hours if rediscovered:** OZ *upgradeable* in this repo is 4.x — its `_disableInitializers` reverts with the **string** `"Initializable: contract is already initialized"`, not a custom error (the harness decodes both). `AddressesRegistry.setAddresses` and `finalizeRiskParams` are one-shot; `finalizeRiskParams` additionally requires an empty branch (zero cap/supply/troves/debt/coll, empty SP, no shutdown flags).

### Phase 3 — PoC or kill (~4 h, hard stop)

Write the smallest test that **fails the invariant**, not the largest that exercises the system. Pattern:

```js
// 1. arrange: attacker has the only thing they need (capital, a trove, a strategy)
// 2. act: exactly the calls an attacker would make, in one or more "transactions"
// 3. assert the invariant that must NOT break, e.g.:
//    assert(A_confirmed >= L_effective, 'phantom backing admitted');
//    assert(burnedJpydf <= deliveredCollateralValue, 'redemption inversion');
// 4. quantify: decode the attacker's ending balance vs starting balance
```

**Kill criteria — stop immediately if any is true:**

- every reachable path to the target storage passes a guard you cannot argue is wrong;
- the attacker needs a role, and no unprivileged path reaches that role;
- the state you need cannot be produced without breaking a *different* invariant first (note it as a precondition and check whether that precondition is itself a finding);
- the PoC only works with a mock that assumes the vulnerability (such as a strategy that lies by construction — that is a design note, not a bug);
- the impact is only reachable at a commit outside the 25-file diff.

### Phase 4 — Exploitability and PnL (~1 h)

For a target that survives Phase 3, answer in writing:

| Question | Why it matters |
|---|---|
| Capital needed, and cost of carry | A 3-block exploit with ¥1M is different from a 30-day lock |
| Profit measured in the *underlying*, not the token | Prices can be wrong in the attacker's favour too |
| Who pays | Other dToken holders? the branch? the SP? Treasury? |
| Atomic or multi-block | Determines MEV competition and whether a keeper can front-run |
| Repeatable | A drainable loop outranks a one-time hit |
| Detectable | Is there an event, or would it be silent? |

### Phase 5 — Severity and write-up (~1 h)

Use the repository's own lens: does it break a `VAULT-INV-*` / `SYS-INV-*`, and is there a prior `KR-*` that already covers it? If a `KR-*` covers it, the finding must show what that risk assessment **missed** (a new path, a new number, or a wrong conclusion) — otherwise it is a duplicate and will be closed.

Report skeleton (contest-ready, 1 page):

```
Title:            <one line, mechanism + impact>
Severity:         Critical   (impact class + why not High)
In-scope files:   <path:line …>
Preconditions:    <actor, capital, state>
Attack path:      <numbered calls with contract + function>
Why it works:     <the guard that is missing or wrong, quoted>
Impact:           <amount at risk, who loses, repeatability>
PoC:              <test path + the failing assertion output>
Fix:              <smallest change; note EIP-170 headroom>
Prior-art check:  <KR-*/known-issues entry and what it missed>
```

### Phase 6 — Regression and dedupe (~30 min)

1. Re-run the PoC against the **baseline** commit (`d4122704…`) to confirm the bug is introduced-or-exposed by this diff, not inherited untouched.
2. Search the 21 prior findings (`docs/known-issues.md`) for the same mechanism.
3. Record the outcome in the register (`CONFIRMED` / `BLOCKED` / `UNREACHABLE`) with one sentence of reasoning. **A closed target is a result** — it prevents re-litigation.

---

## 3. Work cards

Each card is written so it can be picked up cold. Line references are to the final commit.

### C-01 — Phantom backing admitted (rank 1)

- **Hypothesis.** Some value-removing path (redeem, redeemWithPermit, claim, or a deposit-side conversion) admits a Vault whose confirmed assets are below liabilities, letting a holder exit at par from a hole.
- **Targets.** `CollateralVault._requireConfirmedFullyBacked` (`:940-1000`), `deposit`, `redeem`, `redeemWithPermit`, `claim` (`:338-360`), `_completeRedemption` (`:1009-1032`), `backingRatioForPricing` (`:902-917`), `_totalUnderlyingWithAvailability`, `_strategyConservativeValueWithAvailability`.
- **What must be true to exploit.** (a) the guard is reachable with a stale or partial asset figure, or (b) a path changes state before the guard, or (c) `L_effective` understates a liability at the moment of payment.
- **Recipe.** T1 harness. Mint dTokens, put half the underlying in a mock Strategy, make the Strategy report `est < principal` **and** revert on a second probe, then attempt `redeem` and `claim`. Assert the guard reverts; then try to find an ordering where it does not (e.g. `claim` after a partial settlement, `redeemWithPermit` with an allowance fallback, deposit with a fee-on-transfer token).
- **Kill.** Every entry point calls the guard before any state change or token movement (verify by reading the function bodies end-to-end, not by grep).
- **Blast radius if confirmed.** Entire branch TVL, repeatable until the buffer empties, and the loss is socialised to whoever remains.

### C-02 — Valuation inflation → over-borrow (rank 2)

- **Hypothesis.** The Vault counts more value than exists — through `min(est, principal)`, the valuation cache, the availability flag, or the sum in `_managedUnderlying` — so borrowers draw JPYdf against phantom collateral and the branch is insolvent when the mark corrects.
- **Targets (changed file only).** `CollateralVault._managedUnderlying`, `_strategyConservativeValueWithAvailability`, `_totalUnderlyingWithAvailability`, `_refreshStrategyValuation` / `_reduceStrategyValuationCache` / `_invalidateStrategyValuationCache`, `receiveFromStrategy`, `backingRatioForPricing`. Strategy adapters are **context**: a finding that reads "Morpho is mispriced" is ineligible; a finding that reads "the Vault over-counts what the adapter reports" is in scope.
- **What must be true.** (a) a third party moves `est` while realizable value stays; (b) `principal` is raisable without a Vault deposit; (c) the cached mark used for pricing diverges from the live mark used for user flows, in the *high* direction; (d) `available` is true when it should be false, so an unreadable strategy silently contributes its last-good value.
- **Recipe.** T1: mock Strategy with settable `est`, `principal`, and revert behaviour. Walk the matrix: `est < principal`, `est > principal`, revert-once-then-answer, answer-then-revert, `receiveFromStrategy(amount ≠ balance delta)`. After each, read `backingRatio()`, `backingRatioForPricing()`, and `totalUnderlying()` and assert they never exceed `raw + min(est, principal)`. Then attempt the cache-divergence play: make the cache high, then make the live read fail, and check the price the oracle would consume.
- **Kill.** `min(est, principal)` holds, `principal` moves only on Vault-initiated deposit with balance-delta accounting, and the cache is only ever consumed by pricing — never by a flow that pays out.
- **Blast radius.** Borrow headroom equal to the inflated mark; loss lands on the branch when the mark is corrected.

### C-03 — Redemption burns without delivering (rank 3)

- **Hypothesis.** A redeemer's JPYdf is destroyed while the collateral (or refund) they receive is worth less, and nothing on-chain records the difference.
- **Targets (all changed files).** `RedemptionHelper.redeemCollateral` (`:159-190`), `simulateRedemption` (`:44-116`), `truncateRedemption` (`:118-156`), `TroveManager.redeemCollateral`, `PriceFeedProxy.fetchRedemptionPrice`, `DFWstETHPriceFeed` redemption legs, `getUnbackedPortionPriceAndRedeemability`.
- **What the code already does** (verified while writing this card — start here, it narrows the hunt): the helper pulls `_jpydf`, delegates the whole redemption to `CollateralRegistry`, then **refunds any JPYdf still held** (`jpydfRemaining = balanceOf(this) − before`) and pays out measured collateral deltas per branch (`:181-189`). So the naive "burn more than delivered" is defended by a refund. The surviving attack surfaces are therefore:
  1. **`totalProportions` vs `availableProportions`.** In `simulateRedemption`, a branch that is redeemable but fails the *second* price read (`redemptionPriceAvailable == false`) is marked non-redeemable **after** its proportion was already added to `totalProportions` (`:52-84`). Distribution then divides by the larger denominator, so the redeemer's attempted amount silently shrinks. `availableProportions` is computed and then used only for an early return — a structural smell that the intended denominator was the available one.
  2. **Fee-base mismatch (DoS, not loss).** `truncateRedemption` quotes `feePct` on `min(unbacked-truncated, iteration-truncated)` (`:139`), while `CollateralRegistry` computes the fee on the amount truncated **only by total unbacked** (`CollateralRegistry.sol:133-146`). When the iteration limit binds, the registry's real fee is higher than the quote, so a redemption built from the helper's quote reverts on `_maxFeePercentage`. Confirm whether any path charges the higher fee without reverting — that would be a loss instead.
  3. **Refund asymmetry.** The helper refunds JPYdf it still holds, but if the registry burns from `msg.sender` (the helper) yet pays collateral to a *different* address, the delta accounting still credits the helper — verify the treasury/receiver wiring.
- **What must be true.** An ordering where the sum of (collateral delivered + JPYdf refunded), valued at the same redemption price, is less than the JPYdf burned.
- **Recipe.** T2 with two branches: one healthy, one whose `fetchRedemptionPrice` reverts on the second call (mock source that fails on demand). Redeem a round amount; assert `burnedJpydf == deliveredJpydf + refundedJpydf` and that the redeemer's value is unchanged minus the disclosed fee. Then vary the iteration limit to force the `extrapolatedJpydf` truncation and repeat.
- **Kill.** Burn and refund reconcile exactly in every combination of (branch price failure × iteration limit × zero-unbacked fallback).
- **Blast radius.** Per-redemption loss, repeatable at will, and it looks like ordinary slippage to the user.

### C-04 — Writeoff → 1-wei price → liquidation sweep (rank 4)

- **Hypothesis.** A markdown reaches the oracle as `backingRatio ≈ 0`; `JpyFreezeLib` floors that at 1 wei, so the branch prices at ~0 and every Trove is liquidatable.
- **Targets.** `CollateralVault.writeoffStrategyPrincipal` (`:713-731`), `_requireStrategyIncidentReady`, `_pauseUserFlows`, `JpyFreezeLib.applyBackingRatio` (`:96-127`), `TroveManager.batchLiquidateTroves` (`:442-455`).
- **What must be true for *critical*.** The trigger must not require the WRITEOFF key. Proven so far: it does require WRITEOFF (plus a disabled strategy or paused allocation). So the critical question becomes: **can an unprivileged actor make the Vault measure zero** (strategy reporting 0, or a venue state that yields 0) without a real total loss?
- **Recipe.** Two experiments. (1) Privileged reproduction: WRITEOFF writes off 100%, then liquidate a healthy Trove — record the trace, quantify the sweep across 3 Troves; label it **P-only** in the report. (2) The real hunt: mock Strategy whose `estimatedTotalUnderlying()` returns 0 on demand; check who can cause that (only the strategy itself → external; or a public venue function → unprivileged).
- **Kill.** No non-privileged path to a measured zero, *and* the privileged path is documented as an accepted operational risk (it is already partly documented in the code comment).
- **Blast radius.** Every borrower's collateral in the branch, in a single block, with the liquidator keeping the penalty.

### C-05 — Deposit arithmetic mints unbacked dToken (rank 5)

- **Hypothesis.** The Vault credits more dToken than the underlying it actually received, for a legitimate underlying shape (6 decimals, fee-on-transfer, negative rebase).
- **Targets (changed file only).** `CollateralVault.deposit`, `redeem`/`redeemWithPermit` amount math, `_dTokenToUnderlyingRoundingUp`, `_requireUnderlyingReady`, the Vault-side decimals handling. `DToken.sol` is unchanged, so a pure conversion bug there is context — the eligible claim is that **the Vault passes or interprets the conversion wrongly**.
- **What must be true.** A token with `< 18` decimals converts lossily in one direction, or a fee-on-transfer token credits more than received, or the rounding direction inflates liabilities rather than assets.
- **Recipe.** T1 with a 6-decimal mock (USDC shape) and a 1% fee-on-transfer mock. Deposit 1 wei repeatedly; assert `convertToUnderlying(supply) ≤ totalUnderlying` after every step, and that no dust path mints a claim on value that did not arrive.
- **Kill.** Rounding consistently favours the protocol, and receipt-based accounting is used everywhere.
- **Blast radius.** Slow, permanent dilution; the exact failure that a cap + backing gate is supposed to make impossible.

### C-06 — Redeem/claim fund capture (rank 6)

- **Hypothesis.** A withdrawal request can be paid twice, paid to the wrong receiver, or paid for a request that was never queued.
- **Targets.** `_queueWithdrawRequest`, `claim` (`:338-360`), `withdrawRequests` lifecycle, `_completeRedemption`, `whenNotPausedClaim`, reentrancy guards.
- **What must be true.** The request is marked settled after the transfer (not before), or `owner` is read after an external call, or a failed transfer leaves the request claimable while the token movement also succeeded elsewhere.
- **Recipe.** T1; queue a request, advance `withdrawDelay`, claim from two different callers, attempt claim-before-maturity, attempt claim twice, use a mock underlying whose `transfer` reenters `claim`.
- **Kill.** CEI holds and the settled flag is written before any token movement.
- **Blast radius.** One request's worth per successful replay, bounded by the buffer.

### C-07 — Stability-pool gain leak (rank 7)

- **Hypothesis.** The same-block guard is bypassable through the claim path, letting a JIT depositor capture another depositor's liquidation gains.
- **Targets.** `DFStabilityPool.provideToSP` (`lastDepositBlock`), `withdrawFromSP`, `claimAllCollGains` (`_requireUserHasNoDeposit`).
- **What must be true.** `claimAllCollGains` becomes reachable in the same block as a deposit (it requires zero deposit — so a deposit-then-withdraw in the same block would need the withdraw guard to be absent on that path).
- **Recipe.** T2 (SP needs the core). Deposit, liquidate, attempt claim in the same block; then attempt the two-transaction variant and compare captured gain vs a long-term depositor's share.
- **Kill.** Every exit that pays gains requires `lastDepositBlock < block.number`.
- **Blast radius.** Bounded by one liquidation's SP penalty; recurring during cascades.

### C-08 — Reentrancy with a same-tx price consumer (rank 8)

- **Hypothesis.** During `allocate` (transfer → `deposit`), the Vault's own views understate assets; if anything in the same transaction reads the price, it acts on a false mark.
- **Targets.** `_allocateToStrategies` (`:1040-1140`), `BaseStrategy.deposit` (self-call `deployUnderlying`, try/catch recovery), `nonReentrant` on both sides, `backingRatioForPricing`, `totalUnderlying`.
- **What must be true.** A callback during `deposit` reaches a consumer that prices or liquidates. Today no in-repo consumer qualifies — so this is a *watch item* unless a changed file introduces one.
- **Recipe.** Malicious `deposit` that calls back into `vault.redeem` / `priceFeed.fetchPrice`; assert the guard reverts. Then test read-only reentrancy: call `backingRatioForPricing()` from inside the callback and compare against the post-transaction value; quantify the delta.
- **Kill.** No same-tx consumer exists in the 25 changed files.
- **Blast radius.** Critical if a consumer exists, because the price is what liquidations use.

### C-09 — Context check: `bridgeMint` uncapped (rank 10, **not eligible**)

- **Why it is not a finding.** `JpydfToken.sol` is byte-identical to the baseline, so it is context, not a review path. Do not write it up as a contest submission.
- **Why it is still checked (15 minutes).** It is the only structural route to unbounded supply, and it bounds the blast radius of anything a *changed* file could enable. Confirm: (a) the minter set is empty at the final commit; (b) no changed file (`BorrowerOperations`, `AddressesRegistry`, `CollateralVault`) can grant the minter role; (c) `bridgeMint` still lacks a cap check (`JpydfToken.sol:211-216`).
- **Outcome.** One line in the register: `UNREACHABLE — empty minter set, 48h timelock, no changed file can grant the role`. Then stop.

### C-10 — Zapper fund capture (rank 10)

- **Hypothesis.** Leftover residue or a receiver-selection bug lets a manager or an arbitrary caller take user value.
- **Targets.** `Zapper/CollateralYieldZapper.sol` (`_adjustTroveWithUnderlyingPre/Post` `:646-682`, `:506-513` permit fallback, `_returnLeftovers`), `LeftoversSweep.sol`.
- **What must be true.** Residue can be made material (not dust), or `receiver` can be changed by a non-owner, or the permit fallback authorises an unintended pull.
- **Recipe.** T1 + mock tokens; manager-driven adjust with a fee-on-transfer underlying, measure residue vs manager gain; try to change receiver as add-manager.
- **Kill.** Residue is provably dust (< 1 base unit per operation) and receiver is owner-controlled.
- **Blast radius.** Small, per-operation — include only if a material residue path exists.

---

## 4. Ordering by expected value

`EV ≈ P(confirmable) × damage ÷ effort`, using the register's ceilings.

| Rank | Target | P (after reading) | Damage | Effort | Action |
|---|---|---|---|---|---|
| 1 | C-01 | Low-medium | Branch TVL | M | **Do first.** Largest payoff, guard-first design means a bypass is a genuine find |
| 2 | C-02 | Low | Branch solvency | M | Do second. `min(est, principal)` is the whole defence; test whether it is bypassable |
| 3 | C-03 | Medium | Per-redemption, repeatable | H | Do third. Highest raw probability of a real bug in the seam |
| 4 | C-05 | Medium | Dilution | M | Cheapest of the solvency-adjacent set |
| 5 | C-06 | Low-medium | Request-sized | M | Reuse T1 from C-01 |
| 6 | C-07 | Medium | SP gains | M | Needs T2; batch with C-03 |
| 7 | C-04 | High (privileged) | All collateral | M | Do the unprivileged-trigger hunt only; don't re-prove the privileged sweep |
| 8 | C-08 | Low | Critical if live | H | Skip unless a changed file adds a consumer |
| 9 | C-10 | Low | Dust | L | Close-out after the others |
| 10 | C-09 | n/a | Total | **L** | 15-minute context check; **cannot be submitted** |

### Suggested two-week shape

| Day | Work | Exit criterion |
|---|---|---|
| 1 | Phase 0 + Phase 1 for C-01, C-02, C-03 | Three path cards; any target killed here saves the rest |
| 2 | T1 harness; C-01 PoC attempt | Guard coverage map with every entry point ticked |
| 3 | C-01 close-out; C-05 PoC | Rounding/fee assertions green or a failing invariant |
| 4 | C-02 PoC; C-06 PoC | `min()` clip recorded; request lifecycle asserted |
| 5 | T2 harness begins; C-03 PoC | `burned ≤ delivered` asserted across branches |
| 6 | C-03 variations; C-04 unprivileged hunt | Branch-skip matrix covered |
| 7 | C-07 with T2; C-09/C-10 close-outs | All ten targets have a written verdict |
| 8 | Phase 4/5 on survivors | Exploitability numbers + report drafts |
| 9 | Phase 6 regression vs baseline + prior findings | Dedupe table |
| 10 | Final pass: re-read the 25 changed files against the surviving findings list | Nothing critical unexamined |

---

## 5. Evidence bar

A critical submission is only credible if a reviewer can reproduce it without asking a question. Minimum bar:

1. **A runnable artifact** — `test/critical/Cxx_*.t.sol` (Foundry) or `tools/critical/poc_*.js` (fallback harness), checked in, with the assertion that fails.
2. **An attacker transcript** — the exact call sequence, with actor addresses and block timestamps, and whether it is one transaction or many.
3. **A quantified number** — value at risk, in the underlying and in JPYdf, with the price assumption stated.
4. **A guarantee that the attack is not mock-artefact.** Mocks may model a *venue*, never the *vulnerability*. If the PoC needs a lying strategy, say explicitly that the strategy is the attacker (and accept it is a design note).
5. **A scope note** — the file:line in the 25-file diff, and the baseline behaviour for the same path.
6. **A prior-art note** — the nearest `KR-*`/known-issue entry and what it missed.

Anything less is a *lead*, not a finding. Leads go in the register with `status: open`, and the workflow moves on.

---

## 6. Explicitly not pursued

Recorded so the filter is auditable. These are real risks (see the threat model) but none is a *critical contest bug*:

| Excluded | Reason |
|---|---|
| TM-O-06 miswire → silent branch DoS | Availability, privileged deployment error, no principal loss |
| TM-C-01 liquidation halt during oracle failure | Fail-closed by design; no theft |
| TM-C-04 shutdown exit narrowing | Soft-lock; `closeTrove` verified open; needs market liquidity, not a code fix |
| TM-O-09 30 k stipend / TM-O-10 latch asymmetry | Silent feature degradation, no loss |
| TM-O-04 emergency source confirm / TM-O-05 proxy cycle | Privileged; documented as trust assumptions |
| TM-G-01 Guardian freeze / TM-G-03 operator scopes | Destination-constrained; no theft path |
| TM-G-04 GOV upgrade compromise | Total trust by definition; not a bug |
| TM-X-02 storage layout / TM-X-05 monitoring gaps | Delivery & detection hygiene |
| TM-V-02 impairment front-run | Structural market behaviour; the code-level variants are folded into C-01 |
| TM-V-03 buffer starvation | Medium: delays claims, does not lose them |
| TM-O-01/02/03 stale-FX family | Bounded by the 30 h window; dominated by C-03 unless a changed file alters the price path |
| TM-G-05 `bridgeMint` uncapped | `JpydfToken.sol` is unchanged → context, not a review path. Checked for reachability only (C-09) |
| TM-Z-01..05 beyond C-10 | Dust/bounded; closed out with C-10 |

If a survivor of the loop turns out to be Medium rather than Critical, it is reported as Medium — the workflow's filter is a *prioritisation* tool, not permission to inflate severity.

---

## 7. Harness reference

`tools/critical/` contains a validated fallback runner for environments without Foundry:

```
tools/critical/
├── package.json
├── smoke.test.js      # validates compile + deploy + call + revert decoding
└── harness/           # named 'harness' because the repository gitignores **/lib
    ├── compile.js     # solc-js + repo remappings, no network
    └── evm.js         # @ethereumjs/vm: deploy, call, expectRevert, timestamps, storage
```

```bash
cd tools/critical
npm install
node smoke.test.js     # expect: sizes, views, decoded revert, "Harness OK"

node -e "
const {compile} = require('./harness/compile');
const {Evm} = require('./harness/evm');
(async () => {
  const evm = await Evm.create();
  const V = compile('src/CollateralVault.sol')['src/CollateralVault.sol:CollateralVault'];
  const v = await evm.deploy(V);
  console.log('deployed', v.createdAt, (await evm.code(v.address)).size, 'bytes');
})();"
```

Notes: timestamps are controlled with `evm.setTimestamp` / `evm.advance` (needed for `withdrawDelay` and JPY staleness); custom errors decode through the contract ABI, with `Error(string)` and `Panic(uint256)` handled explicitly; state is inspected with `evm.storage(addr, slot)` when a getter does not exist. When Foundry becomes available, port the same PoC to `test/critical/` — the assertions, not the harness, are the deliverable.

---

## 8. Definition of done

The workflow is complete when **all ten targets have a written verdict** in the register, each with either a runnable PoC or a one-paragraph kill rationale, and the survivor set has been checked against the baseline commit and the 21 prior findings. Zero confirmed critical bugs is a legitimate and valuable outcome — provided the register shows *why each one is closed*, not just that nobody found anything.
