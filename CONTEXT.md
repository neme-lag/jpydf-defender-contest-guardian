# JPYdf — Protocol Context Brief

**Purpose.** A single consolidated briefing on the JPYdf / "JPY DeFi" protocol, assembled from
`README.md`, `SCOPE.md`, `docs/protocol/**` (product overview + component specs), the audit
package under `docs/audit/**`, `docs/known-issues.md`, and a cross-check against
`packages/contracts/src/**`.

**Audience.** Anyone about to audit, review, or build on this repository — in particular a
Guardian Defender contest participant who needs the protocol model in their head before reading
the 171 in-scope hunks.

**Date compiled.** 2026-10-30. Repository state: branch
`arena/d0623667-jpydf-defender-contest-guardia`, forked from `main` at `295c9f1`
("Add original audit documentation").

---

## 0. How to read this document (and how much to trust each claim)

Claims here are graded by evidence source, because the packaged documentation is **not uniformly
current**:

| Tier | Source | Trust |
| --- | --- | --- |
| 1 | `packages/contracts/src/**/*.sol` | Ground truth. Behavior claims were spot-checked here. |
| 2 | `SCOPE.md` | Authoritative for *what is in scope* and *what is excluded*. |
| 3 | `docs/audit/SOURCE_OF_TRUTH.md`, `FINAL_PRODUCTION_ENGLISH_AUTHORITY.md` | Authority ordering and explicit errata for otherwise-stale copied text. |
| 4 | `docs/protocol/spec/*.md`, `docs/protocol/Parameters.md` | Normative intent for behavior and parameters — but some sections lag the deployed source (see §13). |
| 5 | `docs/protocol/Product-Overview.md` | System-level intent, requirements IDs, architecture principles. |
| 6 | `docs/audit/history/**`, prior reports, remediated-finding narratives | Historical. Useful provenance; not current requirements. |

Two hard rules that follow from the package itself:

- **The Solidity wins.** If a spec disagrees with the implementation, the implementation is
  correct for the core (explicitly stated in the core spec §2.4) and should be treated as the
  review target for extension layers too.
- **Eligibility is controlled by the contest scope, not by the documentation set.** See §12.

**Known gaps in this checkout.** The audit package cross-references paths that are **not present
in this repository**: `docs/en/**`, `evidence/**`, `FINAL_PRODUCTION_HUNK_PROVENANCE.tsv`,
`FINAL_PRODUCTION_ARTIFACTS.tsv`, `FINAL_PRODUCTION_STORAGE_LAYOUTS.tsv`, `scripts/**`,
`config/day1-branch-manifest.json`, and the deployment scripts (`DeployLiquity2`). Treat those
references as pointers to the upstream audit repository, not as files you can open here.

---

## 1. Executive summary — the 20 facts that matter most

1. **JPYdf is a JPY-denominated, overcollateralized CDP stablecoin** built as a **base-parity fork
   of Liquity v2 (BOLD v1.11.0)**, with four DeltaForesight extension layers bolted on *outside*
   the core: dToken, Strategy, Oracle, Zapper.
2. **The core is a sealed box.** It depends on exactly two generic interfaces — an 18-decimal
   collateral ERC-20 (which is **dToken**, not the real asset) and a price feed (which is
   **PriceFeedProxy**, not Chainlink) — plus the `JpydfToken` debt token. (`ARCH-001`/`ARCH-003`,
   `SYS-CON-002`.)
3. **dToken is the collateral the core sees**: an 18-decimal ERC-20 that is a 1:1 principal claim
   on a real "Underlying" (wstETH, USDC, …), minted/burned only by the per-asset
   `CollateralVault`.
4. **Collateral is deployed to external venues** (Aave v3, ERC-4626/Morpho, Sky sUSDS, …) to earn
   protocol revenue. The **push model** applies: Strategies push principal and yield *back* to the
   Vault; the Vault never pulls.
5. **Yield does not accrue to dToken holders.** Protocol revenue goes to Treasury; the Stability
   Pool earns 75% of borrowing interest, PIL gets 25%. If a Strategy loses money, dToken
   *depegs down* via `backingRatio()`.
6. **Backing impairment is propagated into prices**: every collateral price is
   `collateral/USD ÷ JPY/USD × min(1, backingRatio)`. The Oracle only *reads* the ratio; all value
   accounting lives in the Vault.
7. **All prices are JPY-denominated**, synthesized from Chainlink `collateral/USD` and a single
   shared Chainlink `JPY/USD` feed (which returns **USD per JPY**, ≈0.006667 — hence division).
8. **Oracle failures are a recoverable pause, not a shutdown.** A separate, irreversible branch
   shutdown happens only on `TCR < SCR`, which enables **urgent redemption** at a dedicated price
   consumer.
9. **There are two distinct fail-closed philosophies in the oracle layer**: collateral/peg/
   canonical-rate leg failure → branch oracle pause; shared JPY/USD leg failure → bounded
   **24-hour soft-freeze** on the last good rate, then pause.
10. **A 30-hour JPY-round-age gate** now applies to normal redemption *and* to BorrowerOperations
    price use; liquidation keeps a 30h threshold plus up to 24h cached-rate grace. Stale-but-newer
    rounds can re-anchor the freeze episode (known risk `KR-01`).
11. **Two of eight branches are active on Day 1**: Branch 0 = dwstETH/wstETH (cap ¥35M),
    Branch 1 = dUSDC/USDC (cap ¥100M). Branches 2–7 are inert placeholders with cap 0 and
    unfinalized risk parameters.
12. **Reserved-branch risk parameters are finalized exactly once** by a dedicated finalizer role,
    atomically across `AddressesRegistry` + `BorrowerOperations` + `TroveManager`. A finalized
    mistake is permanent (`CORE-MOD-013`, `KR-09`).
13. **Role design is asymmetric**: brakes are fast, releases are slow. GUARDIAN can pause and
    neutralize immediately; unpause and every risk increase go through the **shared 12h
    Timelock**; immediate markdown (`WRITEOFF_ROLE`) is deliberately *not* timelocked but is
    guarded by a post-operation backing-ratio floor.
14. **`MIN_DEBT = 100_000e18` (100k JPY)** system-wide — an anti-dust *and* state threshold
    (zombie boundary, repayment clamp), not just an entry floor (`CORE-MOD-002`, `KR-15`).
15. **The deployed Stability Pool is `DFStabilityPool`**, a full copy of upstream with exactly four
    additions for same-block collateral-gain/withdrawal sniping (`CORE-MOD-004`). Upstream
    `StabilityPool.sol` is retained as the parity norm.
16. **Liquidation is a three-layer waterfall**: SP offset → JIT deposits → redistribution to other
    Troves in the same branch. Liquidators get 0.5% of collateral (per-branch capped) + WETH gas
    compensation.
17. **`JpydfToken` is non-upgradeable, renounces ownership after `setCollateralRegistry`, and has a
    dormant, bridge-protocol-independent supply path** (`bridgeMint`/`bridgeBurn` + a minter
    registry with a **48h** propose/confirm timelock). Day-1 registered minters: **zero**.
18. **Only 25 Solidity files / 171 hunks / 535 changed-code nSLOC are eligible** in this contest,
    as a differential from `audit-baseline` → `final-commit`. Unchanged files are *context*, not
    scope.
19. **Two prior external audits and one AI-assisted remediation cycle** produced the known-issue
    list (10 Lows, 9 Informationals from Guardian's main review; 4 items have non-code
    dispositions). Known ≠ accepted ≠ out of scope: you may re-report any of them.
20. **The two highest-signal review surfaces** are (a) the **Vault ↔ Oracle ↔ Core** seam where
    backing/valuation availability changes collateral price, and (b) the **oracle source
    lifecycle** (`PriceFeedProxy` propose/confirm, emergency bypass, caches, JPY provenance).

---

## 2. What this repository is

From `README.md`:

> DeltaForesight's JPYdf smart contracts, extracted for the Guardian Defender contest.

Contents:

| Path | What it holds |
| --- | --- |
| `packages/contracts/src/` | The **final production source tree** (`contracts/src`), ~110 `.sol` files, ~21k lines. |
| `packages/contracts/test/` | A deliberately small test set: only selected oracle behavior (`DFWstETHPriceFeed.t.sol`, `JpyUsdRateProvider.t.sol`, `PriceFeedPlaceholder.t.sol`, `PriceFeedProxySourceValidation.t.sol`). |
| `packages/contracts/setup.py` | Installs the five pinned public dependencies from `foundry.lock` (frameworks are *not* vendored). |
| `SCOPE.md` | The client's historical main-review statement of work (baseline `d4122704` → final `1b453c10`, 171 hunks). |
| `docs/review-boundaries.md` | **Contest scope rule**: eligibility = baseline→final changes in listed files. |
| `docs/contracts-scope.md` | The 25 in-scope Solidity files. |
| `docs/known-issues.md` | Previously reported findings + final status. |
| `docs/protocol/` | Product overview, Day-1 parameter manifest, and nine component specs. |
| `docs/audit/` | Handoff, known-risk register, oracle remediation history, market-hours analysis, build/test, evidence checklist, dependency graph, and dated history. |

Not present here: deployment scripts, config manifests, frontend, subgraph, bots, evidence
bundles. Anything that depends on deployment wiring is therefore **launch evidence owned by the
project**, not something a reviewer can verify from this checkout.

### 2.1 Contest mechanics worth internalising

- Scope is **differential**: the *baseline-to-final changes* in the listed files, "including their
  interactions with unchanged code". Findings must **reproduce at the final commit**. Issues
  independent of those changes are out of scope.
- The doc names three checkpoints: `audit-baseline` = `b5265f31`, `main-reviewed` = `2725216e`,
  `final-commit` = `f65374b4`.
- Size: 25 files, 171 hunks, `+745/-185` physical lines, **535 changed-code nSLOC** (`cloc 2.06`),
  with **6,656 whole-file nSLOC as context only**.
- "Required context" is explicitly in-bounds: unchanged callers, dependencies, inherited behavior,
  routing and external-return assumptions needed to judge an included change. The canonical
  example given: `DFUSDCPriceFeed.sol` is unchanged, but its behavior changes through the included
  `DFPriceFeedBase` inheritance.
- Tests, specs, build inputs and deployment files are **supporting material**, not review targets.

---

## 3. Protocol in one page

**Problem.** A Japanese-yen stablecoin needs (a) JPY-denominated collateral pricing, (b) collateral
that can earn yield in external venues, and (c) support for non-18-decimal collateral — none of
which Liquity v2 natively provides.

**Solution.** Keep Liquity v2 exactly as-is and supply it with substitutes:

```
                    ┌──────────────────────────────────────────────┐
   users ─────────► │  Zapper (stateless, optional UX router)       │
                    └───────────────┬──────────────────────────────┘
                                    │ deposit Underlying → dToken
                                    ▼
   ┌───────────────────────────────────────────────────────────────┐
   │ dToken layer (UUPS, per asset)                                │
   │   CollateralVault: custody · mint/redeem · buffer · backstop  │
   │                   delayed redemption · allocation · Treasury  │
   │   dToken: 18dec 1:1 principal claim, mint/burn = Vault only   │
   └───────────────┬───────────────────────────────┬───────────────┘
                   │ allocate ↓ / push ↑          │ collateral (dToken)
                   ▼                               ▼
   ┌──────────────────────────────┐   ┌───────────────────────────────────┐
   │ Strategy layer (UUPS)        │   │ 🔵 Liquity v2 Core (sealed box)   │
   │  1 instance = 1 Underlying   │   │  BorrowerOperations · TroveManager│
   │             = 1 venue        │   │  StabilityPool/DFStabilityPool    │
   │  Aave · ERC4626/Morpho · Sky │   │  Active/Default/CollSurplus/Gas    │
   └──────────┬───────────────────┘   │  SortedTroves · TroveNFT ·         │
              │ supply/withdraw       │  CollateralRegistry · HintHelpers  │
              ▼                       └──────┬──────────────┬─────────────┘
   ┌──────────────────────┐                  │ price        │ debt token
   │ external venues      │        ┌─────────▼───────┐  ┌───▼──────────┐
   │ Aave v3, Morpho, Sky │        │ PriceFeedProxy  │  │ JpydfToken   │
   └──────────────────────┘        │ → DF PriceFeed  │  │ (JPYdf,      │
                                   │ → Chainlink     │  │  bridge-ready)│
                                   └─────────────────┘  └──────────────┘
```

**Actors** (`Product-Overview` §2): borrower, dToken holder, SP depositor ("earner"), redeemer/
arbitrageur, liquidator, ALLOCATOR operator, governance (GOV multisig + shared Timelock),
GUARDIAN, WRITEOFF, bridgeAdmin/bridgeMinter.

**Per-branch markets.** One branch = one collateral asset with its own BorrowerOperations,
TroveManager, SP, ActivePool, DefaultPool, CollSurplusPool, GasPool, SortedTroves, TroveNFT,
AddressesRegistry and PriceFeed. Singletons shared across branches: `JpydfToken`,
`CollateralRegistry`, `HintHelpers`, `MultiTroveGetter`, `DebtInFrontHelper`, `RedemptionHelper`,
`InterestRouterForwarder`, and the `JpyUsdRateProvider`.

---

## 4. Architecture principles (`ARCH-*`, `SYS-CON-*`)

| ID | Principle | Practical consequence for review |
| --- | --- | --- |
| `ARCH-001` | **Core parity / ledgered delta.** Stay outside core; manage permitted diffs in the `CORE-MOD-*` ledger; forbid reintroduction of BOLD names via a CI surface guard. | Any behavior change inside a core file must map to a ledger entry. |
| `ARCH-002` | **Separation of responsibilities.** Each layer is ignorant of the others' internals. | Core must not learn about Underlying/Strategies/Zapper. Vault must not learn core logic. Oracle must not own value accounting. |
| `ARCH-003` | **One-way dependencies.** Core's only external deps are dToken + PriceFeedProxy. | If a review fix needs a core change to accommodate an extension, it is the wrong fix. |
| `ARCH-004` | **Changes stay outside.** Strategy replacement, oracle source replacement, Zapper changes never touch core. `mint`/`burn` remain core-only; bridge supply is isolated. | |
| `ARCH-005` | **Zapper is auxiliary.** Core and dToken layer each work standalone. | Zapper bugs must not be able to corrupt protocol accounting. |
| `ARCH-006` | **Explicit extension boundary.** Future extensions = UUPS upgrade, setter/whitelist addition, reference switch, or redeployment-scale change. | Adding a branch or changing finalized risk params is *redeployment*, not upgrade. |
| `SYS-CON-001` | Core keeps base parity + canonical JPYdf surface. | |
| `SYS-CON-002` | Core depends on only 2 external interfaces. | |
| `SYS-CON-003` | Collateral is 18-decimal ERC-20. | Non-18dec Underlying must be wrapped by dToken's `_decimalMultiplier`. |
| `SYS-CON-004` | `JpydfToken` non-upgradeable; `mint`/`burn` core-only; bridge isolated. | |
| `SYS-CON-005` | Chain/branches/bridge routes fixed by approved Decision/Manifest per release. | Unapproved surfaces must not be exposed. |

---

## 5. The Liquity v2 core, as inherited (`CORE-*`)

Normative source: `docs/protocol/spec/Liquity-v2-Core-Spec.md` (5,521 lines). Normative *code*
baseline: upstream `liquity/bold` v1.11.0 branch `base`.

### 5.1 Mechanisms

- **Branch** — independent market per collateral, so one collateral's failure does not propagate
  through SP/TroveManager/PriceFeed of another. *Limit:* all branches share the JPYdf debt token,
  so correlation risk through JPYdf impairment is outside the isolation boundary (`SYS-INV-004`).
- **Trove** — ERC-721 position (`troveId = keccak256(msg.sender, owner, ownerIndex)`); states
  nonExistent / active / closedByOwner / closedByLiquidation / **zombie**. Opening locks WETH gas
  compensation into `GasPool`, fixed in WETH even for non-ETH collateral.
- **User-set interest rates** — free within `[MIN_ANNUAL_INTEREST_RATE, MAX_ANNUAL_INTEREST_RATE]`
  (`0.5%`–`250%` in `Dependencies/Constants.sol`); aggregate interest is O(1) (weighted debt sum ×
  elapsed time), minted during core operations and split **75% SP / 25% interestRouter**
  (`SP_YIELD_SPLIT = 75%` in `Dependencies/Constants.sol`).
- **Upfront / premature-adjustment fee** — new borrowing and in-cooldown rate changes add
  "branch average rate × 7 days" to debt; economically discourages low-rate gaming.
- **Redemption** — anyone exchanges JPYdf for ¥1 of collateral. `CollateralRegistry` routes across
  branches proportional to *unbacked* debt; within a branch it hits **lowest APR Troves first**.
  Fee = `baseRate` spike + decay (6h half-life). A Trove pushed below `MIN_DEBT` becomes a
  **zombie** and leaves SortedTroves; the next redemption prioritizes `lastZombieTroveId`.
- **Liquidation** — anyone liquidates `ICR < MCR`:
  1. **SP offset** (collateral + SP penalty to depositors),
  2. **JIT** (liquidator deposits JPYdf into SP on the spot),
  3. **Redistribution** (last resort, higher penalty, pro-rata to healthy Troves in the branch).
  Liquidator gets 0.5% of collateral (per-branch cap) + WETH gas compensation; borrower surplus
  sits in `CollSurplusPool`.
- **Stability Pool** — deposit JPYdf, earn 75% of interest + liquidation collateral; P-S-B
  product/sum accounting in O(1). **Deployed variant is `DFStabilityPool`** (see §6.8).
- **Safety devices** — MCR / CCR (new-borrow restriction) / SCR. `TCR < SCR` ⇒ **irreversible**
  economic shutdown, interest stops, **urgent redemption** opens. Oracle failure instead ⇒
  **recoverable** pause. During the pause, interest keeps accruing; normal redemption and
  risk-increasing actions stay blocked; collateral additions and pure repayments proceed without a
  price quote (`CORE-MOD-014`).
- **Delegation** — AddManager (deposit side), RemoveManager + fixed receiver (withdraw side),
  per-Trove interest delegate, and BatchManager (O(1) bulk rate changes, management fee).
- **PIL** — the 25% interest residual is minted to the immutable `interestRouter`, which here is
  `InterestRouterForwarder`; it flushes to a mutable `recipient` (§6.7).

### 5.2 The `CORE-MOD-*` delta ledger (all DF changes to core)

| ID | File(s) | Delta |
| --- | --- | --- |
| `CORE-MOD-001` | debt-token naming surface | `BoldToken`/`boldToken`/`"BOLD"` → `JpydfToken`/`jpydfToken`/`"JPYdf"` |
| `CORE-MOD-002` | `Dependencies/Constants.sol` | `MIN_DEBT` 2,000e18 → **100,000e18** |
| `CORE-MOD-003` | `Constants.sol`, TM constructor, finalization | liquidation collateral comp cap becomes per-branch `min(0.5% × SP-offset collateral, branch cap)` |
| `CORE-MOD-004` | `DFStabilityPool.sol` (new) | deployed SP copy + same-block settlement guard (4 functional additions) |
| `CORE-MOD-005` | `Constants.sol` | 48 DF branch constants (Day-1 wiring) |
| `CORE-MOD-006` | `BorrowerOperations`/interface | `withdrawBold`/`repayBold` → `withdrawJpydf`/`repayJpydf` |
| `CORE-MOD-007` | `JPYdfTroveNFT`, metadata | JPYdf-branded NFT + on-chain SVG/JSON |
| `CORE-MOD-008` | `JpydfToken` | dormant bridge-ready supply surface (`bridgeMint`/`bridgeBurn`, registry, 48h timelock) |
| `CORE-MOD-009` | `JpydfToken.setBranchAddresses`/`setCollateralRegistry` | reject zero/codeless core addresses |
| `CORE-MOD-010` | core token transfer/approval sites | `forceApprove`/`safeTransfer`/`safeTransferFrom` hardening |
| `CORE-MOD-011` | `ActivePool` | aggregate accounting events (observability only) |
| `CORE-MOD-012` | `IPriceFeed`/`TroveManager` | **urgent redemption** gets a dedicated price consumer |
| `CORE-MOD-013` | `AddressesRegistry`/BO/TM/SP + interfaces | Timelock-only **one-shot** risk finalization for reserved branches; gates Trove opening & SP deposits |
| `CORE-MOD-014` | `BorrowerOperations` | pure collateral additions and repayments need no oracle read |
| `CORE-MOD-015` | `RedemptionHelper` | reflect normal-redemption failure flag in `simulateRedemption`/`truncateRedemption` |

Everything else that "feels different from Liquity" is a consequence of *what is plugged in*
(dToken as collateral, JPY prices, JPY-denominated redemption), not a core change.

### 5.3 Shutdown state machine (cross-layer, worth drawing)

```
                 normal ──oracle failure true──► ORACLE PAUSE (recoverable)
                   │  ▲                              │  │
      TCR < SCR    │  │ Owner resumeFromOracleFailure │  │ live normal price
      (one-way)    ▼  │ (3 quote paths healthy)       ▼  │ recovers
                 SHUTDOWN ◄── live TCR<SCR eval ── (liquidation, TCR eval,
                 (urgent redemption,                 close, coll add, repay
                  interest stops)                    allowed pre-resume)
```

Key asymmetry: **a price with `failure = true` can never cause terminal shutdown**, and a recovered
live price can drive permissionless `TCR < SCR` shutdown *before* Owner resume (`KR-02`).

---

## 6. The extension layers in depth

### 6.1 dToken (`DToken.sol`, UUPS)

- ERC-20, **always 18 decimals**; 1:1 claim on Underlying principal; **no yield, no rebasing**.
- `mint`/`burn` callable **only by its Vault** (`DTKN-SEC-001`); burn is allowance-independent but
  confined to the Vault.
- Conversion: `convertToDToken = amt × 10**(18-decimals)`, `convertToUnderlying = floor`. While
  unbound (`_decimalMultiplier == 0`) both revert `TokenInfoNotSet`.
- `setTokenInfo(name, symbol, underlying)` — one-shot; requires `totalSupply() == 0`, allowlisted,
  contract address, `decimals <= 18`. Binds name/symbol/underlying/multiplier atomically.
- `setAllowedUnderlying` — pre-binding allowlist (immutable after binding).
- `setCap` — supply ceiling; **a positive cap requires a bound registry with finalized risk
  params** (`_requireRiskParamsFinalized()`), and every mint re-checks it. Closing cap to 0 and
  burning stay available. This is the L-01 remediation: cap opening can no longer block risk
  finalization.
- `setRiskParamsRegistry` — once, while cap and supply are zero; registry must return this token
  from `collToken()`.
- EIP-2612 permit; EIP-712 domain follows the actual `name()`; 2-step ownership; renounce disabled.
- **`mintCap` is a supply cap, not a branch debt ceiling** (`KR-11`): it does not stop new JPYdf
  debt against dToken already held.

### 6.2 CollateralVault (`CollateralVault.sol`, UUPS) — the accounting centre

**Responsibility.** Custody Underlying; mint/burn dToken; liquid buffer; allocation to Strategies;
push receipts; protected backstop reserve; delayed redemption queue; Treasury yield transfer;
Strategy registry/valuation; deferred Underlying binding; 4 pause flags.

**The four quantities to keep straight:**

| Symbol | Name | Formula | Used for |
| --- | --- | --- | --- |
| `A` | total assets | `underlying.balanceOf(vault) + Σ min(est_i, principal_i)` (fresh cache on valuation failure; stale/absent = 0) | `backingRatio`, solvency |
| `A_confirmed` | confirmed assets | raw balance + Σ **live** `min(est_i, principal_i)`; **never cache**; unreadable Strategy = 0 | pre-state guard on user flows |
| `M` | managed assets | `bufferBalance() + Σ live min(est_i, principal_i)`; excludes backstop reserve; **any unreadable registered Strategy ⇒ `M = 0`** | `allocate`, Treasury sweep |
| `L_effective` | effective liabilities | `convertToUnderlying(dToken.totalSupply())` (rounded up for dust) **+ `pendingWithdrawals`** | solvency, `backingRatio` |

Derived rules:

- `backingRatio = min(1e18, A × 1e18 / L_effective)`, downward-only; `1e18` when `L_effective == 0`.
- `backingRatioForPricing() → (ratio, available)`: returns `(1e18, true)` when known conservative
  assets already cover liabilities even if another Strategy is unreadable; `(0, false)` when
  coverage is insufficient and a registered Strategy has neither live value nor fresh cache.
- `backingShortfall = max(L_effective − A, 0)`; `backstopRequiredForRatio(target)` rounds up.
- Treasury surplus `= M − L_effective`, further clamped by `bufferBalance() − (buffer target +
  pendingWithdrawals)`.

**Function surface (spot-checked in `src/CollateralVault.sol`):**

| Function | Authority | Notes |
| --- | --- | --- |
| `deposit(amount)` | permissionless | balance-delta accounting; mints `convertToDToken(received)`; pre-state `A_confirmed >= L_effective`; cap enforced on dToken side |
| `redeem(dTokenAmt, receiver)` | permissionless | exact-unit check (`InvalidDTokenAmount` for dust); pre-state backing; burn then pay; if buffer short → pay all buffer + queue remainder |
| `redeemWithPermit(...)` | permissionless | same, burns from `this`; permit front-run tolerant |
| `claim(requestId)` | permissionless trigger | payout fixed to `request.owner`; matured + backing + buffer needed; idempotent on re-call |
| `allocate()` | `ALLOCATOR_ROLE` | cooldown; `M==0` early return; target buffer `max(M·bps/10k, floor) + pendingWithdrawals`; per-Strategy cap + weight; post-check full backing |
| `receiveFromStrategy(declared)` | registered Strategy | balance-delta credit; exact delivery reduces cache, mismatch invalidates cache, never refreshes TTL |
| `backstopDeposit(amount)` | permissionless | no dToken minted; protected reserve; not in buffer |
| `releaseBackstopToBuffer(amount)` | `GOV_ROLE` | accounting move only |
| `transferYieldToTreasury()` | `TREASURY_TRANSFER_ROLE` | see §13 for role drift |
| `addToWhitelist` / `addStrategy` / `updateStrategy` | `GOV_ROLE` | contract + underlying equality + weight ≤ 10000 + `MAX_STRATEGIES = 32` |
| `removeFromWhitelist` / `emergencyDisableStrategy` / `removeStrategy` | `GUARDIAN_ROLE` | removal needs `principal == 0` **and live `est == 0`** |
| `writeoffStrategyPrincipal(strategy, amount, minRatioAfter)` | `WRITEOFF_ROLE` | book only, no transfer; post-writeoff backing floor reverts whole tx |
| `forceDeallocateMorphoV2(...)` | `WRITEOFF_ROLE` | realizes Morpho penalty + recovery to Vault + same-tx pauses + backing floor |
| pauses / unpauses | GUARDIAN / `GOV_ROLE` | 4 independent flags: deposit, redeem, claim, allocation |
| `setBufferConfig` / `setAllocatorConfig` / `setStrategyValuationMaxAge` / `setStrategyValuationGasBudget` / `setWithdrawDelay` / `setTreasury` | `GOV_ROLE` | `withdrawDelay ≤ 30 days`; `bufferTargetBps ≤ 10000` |
| `refreshStrategyValuation` | permissionless | writes live `min(est, principal)` into bounded cache |
| `invalidateStrategyValuationCache` | `GOV_ROLE` | |
| `setUnderlying` | `GOV_ROLE` | one-shot, dToken-first, allowlisted |

**Buffers, backstop and the "stop the bleed" guard.**

- `bufferBalance = max(underlying.balanceOf(vault) − backstopReserve, 0)`; placeholder-safe (0 when
  underlying unset).
- `backstopDeposit` repairs `A` **without minting liabilities**, so `backingRatio` recovers and
  user flows restart automatically — but the reserve cannot pay redeemed claims until GOV calls
  `releaseBackstopToBuffer`.
- **`VAULT-SEC-010`**: `deposit`/`redeem`/`redeemWithPermit`/unsettled `claim` all require
  cache-free `A_confirmed >= L_effective` *before* any token/queue mutation. This is the on-chain
  automatic stop when a Strategy loss becomes visible, independent of the Guardian.

**Delayed redemption (design intent).** First-come-takes-all: the current buffer goes to the
caller, the shortfall becomes a `WithdrawRequest{owner, underlyingAmount, claimableAt, claimed}`
with `withdrawDelay` (Day-1: 3 days). Queue is in Underlying base units (no dToken dust).
`pendingWithdrawals` is simultaneously a liability and a liquidity reservation.

**Strategy valuation cache.** `min(est, principal)` is cached with `updatedAt`. On a live read
failure the cache is usable only within `strategyValuationMaxAge` (default 1 day; 0 disables).
Partial recoveries reduce the cache but **do not advance `updatedAt`** (previously Chain
Defenders L-03, `Acknowledged`); an exhaustive receipt **invalidates** the cache (Guardian L-10).
`available == false` is treated by the Oracle as oracle failure, not as measured zero.

**Pause philosophy.** Four independent flags let operations do things like "stop new inflow, keep
exits open". Claim is pausable despite the backing guard because the guard cannot express
"valuation is wrong" or "investigate now"; the cost (freezing vested liabilities, ≥12h to unpause)
is explicitly acknowledged.

### 6.3 Strategy layer (`Strategies/`, UUPS)

- `IStrategy` + `BaseStrategy`: `deposit`, `sendToVault` (principal), `sendProfitToVault` (yield),
  `writeoffPrincipal`, `emergencyWithdraw`, `sweepRewardToken`, `claimMerklRewards`,
  valuation getters (`principal`, `realizedYield`, `estimatedTotalUnderlying`).
- **1 instance = 1 Underlying = 1 external venue.** Venue addresses are frozen at `initialize`
  (no `setPool`/`setVault`); changing venue = deploy new Strategy + Vault re-registration.
- **Push model + reversed approval**: Strategy max-approves the Vault; the Vault pulls with
  `safeTransferFrom`.
- **Self-managed `principal`**, decremented by what the Vault *actually received*.
- **Concrete adapters**: `AaveV3Strategy`, `ERC4626Strategy` (Morpho/Euler-style),
  `MorphoV2Strategy`, `SkyUsdcSUsdsStrategy` (+ converter); archive: async request strategies,
  Lido, Etherfi, weETH adapter.
- **Async venues** are absorbed inside the Strategy (`_doWithdraw` returns whatever is immediately
  withdrawable; pending requests valued at `pendingWithdrawalValuationBps`, default 10000, which
  `WRITEOFF_ROLE` may lower only while allocation is paused).
- **Reward tokens** (AAVE/Merkl) are *not* backing: swept to Treasury; position/receipt tokens are
  sweep-protected.
- Damage boundaries: compromised ALLOCATOR can only send to registered Strategies and pull back;
  compromised Owner cannot redirect the Vault destination (`emergencyWithdraw` fixed to Vault);
  upgrader is separate and timelocked.

### 6.4 Oracle layer (`PriceFeeds/`)

**Two-layer indirection**, because the core's oracle address is immutable:

```
Core (BO / TM / SP)  ──fixed address──►  PriceFeedProxy (Ownable2Step, NOT UUPS)
                                             │ delegate to replaceable `source`
                                             ▼
                        DF PriceFeed = upstream acquisition base
                                       + JpyFreezeLib (JPY conversion, freeze, backing)
                                             │
                                             ▼
                        Chainlink (collUsd, jpyUsd, aux legs) + canonical rate providers
```

**Price formula** (normal path):

```
collJpy  = collUsd × 1e18 / jpyUsdRate          // jpyUsdRate = USD per JPY
price    = collJpy × min(1e18, backingRatio) / 1e18
```

**Per-collateral patterns:**

| Pattern | Used by | Composition |
| --- | --- | --- |
| Standard | dUSDC (active), WETH-like | `collUsd` direct |
| Market / canonical composite | dwstETH (active) | `stETH/USD × wstETH.stEthPerToken() / JPY/USD × backing` |
| Composite rate | sUSDS (archived candidate) | `USDS/USD × sUSDS.convertToAssets(1e18)` |
| Peg-monitored | WBTC (archived candidate) | `min(WBTC/BTC × BTC/USD, BTC/USD)` normal; `max(…)` inside 2% band on redemption |
| Placeholder | branches 2–7 | `PriceFeedPlaceholder` returns `(1e18, false)` + synthetic fresh JPY provenance |

**dwstETH specifics (`DFWstETHPriceFeed`, `ORCL-FR-015`):**

- Normal / liquidation / urgent: direct `stETH/USD` (staleness `PRM-ORACLE-003`), ×
  `stEthPerToken()` (no staleness concept), ÷ JPY, × backing.
- **Redemption** (normal and urgent): `max(stETH/USD direct, ETH/USD × stETH/ETH)` then canonical
  rate, JPY, backing — **no 1% divergence gate**. Deliberate solvency-protective polarity; a
  policy-valid stale-high leg can underpay a redeemer (`KR-04`).
- Canonical-rate growth is native wstETH appreciation → stays in borrower collateral value, not
  Treasury yield.

**Shared JPY leg (`JpyUsdRateProvider` + `JpyFreezeLib`):**

- ONE provider per deployment, injected into every active feed; holds `lastGoodJpyRate`,
  `lastGoodJpyUpdatedAt`, `jpyFrozenSince`, `jpyFreezeExpired`.
- Live fresh round ⇒ adopt and clear episode. Unhealthy round ⇒ keep last good rate, start/continue
  a **24h max freeze** (`MAX_JPY_FREEZE_DURATION`). Expired ⇒ oracle failure.
- Runtime `decimals()` must equal the constructor-pinned 8 before any fresh *or* stale-newer round
  is adopted; mismatch/read failure invalidates without scaling or caching; gas-exhaustion
  re-reverts.
- Staleness threshold is a constructor parameter (Parameters manifest `PRM-ORACLE-001` = 108,000s;
  the included provider test fixture uses 72h — see §13).

**PriceFeedProxy lifecycle (`ORCL-FR-001..007`):**

| Step | Rule |
| --- | --- |
| `proposeSource` | Owner only; non-zero contract; rejects a direct `IPriceFeedProxy.source()` marker; ≠ current; records `readyAt = now + 12h` |
| `confirmSource` | ≥ 12h; smoke-tests **all three** paths of the new source; validates `jpyUsdRateProvider()` + `lastGoodJpyUpdatedAt()` via bounded 30k-gas 32-byte staticcalls; requires new quote within **1%** of old live/cached reference (all three paths); re-inits `_lastGoodPrice`; updates `_lastGoodRedemptionPrice` only with fresh JPY provenance |
| `confirmSourceEmergency` | Same 12h + three-path smoke test, **never calls the old source**, bypasses all three deviation guards together (`KR-05`) |
| `cancelSourceProposal` | Owner; clears pending |
| `renounceOwnership` | always reverts |

**Consumer behavior.**

- `fetchPrice()` (normal): on source revert/invalid/`failure=true` → Proxy itself calls
  `borrowerOperations.shutdownFromOracleFailure()` (it is the registered feed, so `msg.sender`
  check passes) and returns its own `_lastGoodPrice`. Gas-guard revert
  (`InsufficientGasForExternalCall`, exactly 4 bytes) is **re-reverted untouched** so OOG is never
  mistaken for oracle failure.
- For the BorrowerOperations caller only, invalid/aged JPY provenance (`≥ 30h`) returns
  `(price, true)` **without latching the pause** — it gates borrowing, withdrawals, close, and new
  TCR/SCR shutdown decisions only.
- `fetchRedemptionPrice()`: same failure structure plus the **30h normal-redemption age gate**
  (`MAX_NORMAL_REDEMPTION_JPY_AGE`). Age/provenance failure returns a valid price with
  `failure = true` and **emits nothing** and **writes no cache**; a fresh first read clears the gate
  automatically.
- `fetchUrgentRedemptionPrice()`: exists only after irreversible shutdown; no cache, no direct-only
  fallback; Proxy **reverts** `UrgentRedemptionPriceUnavailable` on any failure. `TroveManager`
  consumes the price and ignores the bool — safe only under the required Proxy wiring (`KR-10`).
- `resumeFromOracleFailure()`: Owner only; requires all three current-source reads valid,
  non-sentinel, `failure == false`, in one transaction; always refreshes the normal cache, refresh
  redemption cache only with fresh JPY.

**Placeholder branches.** `PriceFeedPlaceholder` returns a healthy-looking `(1e18, false)`, so
inoperability comes from a **stack of guards**, not an oracle failure: Vault underlying unset →
`UnderlyingNotSet`; Vault/dToken mismatch; dToken `TokenInfoNotSet`; `cap = 0`; `riskParamsFinalized
== false` blocking Trove open and SP deposits.

### 6.5 Zapper (`Zappers/CollateralYieldZapper.sol`, immutable, stateless)

- One-tx UX over `Vault.deposit` + `BorrowerOperations`: open (raw ETH or Underlying, with optional
  permit + referral), add collateral, adjust, repay, withdraw collateral to Underlying, withdraw
  JPYdf, close to Underlying, plus a manager-authorized incident close to dToken (L-09).
- Holds dToken transiently; users never need to see or approve dToken.
- `LeftoversSweep` + `AddRemoveManagers` inherited from Liquity patterns; `nonReentrant`;
  slippage `min` params on withdrawals/close; approvals limited to trusted components.
- **Removed from Day-1 ABI**: flash-loan close, flash-loan callback, collateral-funded repay,
  Multiply, Balancer/Uniswap-v3 routes, WETH/Leverage zappers. `UniV4Exchange` is route *evidence*
  only, not a constructor dependency.
- Native-ETH on-ramp (ETH → stETH → wstETH → dwstETH) exists only where enabled at deployment; Lido
  referral is an immutable manager and `bytes32(0)` disables it (`KR-13`).

### 6.6 JpydfToken + bridge readiness (`CORE-BT-*`)

- Non-upgradeable ERC-20 + EIP-2612; `mint`/`burn` restricted to registered core surfaces;
  `setBranchAddresses` then `setCollateralRegistry` **renounces ownership** and permanently fixes
  the permission structure (one-way; a new branch needs redeploy).
- Dormant bridge surface: `bridgeAdmin` proposes/confirms/cancels/removes minters; **48h** timelock
  (`PRM-BRIDGE-MINTER-TIMELOCK`); `bridgeMint` mints, `bridgeBurn` self-burns. Separate from core
  supply paths; zero minters at Day-1 launch (`CORE-BT-INV-003`).
- Known boundary (`KR`/known-issue L-06): burn/mint bridging reduces the local supply-based
  redemption fee denominator without repaying branch debt — activation requires a new fee
  decision; lock/unlock bridging avoids this specific effect.

### 6.7 InterestRouter + PILAllocator

- `InterestRouterForwarder` (non-UUPS, immutable address bound as `interestRouter`): receives the
  25% PIL interest, `route()` permissionlessly flushes the **full** balance to the current
  `recipient`. Owner (shared Timelock) changes recipient; 2-step; renounce disabled. One instance
  shared by all branches; branch-level PIL must be reconstructed off-chain from
  `AggregateInterestMinted`.
- `PILAllocator` (Phase A, admin weights): splits received JPYdf across ≤32 initiatives
  (`IInitiative`, upstream-compatible 4 hooks) by admin weights; active weights must total exactly
  `1e18` or be all zero; below-threshold carry-over retained. `UniV4MerklInitiative` is the only
  Phase-A initiative (JPYdf/USDC Uniswap v4 via Merkl).
- **Day-1 default is deploy-ready but inactive**: recipient stays a PIL-dedicated address until an
  activation gate. Phase-B (token voting) is policy only, out of scope.

### 6.8 DFStabilityPool — the only deployed SP

Copy of upstream `StabilityPool` plus exactly four functional additions:

1. `mapping(address => uint256) public lastDepositBlock`;
2. collateral-gain claim in `provideToSP` requires a later block than the deposit block;
3. `lastDepositBlock[msg.sender] = block.number` after `DepositOperation`, before the state update;
4. `withdrawFromSP` requires `lastDepositBlock < block.number`.

Rationale: prevent same-block deposit → liquidation gain capture → withdraw sniping. ABI differs
only by the added getter. Both SP implementations also reject `provideToSP` on an unfinalized
reserved branch (`CORE-MOD-013`).

---

## 7. Roles, governance and timelocks

### 7.1 Timelock map

| Mechanism | Delay | Holder |
| --- | --- | --- |
| Shared `TimelockController` (Vault `GOV_ROLE`/`DEFAULT_ADMIN`, dToken Owner, Strategy `upgrader`) | **12h** (`PRM-GOV-COMMON-TIMELOCK-DELAY`) | GOV multisig proposes/executes; CANCELLER same admin |
| `PriceFeedProxy` source replacement | **12h** built into the contract (`TIMELOCK_DELAY`) | Proxy Owner = **GOV multisig directly**, not the Timelock (avoids double delay) |
| Bridge minter propose → confirm | **48h** | `bridgeAdmin` |
| GUARDIAN pause / neutralize / whitelist removal / strategy removal | **0** (immediate, reversible only) | Guardian multisig |
| WRITEOFF markdown / async pending-valuation bps | **0** (immediate, guarded by backing floor) | High-quorum GOV multisig directly |

### 7.2 Permission matrix (as implemented)

| Action | GOV (12h) | GUARDIAN | WRITEOFF | ALLOCATOR | WITHDRAWER | HARVESTER | TREASURY_TRANSFER | Anyone |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| deposit / redeem / claim / backstopDeposit | | | | | | | | ✅ |
| allocate | | | | ✅ | | | | |
| Strategy `sendToVault` (principal) | | | | | ✅ | | | |
| Strategy `sendProfitToVault` (yield) | | | | | | ✅ | | |
| transferYieldToTreasury | | | | | | | ✅ | |
| pause{Deposit,Redeem,Claim,Allocation} | | ✅ | | | | | | |
| unpause* | ✅ | | | | | | | |
| whitelist add / addStrategy / updateStrategy | ✅ | | | | | | | |
| removeFromWhitelist / emergencyDisable / removeStrategy | | ✅ | | | | | | |
| writeoffStrategyPrincipal / forceDeallocateMorphoV2 | | | ✅ | | | | | |
| setUnderlying / config setters / releaseBackstop / UUPS upgrade | ✅ | | | | | | | |
| refreshStrategyValuation | | | | | | | | ✅ |
| Oracle source propose/confirm/resume | Proxy Owner (GOV multisig) | | | | | | | |

⚠️ The **role split above is the code**, but the `CollateralVault.md` spec still describes a single
`ALLOCATOR_ROLE` for all four fund-movement functions. See §13.

### 7.3 Governance design intent

- Brake fast / release slow: GUARDIAN can stop or neutralize but never re-enable, unpause, or
  mark down.
- WRITEOFF is immediate because delaying a *confirmed* loss lets new borrowing continue against
  overstated collateral; abuse is bounded by high quorum, allocation freeze before downward
  markdown, Guardian `pauseRedeem`, and the fact that it moves no funds.
- `setCap` is a durable exposure limit, **not** an emergency lever; acute minting suspension is
  Vault `pauseDeposit`.
- Production role holders: Timelock (GOV/admin), `DF_ALLOCATOR`, Guardian multisig, high-quorum
  GOV multisig (WRITEOFF). Deployer retains nothing.

---

## 8. Day-1 parameters (`docs/protocol/Parameters.md`, status *Candidate*)

### 8.1 Branch scope

| Branch | dToken | Underlying | State | mintCap | allocateMaxMove | allocatorCooldown | withdrawDelay | bufferTargetBps | bufferFloor |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | dwstETH | wstETH `0x7f39…2Ca0` | active | ¥35M | 0 | 1800s | 259200s (3d) | 333 (3.33%) | 0 |
| 1 | dUSDC | USDC `0xA0b8…eB48` | active | ¥100M | ¥100M | 1800s | 259200s (3d) | 333 | 0 |
| 2–7 | dETH, dUSD-A, dBTC, dUSD-B, dJPY, dJGB | TBD | inert | 0 | 0 | 1800s | 259200s | 333 | 0 |

Branches 2–7: no bound Underlying, `PriceFeedPlaceholder`, cap 0, no Strategy, no Zapper,
`riskParamsFinalized = false` ⇒ cannot open Troves or take SP deposits.

### 8.2 Core risk parameters

| Branch | LLTV | MCR | CCR | SCR | BCR | SP penalty | Redistribution penalty |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 dwstETH | 81.18% | 123.18% | 141.67% | 110% | 10% | 5% | 10% |
| 1 dUSDC | 89.62% | 111.58% | 124.50% | 105% | 10% | 5% | 10% |
| 2–7 bootstrap | see manifest | | | | | | |

`MIN_DEBT = 100_000e18` protocol-wide. Liquidation collateral compensation:
`PRM-LIQ-KEEPER = min(0.5% × SP-offset collateral, branch cap)`; dwstETH cap `2e18`, dUSDC cap
`1_000e18` (matches `COLL_GAS_COMPENSATION_CAP*` in `Constants.sol`).

### 8.3 Oracle / governance values

| ID | Value | Meaning |
| --- | ---: | --- |
| `PRM-ORACLE-001` | 108000s (30h) | collateral/oracle staleness threshold |
| `PRM-ORACLE-002` | 7200s (2h) | dwstETH redemption-only ETH/USD reference |
| `PRM-ORACLE-003` | unfrozen | stETH/USD metadata + risk sign-off |
| `PRM-ORACLE-004` | unfrozen | USDC/USD metadata + risk sign-off |
| `PRM-ORACLE-006` | 86400s (24h) | cached-rate grace |
| `PRM-ORACLE-007` | 90000s (25h) | dwstETH stETH/ETH reference (24h heartbeat + 1h grace) |
| `PRM-ORACLE-008` | 108000s (30h) | normal-redemption + BO price-use age gate |
| `PRM-GOV-COMMON-TIMELOCK-DELAY` | 43200s (12h) | shared Timelock |
| `PRM-GOV-PRICE-FEED-SOURCE-DELAY` | 43200s (12h) | Proxy source delay |
| `PRM-BRIDGE-MINTER-TIMELOCK` | 172800s (48h) | bridge minter |
| `SP_YIELD_SPLIT` | 75% | SP share of aggregate interest |
| `MAX_JPY_FREEZE_DURATION` | 24h | code constant |
| `MAX_NORMAL_REDEMPTION_JPY_AGE` | 30h | code constant |
| `TIMELOCK_DELAY` (Proxy) | 12h | code constant |
| `MAX_SOURCE_SWITCH_DEVIATION_BPS` | 100 (1%) | code constant |
| `MAX_STRATEGIES` | 32 | code constant |

Manifest state remains **Candidate** until non-JPY oracle staleness inputs are frozen; displayed
Branch 2–7 risk values are **bootstrap safety values**, never public collateral terms.

---

## 9. Accounting identities and invariants

### 9.1 System invariants (`SYS-INV`)

| ID | Invariant |
| --- | --- |
| `SYS-INV-001` | Each Trove keeps `ICR ≥ MCR`; otherwise it is liquidated. |
| `SYS-INV-002` | dToken claim consistency: `A ≥ L_effective` (conservative, floored side). Impairment ⇒ `backingRatio < 1e18` ⇒ lower collateral price ⇒ core liquidation. |
| `SYS-INV-003` | Supply-path closure: core `mint`/`burn` core-only; bridge supply isolated to registered minters; manifest enumerates them. |
| `SYS-INV-004` | Branch isolation (limited): components isolated, but shared JPYdf debt means correlation risk escapes. |
| `SYS-INV-005` | Core delta boundary: only `CORE-MOD-*` diffs; BOLD names forbidden; `DFStabilityPool` is the deployed SP. |

### 9.2 Vault invariants (`VAULT-INV-001..014`, abridged)

- `A ≥ L_effective` in healthy state; `backingRatio` downward-only, `1e18` when `L_effective == 0`.
- Redeem: CEI order (exact-amount check → pre-state backing check → burn → transfer).
- Buffer-insufficient redeem: `immediate paid + queued == underlyingNeeded`;
  `pendingWithdrawals == Σ unclaimed requests`; claim pays only `request.owner`, idempotent.
- `totalUnderlying == raw balance + Σ conservative Strategy value` (live `min`, fresh cache
  fallback, stale/absent = 0); `bufferBalance` excludes backstop reserve.
- `allocate` moves ≤ `allocateMaxMove`, ≤ per-Strategy cap headroom, and must prove post-state
  `A_confirmed ≥ L_effective`; skipped amounts are never re-allocated.
- Disabled Strategy ⇒ `weightBps == 0`; `Σ weightBps ≤ 10000`.
- Placeholder Vault: all fund paths revert, views return 0, `allocate` early-returns.
- `backstopDeposit` changes neither supply nor `pendingWithdrawals`; `releaseBackstopToBuffer`
  changes neither `A` nor `backingRatio`.

### 9.3 Oracle invariants (`ORCL-INV`)

- Proxy address immutable; only `source` replaceable, only via 12h propose→confirm.
- Only strictly-4-byte gas-guard reverts pass through; everything else → shutdown path.
- All prices JPY; both legs normalized to 18 decimals.
- Both consumer paths apply backing symmetrically; `available == false` ⇒ oracle failure (never
  silently reuse `lastGoodBacking`).
- An aged quote never replaces `_lastGoodRedemptionPrice`; urgent never uses a cache.
- Active feed constructor reverts unless `priceSource == primary && lastGoodPrice != 0`.

---

## 10. Trust boundaries and threat model (`Product-Overview` §10)

| Target | Trust | Controls |
| --- | --- | --- |
| GOV multisig | Trusted | 2-step, 12h Timelock, disabled renounce, split emergency authorities |
| Chainlink | Trusted + failsafe | Staleness → lastGood → pause; three consumers validated |
| Lido wstETH rate | Trusted + failsafe | `stEthPerToken()` direct read; bad value ⇒ oracle pause |
| Strategy venues | **Limited** | Whitelist, conservative valuation, writeoff, emergency recovery fixed to Vault |
| bridgeAdmin / bridge minter | Trusted (minter fully) | Contract-only, non-overlapping, 48h timelock, zero at launch |
| Users (borrower/redeemer/liquidator/allocator) | Adversarial, economically aligned | Permissionless + economic alignment + MEV defenses |
| General callers | Adversarial | CEI, `nonReentrant`, validation, caps, pause |

**Top threat scenarios**: mass liquidation after a collateral depeg (limit of `SYS-INV-004`);
oracle manipulation/staleness; GOV key compromise; Strategy venue failure; semantic proxy cycle
(`KR-06`); joint oracle+governance outage blocking urgent exit (`KR-03`).

---

## 11. Known risks and prior findings

### 11.1 Project risk register (`docs/audit/KNOWN_RISKS_AND_CURRENT_POSITION.md`)

| ID | Risk | Position | Status |
| --- | --- | --- | --- |
| `KR-01` | Fresh `updatedAt` ≠ fresh FX discovery; stale-but-newer rounds re-anchor freeze | 30h gate is partial mitigation, not a market-hours gate | **Open** |
| `KR-02` | Live-price recovery restores permissionless `TCR < SCR` before Owner resume; resume is health check, not continuity proof | Retain Liquity wind-down | Retain, disposition pending |
| `KR-03` | Urgent redemption fails closed; joint oracle/governance outage delays exits | Price integrity over exit availability | Retain, disposition pending |
| `KR-04` | `max(direct, derived)` can underpay a redeemer when a leg is stale-high | Solvency-protective polarity; disclose fairness | Retain, disposition pending |
| `KR-05` | Emergency source confirmation bypasses all three deviation guards | Recovery path retained | Retain, disposition pending |
| `KR-06` | Forwarding cycle can pass the one-level marker | No callback latch; require reviewed dependency graph | Retain, disposition pending |
| `KR-07A` | Vault backing checks can stop user flows when live valuation unavailable | Retain fail-closed; keep repair paths open | Retain, disposition pending |
| `KR-07B` | Partial recovery does not renew cache TTL | Prior auditor `Acknowledged` (L-03) | Acknowledged |
| `KR-08` | Unreported external loss invisible to the backing guard | Caps, same-asset backstop, monitoring | Launch/integration |
| `KR-09` | Reserved-risk finalization permanent; cannot prove prerequisites | Keep one-shot; preflight + readback | Launch-blocking evidence |
| `KR-10` | Urgent redemption assumes every TM is wired to Proxy, not a direct source | Direct-source miswire is permanent | Launch-blocking evidence |
| `KR-11` | `mintCap` ≠ branch debt ceiling | Architecture boundary | Known boundary |
| `KR-12` | TM/BO are at/over EIP-170 headroom (remediation: BO 24,576 B = 0 margin; TM 24,568 B = 8 B) | Never downgrade a finding for size | Implementation constraint |
| `KR-13` | Zapper referral safety assumes canonical Lido stETH/wstETH + `submit(address)` | Prove deployed identity | Launch-blocking evidence |
| `KR-14` | Two generic price-feed defaults safe only under current topology | Reopen before divergent formulas | Future-change constraint |
| `KR-15` | `MIN_DEBT` 300k → 100k lowers several anti-dust/zombie boundaries | Retain, review every use | Retain, disposition pending |

### 11.2 Previously reported findings (`docs/known-issues.md`)

Main review: 9 Lows + 9 Infos, plus 2 remediation-review items. All Resolved or Acknowledged —
**Acknowledged ≠ Fixed**.

Highlights to know before duplicating work:

- `L-02` written-off Strategies can remain registered — **Acknowledged**, no code fix (deferred).
- `L-06` bridge burns increase redemption fees — **Acknowledged**, activation condition (0 minters).
- `I-07` ERC-4626 ceil-withdraw rounding can transfer principal to external shareholders —
  **Acknowledged**, venue-specific.
- `I-08` VaultV2 fee semantics could charge recovered losses — **Acknowledged**, venue-specific.
- `L-03` Morpho emergency recovery penalty without recovery — **Resolved** (now
  `forceDeallocateMorphoV2`: atomic deallocate + recover + pauses + backing floor).
- `L-08` unknown Strategy valuation pauses a fully covered Vault — **Resolved** (pricing ratio may
  be 100% when known assets cover liabilities).
- `L-10` exhausted cache misread as measured zero — **Resolved** (invalidate on exhaustion).
- `L-01` cap opening blocking risk finalization — **Resolved** (cap 0 + registry/finalization gate).
- `L-09` Zapper-only manager cannot incident-close — **Resolved** (close-to-dToken path).

### 11.3 Known structural boundaries worth restating

- **No SP replenishment of Vault losses.** The Stability Pool absorbs liquidations *after* the price
  falls; dToken backing repair is Strategy recovery → writeoff → `backstopDeposit` →
  `releaseBackstopToBuffer`.
- **No dedicated "backing shutdown" threshold.** Severe impairment only lowers price and lets
  existing liquidation/SCR machinery work.
- **No on-chain market-hours logic.** FX staleness is handled by thresholds on `updatedAt`.
- **Deployment is not verifiable here.** Proxy/source/dependency addresses, runtime hashes, role
  readbacks, Timelock history, alert delivery, and reserved-branch readback are project-owned
  launch evidence.

---

## 12. Contest scope, precisely

**Rule** (`docs/review-boundaries.md`): eligibility is limited to the **baseline-to-final changes
in the listed files**, *including their interactions with unchanged code*. Findings must reproduce
at the **final commit**. Issues independent of those changes are out of scope.

**In-scope file list** (`docs/contracts-scope.md`, 38 paths; 25 of them actually changed and are
counted in the 171-hunk SOW):

```
AddressesRegistry.sol                 Interfaces/IAddressesRegistry.sol
BorrowerOperations.sol                Interfaces/IBorrowerOperations.sol
CollateralVault.sol                   Interfaces/ICollateralVault.sol
DFStabilityPool.sol                   Interfaces/IDToken.sol
DToken.sol                            Interfaces/IJpyUsdRateProvider.sol
JpydfToken.sol                        Interfaces/IPriceFeed.sol
PILAllocator.sol                      Interfaces/IPriceFeedProxy.sol
RedemptionHelper.sol                  Interfaces/IRedemptionHelper.sol
StabilityPool.sol                     Interfaces/IStabilityPool.sol
TroveManager.sol                      Interfaces/IStrategy.sol
Dependencies/Constants.sol            Interfaces/ITroveManager.sol
Initiatives/UniV4MerklInitiative.sol
PriceFeeds/CompositePriceFeed.sol
PriceFeeds/DFPriceFeedBase.sol
PriceFeeds/DFWstETHPriceFeed.sol
PriceFeeds/JpyFreezeLib.sol
PriceFeeds/JpyUsdRateProvider.sol
PriceFeeds/MainnetPriceFeedBase.sol
PriceFeeds/PriceFeedPlaceholder.sol
PriceFeeds/PriceFeedProxy.sol
Strategies/AaveV3Strategy.sol
Strategies/BaseStrategy.sol
Strategies/ERC4626Strategy.sol
Strategies/MorphoV2Strategy.sol
Types/RiskParams.sol
Zappers/CollateralYieldZapper.sol
Zappers/archive/SkyUsdcSUsdsYieldZapper.sol
```

(`docs/contracts-scope.md` lists 38 eligible paths; the audit SOW measures **25 changed paths /
171 hunks / 535 changed-code nSLOC**. Not every listed path necessarily changed — the SOW's
25-path table is authoritative for the changed set, so confirm the diff rather than assuming all
38 moved.)

**Changed-behavior themes** (from `SCOPE.md` and the handoff):

1. Oracle: JPY runtime validation, three price paths, recovery/resume, freeze episodes, source
   lifecycle, 30h normal-redemption gate.
2. wstETH direct/derived redemption pricing + urgent wind-down.
3. `RedemptionHelper` failed-branch share/refund accounting.
4. Vault backing checks (raw-first, live-only Strategy values, fail-closed).
5. One-shot atomic reserved-branch risk finalization.
6. 100,000 JPYdf `MIN_DEBT` and its repayment/zombie boundaries.
7. Zapper referral / native-ETH behavior.

**Everything else** — deployment scripts, parameter selection, production wiring, role handover,
alerting, upstream venue re-audits — is explicitly outside the source review.

---

## 13. Where documentation and this source tree diverge (review-worthy)

These were found by spot-checking the specs against `packages/contracts/src`. Treat the code as
current and the spec as intent/history; if a hunk depends on one of these, say which you relied on.

| # | Observation | Evidence |
| --- | --- | --- |
| 1 | **Vault role model drifted.** `CollateralVault.md` specifies 5 roles and one `ALLOCATOR_ROLE` covering `allocate`, `Strategy.sendToVault`, `Strategy.sendProfitToVault`, `transferYieldToTreasury`. The code grants **8 roles** and splits duties into `ALLOCATOR_ROLE` (allocate), `WITHDRAWER_ROLE` (principal push), `HARVESTER_ROLE` (yield push), `TREASURY_TRANSFER_ROLE` (Treasury sweep). | `CollateralVault.sol:72–79, 224–231, 499`; `BaseStrategy.sol:335, 367`; `ICollateralVault.sol:232` |
| 2 | **`setStrategyValuationGasBudget`** exists in code/interface but is absent from the spec's setter list (the spec instead describes a fixed valuation gas bound in tests). | `CollateralVault.sol:799`; `ICollateralVault.sol:151` |
| 3 | **`claim` returns the claimed amount** in the interface, while the spec's signature shows no return value. | `ICollateralVault.sol:189` |
| 4 | **`initialize` default `bufferTargetBps = 2000` (20%)** vs Day-1 deployed value **333 (3.33%)**; defaults are overwritten during activation. Easy to mistake one for the other. | `CollateralVault.sol:216`; `Parameters.md` §3.2 |
| 5 | **JPY provider staleness value is a constructor input**, so no single number is canonical in the source: the manifest lists 30h (`PRM-ORACLE-001`), the included provider test fixture uses `72 hours`, and `KR-01`'s baseline text describes a "72-hour staleness policy". Verify the deployed value rather than quoting one. | `JpyUsdRateProvider.sol:28`; `test/JpyUsdRateProvider.t.sol:13`; `Parameters.md` §3.3; `KNOWN_RISKS…` `KR-01` |
| 6 | **Spec text on the "96h window" is stale by design.** Correct rule: `[30h, 96h)` applies only to one readable round aging without an earlier invalid response or pre-expiry re-anchoring. | `FINAL_PRODUCTION_ENGLISH_AUTHORITY.md` errata |
| 7 | **Spec describes `StabilityPool.sol` as the parity norm** while explicitly stating the deployed SP is `DFStabilityPool`; both are in the changed-file list, so reviewers must know which is deployed. | core spec §5 `CORE-MOD-004` |
| 8 | **Audit package references files absent from this checkout** (`docs/en/**`, `evidence/**`, `*.tsv`, `scripts/**`, `config/**`, deployment scripts). Cross-references in `docs/audit/**` will dangle. | repo listing |
| 9 | **`Allocated` event/cooldown semantics**: a zero-move `allocate()` still consumes the cooldown and emits; a `M == 0` preflight returns without consuming it. Spec explains this, but it reads as a subtle asymmetry in code. | `CollateralVault.sol:395–418`; `VAULT-FR-004` |
| 10 | **`forceDeallocateMorphoV2` is recent** (Guardian L-05 remediation) and is described in the Vault spec but is easy to overlook in the ABI. Review its pause + backing-floor + cache interactions together. | `CollateralVault.sol:733`; `GUARDIAN_REMEDIATION.md` |

---

## 14. Build and test

From `README.md` (validated toolchain from `docs/audit/BUILD_AND_TEST.md`):

```sh
python3 packages/contracts/setup.py          # installs pinned public deps from foundry.lock
forge build --root packages/contracts
forge test  --root packages/contracts --threads 1 -vv
```

| Input | Pin |
| --- | --- |
| Solidity | 0.8.24 |
| EVM | Cancun |
| Optimizer | on, 200 runs |
| Foundry (recorded results) | 1.7.1 |
| `forge-std` | `726a6ee…` |
| OpenZeppelin | v4.9.5 `bd325d5…` |
| OZ Upgradeable | `2d081f2…` |
| Solady | `362b2ef…` |
| Liquity V2-gov | `b880481…` (recursive submodules) |

- No RPC endpoint or wallet key is needed.
- Add proofs of concept under `packages/contracts/test/`.
- Repo tests cover **only selected oracle behavior**; the full upstream suite is *not* included.
  Absence of a failing test proves nothing.
- `foundry.toml` ignores contract-size errors (`ignored_error_codes = [3860, 5574]`), so size
  headroom is **not** enforced by a plain `forge test` — relevant because BO/TM sit at the EIP-170
  limit (`KR-12`).

---

## 15. Document map — what to read for what

| Question | Document |
| --- | --- |
| What am I allowed to report? | `docs/review-boundaries.md`, `SCOPE.md`, `docs/contracts-scope.md` |
| What did the client already fix / acknowledge? | `docs/known-issues.md`, `docs/audit/GUARDIAN_REMEDIATION.md` |
| What does the client already know is risky? | `docs/audit/KNOWN_RISKS_AND_CURRENT_POSITION.md` |
| System intent, IDs, trust boundaries | `docs/protocol/Product-Overview.md` |
| Core mechanics (authoritative) | `docs/protocol/spec/Liquity-v2-Core-Spec.md` |
| Vault accounting, roles, redemption queue | `docs/protocol/spec/CollateralVault.md` |
| Oracle topology, freeze, proxy lifecycle | `docs/protocol/spec/Oracle.md` |
| dToken semantics / cap / permit | `docs/protocol/spec/dToken.md` |
| Strategy push model, async handling | `docs/protocol/spec/strategies/Strategy.md` (+ Aave/ERC4626/Morpho/Sky children) |
| UX router + referral + native ETH | `docs/protocol/spec/Zapper.md` |
| PIL / forwarder / allocator | `docs/protocol/spec/InterestRouter.md`, `PILAllocator.md` |
| Bridge readiness | `docs/protocol/spec/JpydfToken.md` |
| Deployment parameter values | `docs/protocol/Parameters.md` |
| Why the 30h gate exists / what it does not fix | `docs/audit/NORMAL_REDEMPTION_30H_GATE_RATIONALE.md`, `JPYUSD_MARKET_HOURS_RISK_ANALYSIS.md` |
| Correct reading of stale support text | `docs/audit/FINAL_PRODUCTION_ENGLISH_AUTHORITY.md` |
| Proxy dependency/circularity proof method | `docs/audit/FINAL_PRODUCTION_DEPENDENCY_GRAPH.md` |
| Contract-purpose cheat sheet | `packages/contracts/src/README.md` |

---

## 16. Suggested review focus (synthesis, not project instruction)

Ordered by seam risk, not by likelihood of a payout:

1. **Backing-ratio → price → liquidation feedback loop.**
   `backingRatioForPricing()` availability semantics, the 1-wei floor on measured zero, the
   `(1e18, true)` shortcut when known assets cover liabilities, and what happens when a Strategy
   becomes unreadable *between* a pre-state check and a post-state check. Ask: can any ordering make
   the protocol accept a stale-high price for a liquidation or reject a valid one?
2. **Vault pre-state guard vs. cache.** `A_confirmed` must never include cache. Check every path
   (`deposit`, `redeem`, `redeemWithPermit`, `claim`, non-zero `allocate`, `transferYieldToTreasury`)
   and every early return for a path that mutates before the guard.
3. **Delayed-redemption queue accounting.** `pendingWithdrawals` is simultaneously liability and
   liquidity reservation; verify first-come-takes-all, fee-on-transfer/rebase handling, idempotent
   claim, and that `B_target`/`B_reserve` cannot be gamed to starve claims or drain Treasury.
4. **`receiveFromStrategy` cache reconciliation.** Exact delivery reduces cache without advancing
   `updatedAt`; mismatch invalidates; exhaustion invalidates. Look for a sequence (recover → cache
   reduce → writeoff → re-allocate) that ends with a stale-high cache or double counting.
5. **Oracle lifecycle.** `proposeSource`/`confirmSource` smoke tests, the 4-byte gas-guard
   pass-through, cached vs live reference selection, `_lastGoodRedemptionPrice` writes under aged
   provenance, and `resumeFromOracleFailure`'s "health check ≠ continuity" gap.
6. **Two 30h gates.** Normal redemption gate vs BO price-use gate: which operations they do and do
   not stop, whether a fresh same-value heartbeat reopens them, and whether the aged-path return
   value (`failure=true`) is consumed safely by every caller (including `RedemptionHelper`
   simulation and `TroveManager` pre-mutation ordering).
7. **`fetchUrgentRedemptionPrice` wiring.** The consumer discards the failure bool; prove every
   branch binds the Proxy. Also test "close before shutdown while urgent pricing is unavailable".
8. **One-shot finalization.** `finalizeRiskParams`: authorization, expected-underlying check,
   emptiness preconditions, parameter bounds/ordering, atomic child sync, and whether any
   pre-finalization path can still mint or open.
9. **`MIN_DEBT` as a multi-use threshold.** Repayment clamping, zombie creation/reactivation,
   urgent residual behavior, and the price-free zombie reactivation path during an oracle pause.
10. **Zapper atomicity.** Leftover sweep, referral immutability, native-ETH path balance deltas,
    incident close bypassing Vault redemption but still requiring a usable core price.
11. **Interface/ABI drift** (§13). Any integrator depending on the old single-role model, or on
    `claim` returning nothing, is a real integration hazard even if it is "only" docs.
12. **Size and upgrade constraints.** Findings that require code growth must be framed against
    BO = 24,576 B / TM = 24,568 B, and against append-only UUPS storage.

**Do not spend time re-deriving** (already disclosed, mostly acknowledged): unbacked bridge
activation, `mintCap`-as-debt-ceiling, no SP replenishment, Lido referral semantics under canonical
contracts, and whole-venue Aave/Morpho safety.

---

## 17. Glossary

| Term | Meaning |
| --- | --- |
| JPYdf | JPY-denominated stablecoin; implementation identifier `JpydfToken` |
| dToken | 18-dec ERC-20, 1:1 principal claim on Underlying; the core's collateral |
| Underlying | Real asset behind dToken (wstETH, USDC, …) |
| Branch | Per-collateral independent market |
| Trove | NFT position that deposits dToken and borrows JPYdf |
| Zombie | Active Trove whose debt fell below `MIN_DEBT`; removed from SortedTroves |
| SP | Stability Pool — JPYdf deposits that absorb liquidations, earn 75% of interest |
| Redemption | 1 JPYdf → ¥1 of collateral; peg correction |
| Urgent redemption | Post-shutdown exit path at a dedicated price consumer, with bonus |
| `baseRate` | Redemption fee component that spikes on redemption and decays with 6h half-life |
| Backing ratio | `min(1, A / L_effective)`; downward-only, multiplied into collateral price |
| Backstop reserve | Protected Underlying that raises `A` without minting liabilities |
| Push model | Strategies push principal/yield to the Vault; Vault never pulls |
| Buffer | Liquid Underlying available for redeem/claim/allocate/Treasury |
| ALLOCATOR | Operator role for allocation and profit pull-up |
| GUARDIAN | Immediate brake role (pause, neutralize, whitelist/strategy removal) |
| WRITEOFF | Immediate markdown role held by high-quorum GOV multisig |
| PIL | Protocol Incentivised Liquidity — 25% of borrowing interest for DEX liquidity |
| Proxy (PriceFeedProxy) | Fixed reference address with replaceable, timelocked source — *not* UUPS |
| Soft-freeze | 24h bounded reuse of the last good JPY rate before oracle failure |
| Placeholder branch | Deployed-but-inert branch (cap 0, no Underlying, unfinalized params) |
| Timelock | Shared `TimelockController` (12h) holding GOV/admin authority |
| nSLOC | Non-blank, non-comment Solidity lines, counted by pinned `cloc 2.06` |

---

## 18. Source-of-truth hierarchy (use this when documents conflict)

1. **Solidity at the final commit** — behavior.
2. **`SCOPE.md`** — review eligibility, size, exclusions (explicitly controls over the handoff).
3. **`FINAL_PRODUCTION_ENGLISH_AUTHORITY.md`** — corrections to stale copied English text; errata
   beat the text they correct.
4. **`known-issues.md` / `GUARDIAN_REMEDIATION.md` / `KNOWN_RISKS_AND_CURRENT_POSITION.md`** —
   prior findings and current positions. "Acknowledged" must not be reported as "Fixed"; project
   engineering positions are not formal risk acceptance.
5. **Component specs** — normative intent, but see §13 for drift.
6. **Product overview** — system intent, IDs, architecture principles.
7. **Historical docs** (`docs/audit/history/**`, `SCOPE.md`'s own "historical main-review context"
   note, Japanese-origin documents referenced but not included) — provenance only.

If a statement is missing from the English package but present in Solidity, the package has a
handoff defect: prefer the Solidity and note the discrepancy rather than guessing intent.
