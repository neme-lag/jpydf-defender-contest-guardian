# JPYdf Protocol — Threat Model

**Companion to [`CONTEXT.md`](./CONTEXT.md).** The context brief establishes *what the protocol does*; this document asks *who can break it, how, at what cost, and what stops them*.

All protocol facts, role names, constants, and findings IDs are taken from `CONTEXT.md` and its cited sources. Where this document states something derived from reading the actual bytecode-level source, it carries a `file:line` reference. Nothing here was produced by executing code: no `forge`/`cast` in the analysis environment, no `packages/contracts/lib/`. Treat every "verified" tag as *verified by reading*, not by running.

---

## 0. How to read this document

### 0.1 Evidence tags

| Tag | Meaning |
|---|---|
| **[V]** | Read directly in `packages/contracts/src/…` at the commit under review; line references given. |
| **[D]** | Stated in repo documentation (`docs/audit/*`, `docs/protocol/*`, `SCOPE.md`) and accepted as intent, not proven by code reading here. |
| **[A]** | Assumption or inference. Not proven. Each assumption is restated as a falsifiable question in §15. |

### 0.2 Severity scale

| Severity | Definition for this system |
|---|---|
| **Critical** | Direct, repeatable loss of user principal; or permanent protocol-wide insolvency; or unbounded mint of `JpydfToken`/dToken. |
| **High** | Loss confined to a subset (one branch, one Strategy, one redemption cohort) or a full-branch freeze needing governance to exit; or theft of yield/rewards of material size. |
| **Medium** | Material but bounded loss, or a DoS that delays exit by hours-to-days, or a trust-boundary failure that requires a privileged key to misbehave. |
| **Low** | Dust, griefing, temporary UX failure, event/monitoring gaps. |
| **Info** | Documented trade-off, spec drift, or hardening note. |

### 0.3 Likelihood scale

`H` = any EOA, no capital beyond gas · `M` = funded attacker or MEV searcher · `P` = privileged key or timelock compromise/error · `X` = external dependency failure (venue, Chainlink, Lido, bridge).

### 0.4 The threat model in one page

If only five things can be right, these are they:

1. **The pre-state backing guard is unbypassable.** `A_confirmed` (raw balance + live, `min(est, principal)` strategy values, cache-free) must gate every value-removing user path. A single entry point that skips it turns a strategy loss into a bank run. (TM-V-01)
2. **The mark cannot be moved by an operator into a price collapse without a bound.** A writeoff reaches the oracle as `backingRatio`, and a zero ratio yields a **1-wei price, not a revert**, which liquidates the whole branch. (TM-V-09 / TM-O-08)
3. **Shutdown × price failure must still leave one honest exit.** With the shutdown flag latched, repay reverts, normal redemption is closed by design, and urgent redemption reverts on failure. Only `closeTrove` is left — and it requires holding 100% of the debt in JPYdf, which redemption is the natural way to obtain. (TM-C-04)
4. **Oracle failure must be loud.** `batchLiquidateTroves` *returns* rather than reverting; the 30h aged gate emits nothing; a valuation failure emits nothing. Silent degradation is the default state. (TM-C-01, TM-X-05)
5. **Privileged edges must be destination-constrained.** Strategies can only push value to the Vault; operators can only move value along fixed edges — with one exception worth pressing on: `bridgeMint` has **no cap check**. (TM-S-04, TM-G-03, TM-G-05)

---

## 1. System abstraction

### 1.1 What is actually at risk

| Asset | Where it lives | Who can move it |
|---|---|---|
| Branch underlying (wstETH, USDC, …) | `CollateralVault` raw balance + Strategy positions + backstop reserve | Vault roles; Strategy Owner only *toward* the Vault |
| dToken (18-dec ERC-20 collateral claim) | User wallets, Vault, Zapper, Troves | Vault (`mint`/`burn`), holders |
| `JpydfToken` (JPY stablecoin) | User wallets, SP, ActivePool, Trove debt | Core `borrow`/`repay`/`liquidate`/`redeem`, bridge minters |
| Trove NFT | Owners, batch/interest managers | Owner + configured managers/receiver |
| Staking yield (dToken appreciation) | Vault accounting, not a separate balance | Price-of-dToken mechanism |
| SP JPYDF deposits + collateral gains | `DFStabilityPool` | Depositors (with same-block guard) |
| Reward tokens (Aave/Merkl) | Strategies | Owner (`sweepRewardToken`), `claimMerklRewards` |
| Governance authority | 8 roles + Ownable2Step + UUPS upgrader + timelocks | Role holders |

### 1.2 Trust zones

```
Z0 Off-chain reality        Chainlink feeds · Lido stETH curve · FX market · Morpho/Euler/Aave venues · Merkl
        │  (prices, liquidity, oracle heartbeats — all external failure domains)
        ▼
Z1 Oracle zone             PriceFeedProxy(Ownable2Step) → DFPriceFeedBase → JpyFreezeLib
        │                  + JpyUsdRateProvider (JPY/USD) + stETH/ETH + ETH/USD legs
        ▼
Z2 Branch core (Liquity v2 fork)   BorrowerOperations · TroveManager · ActivePool · SortedTroves
        │                          DefaultPool · StabilityPool(S) · CollSurplusPool · Batch managers
        ▼
Z3 Seam / extension zone   CollateralVault (dToken issuance, backing gate, buffer, queue, writeoff)
        │                  DToken · AddressesRegistry · CollateralRegistry (cross-branch redemption)
        ▼
Z4 Venue zone              BaseStrategy → AaveV3 / MorphoV2 / ERC4626(+async) / Idle adapter
        ▼
Z5 Entry zone              CollateralYieldZapper · BaseZapper / LeftoversSweep · manager modules
        ▼
Z6 Governance zone         12h GOV timelock · GUARDIAN · ALLOCATOR/WITHDRAWER/HARVESTER/TREASURY/WRITEOFF
                           · proxy source timelock 12h · bridge minter timelock 48h · Ownable2Step
Z7 Bridge / distribution   JpydfToken minters/burners · PILAllocator (L2 Merkl) · InterestRouter
```

The single most important structural fact: **the Liquity core in Z2 cannot see Z3 or Z4.** It sees an 18-dec ERC-20 (dToken), one `IPriceFeed` (the Proxy), and `JpydfToken` (ARCH-003 / SYS-CON-002). Every cross-zone trust assumption therefore compresses into two numbers the Proxy computes: `price` and `backingRatio`. A defect anywhere in Z3/Z4 that changes those two numbers is, from Z2's perspective, *the truth*.

### 1.3 Security goals (threat-model targets)

| ID | Goal | Failure means |
|---|---|---|
| **G1** | dToken is always redeemable for ≥ its pro-rata share of underlying, minus explicitly disclosed fees | Bank run / insolvency |
| **G2** | `backingRatio` never overstates true backing by more than the disclosed valuation method allows | Over-borrowing against phantom collateral |
| **G3** | `JpydfToken` debt is always backed by liquidatable collateral at the price the system uses | Bad debt |
| **G4** | Every user can exit: repay, close, redeem, withdraw SP, or queue a withdrawal, within a bounded time | Censorship / trapped principal |
| **G5** | No role, individually or in collusion below the documented quorum, can extract principal | Insider risk |
| **G6** | Recovery actions (pause, writeoff, force-deallocate, oracle source switch) are bounded, observable, and reversible | Catastrophic operator error |

### 1.4 Core invariants restated as falsifiable claims

1. `backingRatio ≤ 1e18` and user flows revert when raw + live-confirmed backing < liabilities (`CollateralVault.sol:940-1000`) **[V]**
2. Cache is never used to admit a user flow; only to size `M` for pricing (`_managedUnderlying` vs `_requireConfirmedFullyBacked`) **[V]**
3. `A/L` below 100% cannot be "repaired" by a user action that removes value — deposits, redemptions, and claims all re-check **[V]**
4. `pendingWithdrawals` is inside the buffer requirement, so claims cannot be starved by allocation **[V]**
5. No user flow depends on a price when the price says "unreliable" (fail-closed, not fail-open) **[V]** for `BorrowerOperations._adjustTrove` risk-increasing, `TroveManager.batchLiquidateTroves`, `redeemCollateral`
6. A Strategy can only send assets *to* the Vault, never sideways (`receiveFromStrategy` gated to registered strategies; `emergencyWithdraw` hard-codes the Vault) **[V]**
7. Branch finalization is one-shot and only on an empty branch **[V]**
8. Bridge/burn supply changes cannot silently change the redemption denominator in a way that shifts loss to holders (documented gap: L-06) **[D]**

---

## 2. Adversaries and their capability envelope

| ID | Adversary | Capabilities | Not capable of |
|---|---|---|---|
| **A1** | Unprivileged borrower / dToken holder | Open/adjust/close Troves, deposit/redeem dToken (permissionless), SP provide/withdraw, borrow at any allowed rate, batch participation | Changing parameters, moving others' funds, bypassing backing gate |
| **A2** | Liquidator / keeper / MEV searcher | Backrun, sandwich, front-run liquidations and redemptions, JIT SP, gas-price games, oracle-failure arbitrage | Forcing oracle failure, editing state without paying |
| **A3** | Malicious Strategy (registered) | Report arbitrary `estimatedTotalUnderlying`, revert, return-0, `receiveFromStrategy` with mismatched amounts, reenter Vault views | Moving Vault assets anywhere but the Vault; borrowing via Vault roles |
| **A4** | Compromised venue (Morpho/Aave/Euler/adapter) or asset (USDC blacklist, negative rebase, stETH depeg) | Freeze withdrawals, haircut value, revert transfers, blacklist addresses | Forging Vault accounting (fee-on-transfer handled by receipt checks) |
| **A5** | Compromised/faulty external oracle | Publish stale, frozen, deviating, or reverting prices; change decimals; deprecate feeds | Directly write Vault state; the Proxy checks deviation + provenance |
| **A6** | Single privileged key (GUARDIAN, ALLOCATOR, WITHDRAWER, HARVESTER, TREASURY, WRITEOFF, proxy Owner, Strategy upgrader/owner, bridge minter) | All powers in §3.3 | Unilateral principal theft without an upgrade or a gross mispricing path |
| **A7** | Timelock GOV / DEFAULT_ADMIN compromise (or malicious proposal) | Upgrade Vault/Strategy/proxy, retune every parameter, re-register strategies/oracles | Nothing — this is full trust |
| **A8** | Bridge / L2 side | Mint/burn `JpydfToken` via registered minters, alter circulating supply | Touch dToken or Vault assets |
| **A9** | DoS griefer | Spam dust Troves, dust SP deposits, inflate queues, force gas-heavy loops within `MAX_STRATEGIES = 32` | Exceed gas limits the protocol already budgets for |

### 2.1 Capability matrix — what each adversary can actually reach

| Goal ↓ / Adversary → | A1 | A2 | A3 | A4 | A5 | A6 | A7 | A8 |
|---|---|---|---|---|---|---|---|---|
| Steal Vault underlying | gate | — | indirect (mark) | haircut | — | via mispricing | upgrade | — |
| Inflate dToken backing | gate | — | yes (fake valuation) | — | — | — | — | — |
| Manipulate liquidation price | — | — | yes (mark) | — | yes | writeoff | yes | — |
| Freeze user exit | — | queue flood | revert/0 | venue freeze | pause latch | pause roles | yes | — |
| Infinite `JpydfToken` | — | — | — | — | — | minter (bridge) | yes | cap-bypass |

---

## 3. Trust boundaries

### 3.1 Boundary register

| # | Boundary | Assumption the protocol makes | If violated | Detection today |
|---|---|---|---|---|
| **B1** | Core ⇄ Oracle Proxy | Proxy is the *branch's* feed and reverts-or-flags on every failure; it always returns a price the core may use | Silent stale pricing; liquidations silently halt (`batchLiquidateTroves` returns on `oracleFailure`) | `ShutdownCallReverted` event only covers a *miswire* case; healthy-but-stale has no event |
| **B2** | Proxy ⇄ source feed | Source returns `(price, bool)`, sane provenance, ≤1% jump per 12h confirmation | Bad price admitted at source-switch time | 12h timelock, 1% deviation guard, emergency bypass exists |
| **B3** | Proxy ⇄ JPY provider | `lastGoodJpyUpdatedAt` is honest and < `MAX_NORMAL_REDEMPTION_JPY_AGE` (30h) for normal redemption and for the BO risk-increase path | Stale-FX redemption extraction (KR-01) | 30h gate exists; latched flag is not surfaced to users |
| **B4** | Oracle ⇄ Vault `backingRatio` | `totalUnderlying()/liabilities` is a faithful mark | Price collapse → wrongful liquidation cascade; price inflation → over-borrow | `min(1e18, …)` floor at 1 wei; no circuit breaker on markdown size |
| **B5** | Vault ⇄ Strategy | `estimatedTotalUnderlying()` is honest; `principal` is an upper bound on realizable value | Over-borrow against a hollow strategy (KR-08) | `min(est, principal)` cap; live-only in user flows; cache only for mark |
| **B6** | Vault ⇄ dToken holders | Redemption at par minus disclosed fee, when not impaired | Pre-impairment cash-out at par (classic run) | Gate blocks *once visible*; queue is FIFO by timestamp, not by risk |
| **B7** | Core ⇄ CollateralRegistry | Cross-branch redemption skips branches whose price fails, without shifting loss to the redeemer | Under-delivery / stuck JPYdf (CS-JPYDF-013) | Returns `redeemedAmount`, no event on skip |
| **B8** | Zapper ⇄ user | Caller is owner or authorized manager; receiver is fixed by trove config | Manager misdirects withdrawal to a receiver they set | Owner-set `receiver`; `_requireZapperIsReceiver` |
| **B9** | Governance ⇄ protocol | 7-day-ish operational discipline, high-quorum keys, monitoring | WRITEOFF/owner can freeze + mispricing; GOV can upgrade to drain | Timelocks; pause flags readable on-chain |
| **B10** | Protocol ⇄ bridge | Minters are honest, supply is capped | Uncapped mint → JPYdf collapse | **`bridgeMint` has no `cap` check** (`JpydfToken.sol:211-216`) **[V]**; only the minter registry + 48h timelock |
| **B11** | Protocol ⇄ off-chain ops | Someone runs `confirmSource`, `resumeFromOracleFailure`, writeoff, DR | Oracle stays paused after recovery; backing stays invisible | Events; no on-chain SLA |
| **B12** | Compiler/deploy config | `via_ir`/optimizer/size ignore flag do not mask EIP-170 overflow | Undeployable fix, or behavior differing from tested build | `ignored_error_codes=[3860,5574]` disables size enforcement (`foundry.toml`) **[V]** |

### 3.2 Where the boundaries are *not* enforced by code

- **The 30h vs 72h JPY staleness split** exists only as a constant plus a test fixture (`test/JpyUsdRateProvider.t.sol:13`) — no on-chain parameter links them.
- **`resumeFromOracleFailure` requires all three feeds healthy**; there is no partial-resume path, so a single degraded leg keeps the branch paused and only GOV/Owner can act.
- **Branch activation ordering** (replace placeholder → bind token → underlying → cap) is a runbook, not a state machine. Code catches some misordering (mint before `setTokenInfo` reverts, `setCap>0` requires finalized params) but not "cap opened while the placeholder still answers `1e18`".
- **`bridgeMint` cap bypass** is real in code; the cap is enforced only in `DToken.mint`, not in the bridge path.

### 3.3 Privileged-power damage table

| Role | Can | Worst realistic misuse | Reversible? |
|---|---|---|---|
| **GUARDIAN** | Pause deposit/allocation/redeem/claim; disable Strategy; remove from whitelist | Full deposit/redeem freeze; forced queue growth | Yes — GOV unpauses (12h) |
| **WRITEOFF** | Immediate `writeoffStrategyPrincipal`, `forceDeallocateMorphoV2`, `pauseAllocation` (≠ GOV-pause) | Mark backing down arbitrarily → price → 1 wei → mass liquidation of healthy Troves | **No** — writeoff is accounting-final |
| **ALLOCATOR** | Move buffer into whitelisted Strategies, `pauseUserFlows` when viewing a failed estimate | Force illiquidity; grow pending queue | Partly (WITHDRAWER can pull back if venue works) |
| **WITHDRAWER** | Call `sendToVault` on Strategies | Pull principal back (benign) or *not* do it (liveness) | n/a |
| **HARVESTER** | Realize yield, `claimAllCollGains`-style reward sweeps | Route yield to Treasury vs buffer within policy | Accounting-only |
| **TREASURY_TRANSFER** | Move realized yield to treasury | Skim yield (bounded, disclosed) | No |
| **GOV (12h)** | Upgrade Vault/Strategy, set roles, cap, treasury, buffer target/floor, strategy registry + valuation gas budget, proxy source | Full drain via upgrade; placeholder activation misorder | Timelock-delayed |
| **Proxy Owner (12h)** | `proposeSource`, `confirmSourceEmergency` (no deviation check) | Swap feed, bypass 1% guard → mispricing | 12h + `renounceOwnership` blocked |
| **Bridge admin (48h)** | Register minters/burners | Uncapped mint (no cap check in `bridgeMint`) | 48h + monitoring |

---

## 4. STRIDE coverage map

| STRIDE | Where it lands in this system | Threats |
|---|---|---|
| **S**poofing | Fake oracle source confirmation; Zapper permit forgery; referral attribution; bridge message origin; `_isPriceFeedProxy` one-level marker | TM-O-04, TM-O-08, TM-Z-03, TM-G-04, TM-X-06 |
| **T**ampering | Strategy valuation, cache invalidation by a registered Strategy, dToken accounting, Vault storage on upgrade | TM-S-01, TM-S-05, TM-V-07, TM-X-01 |
| **R**epudiation | No on-chain enforcement of ops SLAs; no user-visible "redemption degraded" signal | TM-O-06, TM-X-05, §10 |
| **I**nformation disclosure | `backingRatio` / `available` / JPY staleness are observable and tradeable (front-running the impairment) | TM-V-02, TM-O-02 |
| **D**enial of service | Oracle pause latch, strategy revert, gas budget, SP/UUPS freeze, GOV-dead | TM-O-06, TM-V-08, TM-C-02, TM-G-05 |
| **E**levation of privilege | Strategy upgrade, proxy emergency confirm, WRITEOFF, bridge minter, Zapper manager paths | TM-S-06, TM-G-01, TM-G-02, TM-G-06, TM-Z-01 |

---

## 5. Threat catalogue — Z3 Vault / dToken (the extension zone)

Format: **ID · threat · preconditions · path · impact · controls · residual**.

| ID | Threat | Preconditions | Path (code) | Impact | Existing controls | Residual / review-candidate |
|---|---|---|---|---|---|---|
| **TM-V-01** | **Backing-gate bypass**: a user flow admits an impaired Vault by reading a stale cache instead of a live estimate | Strategy estimate unavailable *and* a cached valuation exists | `_requireConfirmedFullyBacked` (940-1000) walks raw balance first, then **live** strategy values, short-circuits as soon as coverage is met. Cache is used only by `_managedUnderlying` for pricing | Critical — redeem/claim/borrow at par against a hole | Cache-free by construction ([VAULT-SEC-010](docs/protocol/spec/CollateralVault.md)); `min(est, principal)`; revert `BackingRatioBelowMinimum` | Verify *every* state-changing entry point calls the confirmed variant, including `redeemWithPermit`, `claim` (1187-1215) and `deposit`; the guard short-circuit means **a later corrupt strategy is never read**, which is correct but makes gas dependent on ordering |
| **TM-V-02** | **Impairment front-run / first-come cash-out**: the loss is real but not yet visible; informed holders redeem at par and the loss lands on the slow | Valuation lag (venue P&L not yet reflected, or `est ≥ principal` masking a loss) | Buy cheap dToken → `redeem`/queue while `A_confirmed ≥ L`; each redemption re-checks, so *once visible* the queue is FIFO and the victim is whoever is last | High — wealth transfer between holders during an incident | Gate; monitoring; backstop reserve; ADR-006 recovery doctrine | Structural, cannot be fully solved on-chain. The relevant audit question is whether the mark understates loss in *any* deterministic way (see TM-S-01, TM-O-08) |
| **TM-V-03** | **Buffer starvation of claims**: allocated principal is pulled into strategies leaving too little for queued claims | Allocator pushes near the buffer floor; queued withdrawals grow | `_requiredBuffer` = `max(M·bps/1e4, floor) + pendingWithdrawals` (330-375), so pending claims are additive by design; `claim` re-checks `bufferBalance` | Medium — claims delay until delay elapses / WITHDRAWER pulls back | Additive term; `withdrawDelay` bound (≤30d); `WithdrawRequest` queue | Confirm the *floor* term cannot be satisfied by the same tokens counted twice; confirm `pendingWithdrawals` is decremented only on successful payment (`_completeRedemption`) |
| **TM-V-04** | **Queue preemption**: a later, larger request jumps ahead of an earlier small one | Any impairment event | Queue is timestamp-ordered; a whale who queues in the same block as a retail holder is indistinguishable | Low — fairness, not solvency | FIFO by timestamp | Whether `withdrawDelay` can be extended *after* a request is queued (governance change) — verify no retroactive effect |
| **TM-V-05** | **Registered-Strategy griefing via `receiveFromStrategy`**: declared ≠ received invalidates the cache and forces `available = false` | Attacker controls a *registered* Strategy (requires registry write) | `receiveFromStrategy` → mismatch branch → `_invalidateStrategyValuationCache` → oracle sees `available=false` → pause latch | Medium — branch pricing DoS while Troves remain open | Registration is GOV-only; role separation | Whether a *legitimate* venue adapter can be tricked into a mismatched report (e.g. fee-on-transfer inside the venue) causing permanent invalidation |
| **TM-V-06** | **Valuation gas-budget griefing**: pricing/user flows run out of gas because 32 strategies × budget exceeds the block | GOV sets a high `strategyValuationGasBudget` (documented as configurable) | `_tryEstimatedTotalUnderlying` forwards budget per strategy; 32 × budget can exceed block gas → deposit/redeem/claim and the *oracle price* become uncallable | Medium — protocol-wide DoS (fail-closed, but everything halts) | Budget setter is GOV; 32 cap | Bound should be documented as `block_gas / MAX_STRATEGIES`; check whether a single strategy can consume its full budget without returning (adapter-level griefing) |
| **TM-V-07** | **`_managedUnderlying` returning 0 silently disables allocation and treasury sweeps** | One strategy unreadable | `managedAssets == 0` → early `return` *before* the `Allocated` event in `_allocateToStrategies` (705-770) | Low/Medium — silent no-op; operators believe allocation happened | Early return is the safe behavior | Off-chain monitoring gap; emit a reason or event |
| **TM-V-08** | **Fee-on-transfer / rebasing / blacklistable underlying** corrupts accounting or blocks exit | Governance lists a weird underlying; or USDC blacklists a claimant | Deposits credit `received`, not `declared` (`_pullAndDepositUnderlying`); `_completeRedemption` measures receiver delta; negative rebase makes the subtraction revert; blacklist makes `safeTransfer` revert for that one request | Low — individual claim stuck only | Receipt-based accounting; **settlement is single-request**: `_completeRedemption` queues one `WithdrawRequest` and pays one receiver per call (`CollateralVault.sol:1009-1032`), and `claim(requestId)` pays one owner (`:338-346`) **[V]** | A blacklisted recipient cannot block anyone else's claim. For *rebasing* tokens the global failure remains (a negative rebase breaks `A_confirmed` for all holders) — that is a listing-policy control, not a code fix |
| **TM-V-09** | **Writeoff over-markdown → liquidation cascade** | WRITEOFF key (or GOV) marks principal down | `writeoffStrategyPrincipal` → backingRatio drops (possibly to 0) → oracle price → 1 wei floor → `batchLiquidateTroves` liquidates every Trove in the branch | High/Critical (privileged) — healthy borrowers lose collateral; liquidators profit | `_minBackingRatioAfter` floor (operator-chosen), `_requireStrategyIncidentReady`, `_pauseUserFlows` during the writeoff, all-or-nothing revert | **No upper bound on markdown, no timelock, no two-step.** A "fat-finger" writeoff of 100% is irreversible accounting; recovery requires manual re-credit? Verify whether principal can be re-raised (no `credit` path exists) |
| **TM-V-10** | **`WRITEOFF` freezes user flows as a side effect**: `_pauseUserFlows()` pauses deposit+redeem+claim without a GOV vote | Any writeoff call (even a correct one) | Emergency pause flags set inside the writeoff path; unpause needs GOV | Medium — availability during the most sensitive moment | Documented as intentional | Whether `pauseClaim` during an incident is acceptable (claims are the exit!) — check pause scope in the code |
| **TM-V-11** | **Backstop confusion**: reserve is treated as buffer or vice versa | Recovery in progress | `backstopDeposit` keeps reserve out of `M` and out of `bufferBalance()`; GOV-only `releaseBackstopToBuffer` converts it to buffer | Low — misallocation of repair capital | `releaseBackstopToBuffer` is `onlyRole(GOV_ROLE)` and only lowers `_backstopReserve`, so the tokens never move (`CollateralVault.sol:472-480`) | Releasing during impairment converts *protected repair capital* into *first-come claim liquidity* ([VAULT-FR-017](docs/protocol/spec/CollateralVault.md)). That is a deliberate policy lever, not a bug — but it decides **who** absorbs the loss |
| **TM-V-12** | **`convertToUnderlying` rounding up inflates liabilities by 1 base unit**, making exact-balance redemptions or dust deposits revert | Dust balances | `_dTokenToUnderlyingRoundingUp`; `InvalidDTokenAmount` | Info — UX only | Users can pass explicit amounts | Whether rounding direction is *conservative* in every direction (it should inflate L, never A) |
| **TM-V-13** | **Uninitialized / mis-initialized UUPS proxy** | Deployment error or front-run | Vault `initialize(admin)` grants 8 roles; `_authorizeUpgrade` is `onlyRole(GOV_ROLE)`; `_checkRole` reverts without a reason string | Critical if it happens | Deploy scripts (not in repo) | Deployment is **out of scope** for contest; note as an operational assumption |
| **TM-V-14** | **Strategy registry abuse**: registering a hostile Strategy gives it the ability to invalidate cache, revert valuation, and sit in the 32-slot loop | GOV adds a malicious/broken adapter | TM-V-05, TM-V-06, TM-S-01 collapse into this | High (privileged) | GOV timelock; disable + remove by GUARDIAN | Removal leaves cache/history semantics intact? Verify `removeStrategy` updates `M` and cache consistently |

---

## 6. Threat catalogue — Z4 Strategies

| ID | Threat | Preconditions | Path (code) | Impact | Controls | Residual |
|---|---|---|---|---|---|---|
| **TM-S-01** | **Valuation masking**: `min(est, principal)` counts a loss as long as `est ≥ principal`; a venue that has *lost* value but still reports optimistic `est` (e.g. exchange-rate manipulation, bad-debt not yet realized) is counted in full | Venue P&L not marked | `estimatedTotalUnderlying()` → `_managedUnderlying` → price → borrow headroom | High — over-borrow against phantom collateral (KR-08) | Principal cap; live-only in user flows; monitoring | No independent mark. The honest `est` is the whole trust model for strategies |
| **TM-S-02** | **Venue illiquidity mistaken for solvency**: `sendToVault` fail-softs to 0, principal stays counted | Morpho liquidity adapter short, Aave paused | `_doWithdraw` retries half-size then returns 0; Vault's `_managedUnderlying` still includes the principal | Medium — redemptions queue; no loss | Fail-soft (ADR-006); queue | Whether a *partial* withdraw leaves the Strategy's `_principal` overstated relative to the residual |
| **TM-S-03** | **Strategy upgrade path**: `upgrader` can point the proxy at arbitrary code | Compromised upgrader (separate from Owner) | `_authorizeUpgrade` checks `msg.sender == upgrader`; `setUpgrader` only callable by the upgrader itself | Critical (privileged) — drain the Strategy's principal | Role separation | Is the upgrader an EOA or the timelock? Verify in deployment; if EOA, this is a single-key drain of one Strategy |
| **TM-S-04** | **Owner sweeps or misdirects**: `sweepRewardToken` is Owner-only; `emergencyWithdraw` sends **to the Vault** (hard-coded) | Compromised Owner | `emergencyWithdraw` → `receiveFromStrategy` (Vault path only); `_sweepRewardToken` protects position tokens | Low/Medium — reward theft only; principal must route through the Vault | `_isSweepProtectedToken`; `receiveFromStrategy` semantics | Enumerate protected tokens per adapter; an unlisted wrapper could be swept |
| **TM-S-05** | **Async-strategy bps manipulation**: raising the bps above the old value is allowed *without* pausing allocation; lowering requires a pause | Misconfigured async strategy (ERC4626 async) | The async-parameter setter adjusts the share of pending assets reported by `estimatedTotalUnderlying` (verify the exact accessor name in `ERC4626Strategy`) | Medium — inflated valuation by up to `(10000-oldBps)/10000` | Directional rule (up = free, down = pause) | Confirm "up" cannot exceed a sane cap (e.g. 100%) and that the bps only applies to *pending* assets, not total |
| **TM-S-06** | **Reentrancy through the venue during `allocate`** | Malicious venue or hook-bearing underlying | Vault `nonReentrant` + Strategy `nonReentrantStrategy`; `deployUnderlying` is self-call only | Critical if it lands | Two guards; self-call deploy | Read-only reentrancy: during `transfer → deposit`, a view sees buffer down / principal not yet up (`totalUnderlying` understated). No in-protocol trigger found, but any future integration that reads the Vault mid-call is exposed |
| **TM-S-07** | **`forceDeallocateMorphoV2` passes caller-supplied `adapter` + `data` to the venue** | WRITEOFF key | Privileged arbitrary calldata into Morpho; bounded by `_minReceived`, share-balance monotonicity check, and the backing floor | High (privileged) | Pause + min-received + revert-on-share-increase | Whether an arbitrary `adapter` can be used to grief the venue on behalf of the Strategy; verify adapter allowlist exists |

---

## 7. Threat catalogue — Z1 Oracle (highest-signal zone)

| ID | Threat | Preconditions | Path (code) | Impact | Controls | Residual |
|---|---|---|---|---|---|---|
| **TM-O-01** | **Stale FX priced as fresh**: JPY/USD lags the market but is inside the 30h window | FX feed outage inside heartbeat | `fetchPrice` returns `(price, false)` while `updatedAt` ≤ 30h; price = `collUsd ÷ jpyUsd × min(1, backing)` | Medium — borrow/repay at wrong JPY/USD; arbitrage vs real FX | 30h gate; 24h freeze on shared JPY state | KR-01 open; window size is a policy choice with no on-chain signal to users |
| **TM-O-02** | **Re-anchoring curse**: `_lastGoodJpy` refresh resets the age clock, extending the stale episode indefinitely | Feed keeps publishing the same value (or delayed) | `lastGoodJpyUpdatedAt` updated whenever a *plausible* value arrives, including an unchanged one | Medium — extends TM-O-01's window; the gate never trips | Freeze mechanism | Whether "value unchanged" should count as freshness. This is the crux of KR-01 |
| **TM-O-03** | **Stale-high leg underpays redeemers**: `fetchRedemptionPrice` uses `max(stETH/USD, ETH/USD × stETH/ETH)`, so a stale-high direct leg inflates collateral value and shrinks the collateral paid per JPYdf | Direct stETH/USD stale-high | Redemption path only (not the borrow path) | Medium — systematic underpayment to redeemers (KR-04) | Leg selection rule | Whether the discrepancy is bounded and disclosed; contest-relevant if a code change alters leg choice |
| **TM-O-04** | **Emergency source confirmation bypasses the 1% deviation guard** | Proxy Owner key | `confirmSourceEmergency` skips `MAX_SOURCE_SWITCH_DEVIATION_BPS = 100` (KR-05) | High (privileged) — instant mispricing | 12h normal path; event | Whether emergency confirmation should still be timelocked or require 2-of-3 |
| **TM-O-05** | **Proxy source cycle**: source replaced by a forwarding adapter that re-references the Proxy → infinite recursion / `available=false` | GOV/Owner | `_isPriceFeedProxy` is a one-level marker only (KR-06) | Medium — pause latch or gas burn | Marker check + 12h | Whether the marker can be spoofed by a contract exposing the same function |
| **TM-O-06** | **Miswire → silent branch DoS**: `_handleFailedFetch` wraps `shutdownFromOracleFailure` in try/catch; a wrong BO address makes shutdown revert and the Proxy serves a cached price with `failure = true` forever | Deployment miswire (BO not the branch's) | `_handleFailedFetch` catches and emits `ShutdownCallReverted`; consumers treat `failure=true` as "revert/return-0" | High — liquidations halt (single liquidation entry point returns early), redemptions return 0, borrows revert; no pause flag, so no `resume` needed and no obvious signal | Event exists | Deliberately not a DoS per remediation notes; the *operational* risk is a branch that cannot liquidate while bad debt grows. Verify monitoring alerts on `ShutdownCallReverted` |
| **TM-O-07** | **Direct source instead of the Proxy** in the urgent-redemption path: the failure bool is ignored, so a source that returns `(price, true)` is consumed | Misconfiguration | `redeemCollateral` urgent path calls `fetchUrgentRedemptionPrice` (which reverts on failure) vs a raw source that returns a bool | High — redeemers receive a bad price during shutdown | Documented (KR-10) | Configuration-only; no code path in the Proxy itself. Contest scope: check whether *any* in-repo caller can reach a raw source |
| **TM-O-08** | **Over-markdown → 1-wei floor → liquidation cascade** (oracle side of TM-V-09) | Backing measured at zero, whether *genuinely* or because a writeoff marked it there | `JpyFreezeLib.applyBackingRatio` clamps a measured zero to **1 wei** so the price stays non-zero (`JpyFreezeLib.sol:96-127`) **[V]**; the price becomes `jpyPrice × 1 / 1e18` → the whole book is liquidatable | Critical (privileged + external) | Unavailable ≠ zero is distinguished (`backingRatioForPricing` returns `(0,false)` → shutdown path, `CollateralVault.sol:902-917`); the floor prevents the zero-price sentinel | **The code comment states the trade-off explicitly**: *"serving collateral at 1e-18 of its value makes the whole book liquidatable, but shutting down instead would quote lastGoodPrice over collateral that is genuinely gone."* The open case is the *non-genuine* zero: a writeoff that overstates a loss converts a governance action into a mass-liquidation event with no circuit breaker |
| **TM-O-09** | **Fixed-stipend brittleness**: `_normalRedemptionJpyStatus` staticcalls the source and the provider with `JPY_PROVENANCE_GAS_STIPEND = 30_000` (`PriceFeedProxy.sol:82, 520-531`) and requires code + exactly 32 bytes of returndata; a more expensive provider (proxy hop, extra SLOADs, colder slots) silently classifies as INVALID | Provider upgrade or gas repricing | Normal redemption becomes permanently unavailable with **no event** | Medium — silent feature disable of normal redemption, with no event | `MAX_NORMAL_REDEMPTION_JPY_AGE` age check; `provider.code.length` check; strict returndata length | Whether INVALID vs AGED should be distinguishable on-chain — today both collapse to `!= JPY_PROVENANCE_FRESH`, so an operator cannot tell "market closed" from "my provider is too expensive to read" |
| **TM-O-10** | **Latch asymmetry**: `fetchPrice` caches `_lastGoodPrice` *before* the BO-provenance check, so the cached price can be one the BO path refuses to use | JPY aged | `fetchPrice` sets `_lastGoodPrice = price` then returns `(price, true)` if the JPY provenance is not fresh | Low/Medium — later `_handleFailedFetch` serves a price that was never "good" for borrowing | Failure flag is always paired | Whether a redemption or liquidation path can consume `_lastGoodPrice` without the flag (see TM-O-07) |
| **TM-O-11** | **Decimal change / feed deprecation**: feeds are decimals-checked at construction only (8), the JPY provider has a runtime check, collateral feeds do not | Chainlink proxy upgrades decimals; feed deprecated | Scaled price off by 10^10 | Critical (external) | Monitoring (ORCL-INV-014) | No on-chain runtime check for collateral feeds; a deprecation incident manifests as a paused branch, which is safe but blind |
| **TM-O-12** | **`confirmSource` accepts AGED provenance**, caching a normal price while redemption pricing is degraded | Source switch during an FX gap | `_cacheConfirmedSourcePrices` rejects INVALID but allows AGED for the normal path | Low — bounded by the 12h confirm + 30h window | Explicit check | Whether the cached "redemption" price should be dropped on AGED (it currently is, for `_lastGoodRedemptionPrice`) |

---

## 8. Threat catalogue — Z2 Liquity core and the Z2/Z3 seam

The core is a parity fork of Liquity v2 (BOLD v1.11.0). Its own threat surface is *inherited and largely audited*; the interesting risks are at the seam where the extension layer feeds it a price.

| ID | Threat | Preconditions | Path (code) | Impact | Controls | Residual |
|---|---|---|---|---|---|---|
| **TM-C-01** | **Liquidation is all-or-nothing on oracle health.** `_liquidate` is internal; the only public entry point is `batchLiquidateTroves`, which fetches the price and **returns silently** on failure | Any oracle failure (including the Vault-mark-driven pause) | `TroveManager.sol:442-455` — `(price, oracleFailure) = priceFeed.fetchPrice(); if (oracleFailure) return;` | High — bad debt accrues with no liquidations and **no revert**, so keepers and UIs see success | Fail-closed (no wrong-price liquidation) | There is no *partial* liquidation mode. Combined with TM-C-02 (stale FX) the protocol must choose between "liquidate on a possibly stale price" and "don't liquidate at all". That trade-off is the core design risk of KR-02/KR-03 |
| **TM-C-02** | **Wrong-moment liquidation / wrongful non-liquidation on stale FX** | JPY age inside the 30h pricing window; USD collateral moves | Trove health computed with `collUsd ÷ jpyUsd`; a stale `jpyUsd` shifts every Trove's ICR at once | High — borrowers liquidated who were healthy at true FX, or unhealthy Troves not liquidated | 30h gate; 24h freeze; fuzz tests on the window | Direction of error is *systematic*, not random: if JPY/USD moved, every Trove is mispriced in the same direction. Contest-relevant if a changed file alters which price path liquidation uses |
| **TM-C-03** | **Silent cross-branch redemption shortfall** | One branch's price fails, or its unbacked portion is insufficient | `TroveManager.redeemCollateral` returns 0 on `fetchRedemptionPrice` failure (`803-804`); `CollateralRegistry.redeemCollateral` weights by per-branch unbacked portion, truncates to total unbacked, and burns only `totals.redeemedAmount` (CS-JPYDF-013) | Medium — redeemer gets partial delivery with no revert; leftover JPYdf stays with them; no re-allocation across branches | Truncation prevents over-burn; user can retry | No event on skip; a redeemer cannot tell *which* branch failed. Verify the loop cannot burn more than it delivered in any ordering |
| **TM-C-04** | **Exit narrows to `closeTrove` after shutdown**: once `hasBeenShutDown`, `_adjustTrove` (including pure repay) reverts on `_requireIsNotShutDown`, and `fetchRedemptionPrice` returns the **latched** `isOracleFailureShutdown()` flag, so normal redemption is closed even on a healthy price. `closeTrove`, by contrast, **skips the price entirely when `hasBeenShutDown`** (`BorrowerOperations.sol:732-736` only fetches when `!hasBeenShutDown`) | Shutdown plus a degraded price path | `_adjustTrove` gate (`riskIncreasing` or `hasBeenShutDown`) → `_requireOraclesLive`; `closeTrove` requires only sufficient JPYdf to repay `entireDebt` and then skips pricing + CCR | High — the *only* exit becomes "hold 100% of your debt in JPYdf and call close". A borrower who spent the borrowed JPYdf must first acquire it, and redemption (the natural source) is closed | Verified: close stays open in shutdown **[V]**; urgent redemption fails loudly rather than at a bad price | **Remaining trap:** acquiring JPYdf while redemptions are shut. Secondary-market liquidity is the only source; if it is thin, principal is effectively locked. Confirm whether any path lets a borrower repay *partially* after shutdown (today: no — `_adjustTrove` reverts) |
| **TM-C-05** | **Same-block SP gain sniping blocked, cross-block JIT allowed** | Liquidation event | `provideToSP` records `lastDepositBlock`; `withdrawFromSP` rejects same-block; `claimAllCollGains` requires zero deposit | Medium — a one-block JIT depositor dilutes long-term SP holders on every liquidation | Same-block guard (L-02 remediation) | Cross-block JIT is explicitly accepted. The residual is *economic*: capital efficiency of the guard vs. dilution |
| **TM-C-06** | **Zombie-trove redemption ordering griefing** | Troves at exactly `MIN_DEBT = 100_000e18` that cannot be fully repaid (repay clamps to `entireDebt - MIN_DEBT`) | Redemption visits the last zombie first, then sorted order, bounded by `_maxIterationsPerCollateral` | Low — gas/fairness, not solvency | Bounded iterations; single `lastZombieTroveId` slot | Whether a zombie can be used to *shield* another Trove from redemption (skip semantics) |
| **TM-C-07** | **Rate manipulation to dodge redemption** | Batch manager or whale | Redemption order is ascending interest rate (bounded 0.5%–250%); a manager can drop a batch's rate, pushing redemptions onto retail | Low/Medium — redistribution of redemption cost | Rate bounds; batch opt-in | Inherited Liquity behavior; worth stating because JPYdf's low-rate environment makes the spread small |
| **TM-C-08** | **Irreversible branch finalization** | `riskParamsFinalizer` role | `_requireBranchReadyForFinalization` (`AddressesRegistry.sol:258-296`) requires dToken/vault/underlying wiring, zero cap, zero supply, no Troves, zero debt/coll, empty SP, no shutdown, no oracle pause; one-shot | High (privileged) — wrong params are permanent for the branch | Extensive emptiness + wiring assertions | Params can be retuned by GOV afterwards per parameter class; verify which are truly immutable |
| **TM-C-09** | **L-01 regression: dToken cap set before finalization** | GOV error | `DToken.setCap(nonzero)` requires finalized params; `mint` re-checks | Medium | Two independent gates **[V]** (`DToken.sol:298-310`) | Test that `setCap` cannot be reached via any other path (e.g. upgrade) |
| **TM-C-10** | **Collateral-identity mismatch**: Vault underlying ≠ dToken underlying ≠ branch `collToken` | Deployment/finalization error | `whenUnderlyingReady` + `_requireBranchReadyForFinalization` compare them | Critical if it lands | Enforced at use time and at finalization | The *oracle* feed is not compared to the token — a right token with a wrong feed passes finalization. Verify there is a wiring assertion covering the feed |
| **TM-C-11** | **EIP-170 headroom is zero**: BO 24,576 B exactly, TM 24,568 B, Vault 23,624 B; `foundry.toml` sets `ignored_error_codes=[3860,5574]` | Any added code | Size check disabled in the local build | High (delivery risk) — a fix that compiles locally may be undeployable | CI size report (per remediation notes) | **Contest note:** a PoC that requires added production code is not deployable at the current BO size. Prefer fixes that remove code or move it to a library |

---

## 9. Threat catalogue — Z5 Zapper / entry contracts

The Zapper is a thin, stateless router. It holds tokens only transiently, but it is the contract users actually approve — so its authorization and leftover handling are the whole surface.

| ID | Threat | Preconditions | Path (code) | Impact | Controls | Residual |
|---|---|---|---|---|---|---|
| **TM-Z-01** | **Manager-triggered dust misdirection**: leftover sweep pays `msg.sender`, while withdrawal proceeds go to the owner/configured receiver | Caller is an authorized add/remove manager acting for someone else | `_setInitialTokensAndBalances` snapshots with `msg.sender` as receiver (`LeftoversSweep.sol:37-52`); `_returnLeftovers` sends excess to that receiver (`:54-64`); `_adjustTroveWithUnderlyingPost` (`CollateralYieldZapper.sol:663-682`) forwards principal to `_receiver` but leftovers to the caller | Low — dust only, and the principal destination is fixed | Receiver fixed by Trove config; snapshot prevents sweeping pre-existing balances | Whether any flow can leave *material* residue (e.g. a partial withdrawal or a refund path) that then goes to the manager rather than the owner |
| **TM-Z-02** | **Native-ETH route**: `msg.value` must equal `ETH_GAS_COMPENSATION + collAmount`; ETH is staked via Lido `submit` then wrapped with `minWstEthOut`; a failed submit reverts with the raw reason | Malicious/incorrect user input; Lido outage | `_openTroveWithNativeEthAndReferral` / `_stakeNativeEthToWstEth` (`:578-620`) | Low — user funds; worst case reverts | Exact `msg.value`; `nonReentrant`; explicit catch | Whether `receive()` is restricted to WETH/Lido (otherwise ETH can be force-sent and stranded, or used to grief the balance snapshot) |
| **TM-Z-03** | **Permit front-run**: `permit` is wrapped in try/catch and falls back to an allowance check | Mempool attacker copies the signature | `_permitOrRequireAllowance` (`:506-513`) | Low — DoS of one tx at worst | Fallback to existing allowance | Whether the fallback can be satisfied by a *stale* allowance the user forgot about — standard ERC-2612 caveat |
| **TM-Z-04** | **Referral attribution spoofing**: `_referralCode` is caller-supplied and only emitted | Any integrator | `ReferralDeposit` emits in open/adjust paths | Info — off-chain accounting | None needed on-chain | Ensure the off-chain ledger does not treat the event as authoritative for payouts |
| **TM-Z-05** | **`closeTroveToDToken` bypasses the Vault** by design (incident exit) but still needs a core price | Oracle pause | `_closeTrove` → `borrowerOperations.closeTrove` with the Zapper as receiver; collateral sent to the configured receiver | Medium — the "escape hatch" itself fails when the oracle is paused | Documented intent | The escape hatch covers *Vault* incidents, not *oracle* incidents. Both can co-occur (TM-V-09 → TM-O-08). Verify no second escape path is needed |

---

## 10. Threat catalogue — Z6/Z7 governance, bridge, distribution

| ID | Threat | Preconditions | Path | Impact | Controls | Residual |
|---|---|---|---|---|---|---|
| **TM-G-01** | **GUARDIAN freeze**: pause deposit/allocation/redeem/claim, disable a Strategy, or remove it from the whitelist | Compromised or coerced GUARDIAN | Pause flags + registry writes; unpause requires GOV (12h) | Medium — exit freeze during the worst moment | Role separation; 12h GOV recovery; no fund movement | The Guardian can pause **claims**, which are the impaired-state exit. Whether `pauseClaim` should be available to Guardian alone is a policy question |
| **TM-G-02** | **WRITEOFF as an attack primitive**: markdown depresses the price, then liquidate healthy Troves | Compromised WRITEOFF (or a panicking operator) | `writeoffStrategyPrincipal` → `backingRatio` → price (TM-O-08) → `batchLiquidateTroves` | Critical (privileged) — collateral seizure from solvent borrowers, profit to the attacker | `_minBackingRatioAfter` floor chosen by the same key; pause during writeoff | **No timelock, no second approver, no maximum markdown — and `_minBackingRatioAfter = 0` is a valid input** (`CollateralVault.sol:719` only rejects `> 1e18`) **[V]**. Recommend: two-step writeoff, a GOV-set hard floor per branch, and a liquidation freeze while a writeoff is in flight |
| **TM-G-03** | **Operator roles are destination-constrained**: ALLOCATOR, WITHDRAWER, HARVESTER, TREASURY_TRANSFER can only move value along fixed edges | Compromised operator | `allocate` → registered strategies; `transferYieldToTreasury` → current treasury, surplus-only, buffer-preserving (`CollateralVault.sol:490-520`); `sendToVault` → Vault | Low/Medium — no arbitrary redirection; can force illiquidity or skim realized yield | Destination-free arguments; paused-allocation switch | Confirm `transferYieldToTreasury` cannot dip into pending-withdrawal liquidity (the doc says it reuses `_requiredBuffer`) |
| **TM-G-04** | **GOV / upgrade compromise**: UUPS upgrade of Vault or Strategy, proxy source swap, parameter rewrites | Timelock compromise or malicious proposal passing | `_authorizeUpgrade` → GOV_ROLE; Strategy `upgrader`; Proxy `Ownable2Step` | Critical — total loss | 12h timelock, `renounceOwnership` blocked, two-step ownership | Timelock admin/canceller compromise (TM-G-08) defeats the timelock itself |
| **TM-G-05** | **Bridge mint has no cap**: `bridgeMint` checks only the minter role and recipient validity, not `cap` or `totalSupply` | Any registered minter (or a compromised one) | `JpydfToken.sol:211-216` **[V]** — `_requireCallerIsBridgeMinter(); _requireValidRecipient(...); _mint(...)` | Critical (when bridge is live) — unbounded JPYdf mint; every Trove becomes undercollateralized | Minter registry + 48h timelock; Day-1 minter set is empty | **Uncapped by design or oversight?** `DToken.mint` enforces the cap; `bridgeMint` does not. Flag as a review candidate even though the bridge is inactive at the final commit |
| **TM-G-06** | **PIL / Merkl distribution**: weights and registration by Timelock; reward-token collisions across campaigns | Misconfiguration | `PILAllocator` registers campaigns; rewards claimed to recipients | Low/Medium — stranded or misdirected incentives | Safe retention when weights are unset; prior L-02 review resolved | Whether a campaign can be registered for a token a Strategy also holds (sweep vs claim collision) |
| **TM-G-07** | **Recovery liveness depends on off-chain action**: `confirmSource` (12h), `resumeFromOracleFailure` (requires all three feeds healthy), `writeoff`, backstop top-up | Ops team unavailable; GOV timelock queued behind an incident | No on-chain auto-recovery except the backing gate passing again | High — a branch can stay paused/dark indefinitely | Events; runbooks (BUILD_AND_TEST / DR docs) | Whether any keeper-incentivized, permissionless recovery exists. Today: none for oracle pause |
| **TM-G-08** | **Timelock admin/canceller compromise** cancels a queued recovery or executes a malicious proposal inside the delay | Key compromise | Timelock roles | Critical | Multisig + 12h | Out of repo; deployment assumption |
| **TM-G-09** | **Placeholder-branch activation misordering**: open a cap while `PriceFeedPlaceholder` still answers `(1e18, false)` | GOV runbook error | `PriceFeedPlaceholder` returns a *valid* 1e18 price; `DToken.setCap` only requires finalized params, not a real feed | Critical (privileged) — borrow against collateral priced at ¥1/unit regardless of reality | Ordered runbook (cap last); placeholder is inert at cap 0 | **No on-chain assertion that the branch feed is not a placeholder.** Consider a `priceFeed != placeholder` check in `finalizeRiskParams`/`setCap` |

---

## 11. Threat catalogue — cross-cutting

| ID | Threat | Where | Impact | Controls | Residual |
|---|---|---|---|---|---|
| **TM-X-01** | **Reentrancy Vault ⇄ Strategy ⇄ venue** | `allocate` transfers then calls `deposit`; venue may call back | Critical if unguarded | Vault `nonReentrant`; Strategy `nonReentrantStrategy`; `deployUnderlying` self-call only; CEI in `_completeRedemption` | **Read-only reentrancy**: during the transfer→deposit window, `totalUnderlying` understates. No in-protocol same-tx consumer was found, but any future integration (aggregator, Zapper extension, keeper) that prices mid-call is exposed |
| **TM-X-02** | **UUPS storage-layout drift** | Vault/Strategy/DToken upgrades | Critical — silent corruption of roles, `_backstopReserve`, `_strategyCache` | Append-only convention; DToken pinned at slot 362; TM cap at slot 30 | No automated storage-layout diff in repo; verify CI runs `forge inspect storageLayout` |
| **TM-X-03** | **Underlying token behavior**: fee-on-transfer, rebasing, blacklist, paused token, >18 decimals | Any branch | Medium — accounting drift or stuck exit | Balance-delta receipts; `convertToUnderlying` scaling; per-asset decimals checks | Rebasing tokens are structurally incompatible with `A_confirmed` checks (a negative rebase makes `A < L` for *everyone*); ensure the listing policy excludes them |
| **TM-X-04** | **Gas griefing via loop bounds**: `MAX_STRATEGIES = 32`, `_maxIterationsPerCollateral` redemptions, batch liquidation array | Public callers choose array sizes | Low/Medium — self-inflicted gas; but strategy count × budget is protocol-wide (TM-V-06) | Explicit caps | Confirm the *protocol* never loops unbounded over user-supplied arrays without a cap |
| **TM-X-05** | **Monitoring blind spots**: no event on the 30h aged gate, no event when `M` goes to 0, no event when a branch is skipped in cross-branch redemption, `ShutdownCallReverted` is the only miswire signal | Incident detection | High — silent degradation is the norm, and every threat above is easier if nobody notices | Events + off-chain alerts (documented) | Enumerate the state transitions that *must* alert; see §13 |
| **TM-X-06** | **`_isPriceFeedProxy` spoofing / one-level marker** | Source confirmation | Medium — cycle or false positive | Marker function | A malicious source can implement the same getter; the guard is a safety net, not authentication |
| **TM-X-07** | **MEV on state transitions**: source switch at `confirmSource`, first redemption after impairment is visible, liquidation of the first Trove below MCR, `claim` maturity | Mempool | Medium — value extraction from users, no protocol loss | None on-chain (by design) | Whether batch/large redemptions should be commit-reveal; out of scope but worth a note |
| **TM-X-08** | **Build config vs deployed config divergence**: solc 0.8.24, cancun, optimizer 200, `via_ir` flags, size errors ignored | Delivery | High — tested != deployed | Build docs | Contest findings must reproduce at the final commit with the *documented* build; size headroom is zero (TM-C-11) |

---

## 12. Attack chains (composite scenarios)

The rows above are per-mechanism. These are the end-to-end plays an attacker actually runs, each with an explicit verdict so the reader knows where the remaining work is.

### AC-1 — Run the bank while the loss is invisible

**Goal:** exit at par from a Vault that is already impaired.
**Verdict: blocked once the impairment is visible; open in the window before it is.**

1. A Strategy loses value in a way its `estimatedTotalUnderlying()` does not yet reflect (bad debt not realized, venue share price not yet marked, withdrawal queue discount).
2. `A_confirmed` still ≥ `L_effective`, so `_requireConfirmedFullyBacked` passes and `backingRatio = 1e18`; the oracle prices dToken at full value.
3. The informed holder buys dToken at a discount on the secondary market (the market may already know) and calls `redeem` / queues a withdrawal at par.
4. The first movers are paid in full from the raw buffer; the buffer depletes.
5. When the loss becomes visible, `_requireConfirmedFullyBacked` reverts for everyone still in, and the queue is FIFO by timestamp — the loss lands on the last in line.

**Where the protocol can win:** any *deterministic* path that makes the mark lag reality. Probe, in order: (a) whether `min(est, principal)` can hide a realized loss; (b) whether the 32-strategy loop can stop early and thereby over-count; (c) whether the cache/`available` transition can present a stale high mark at the exact block a redemption lands; (d) whether `backstopDeposit` changes `A_confirmed` without changing `L_effective` in a way that re-opens the gate for a specific cohort.

### AC-2 — Mark it to zero, liquidate the branch

**Goal:** seize collateral from solvent borrowers using a governance-adjacent key.
**Verdict: open to a compromised WRITEOFF; the guards bound the *accounting*, not the *consequence*.**

1. Attacker holds WRITEOFF (or tricks the operator into a large writeoff). They first short/borrow against the branch, or pre-position to liquidate.
2. `writeoffStrategyPrincipal(strategy, amount, minBackingRatioAfter)` — requires the strategy to be disabled or allocation paused, then `_pauseUserFlows()`.
3. Backing drops to the floor the caller chose — and `_minBackingRatioAfter = 0` is accepted. If backing reaches 0, `JpyFreezeLib.applyBackingRatio` replaces the zero with **1 wei**, so the oracle serves a near-zero price instead of shutting down (`JpyFreezeLib.sol:110-118`). Nothing reverts; the branch just becomes a liquidation venue.
4. `batchLiquidateTroves` now sees every Trove below MCR and liquidates them at ~zero collateral value. The attacker (as liquidator) takes the collateral and the gas compensation.
5. `_minBackingRatioAfter` is chosen by the same key, so it does not bind an attacker — only an honest operator's fat finger.

**Why it mostly works as designed:** the Vault pauses its own flows and the writeoff is a *correct* recognition of a real loss. The design gap is that a **solvency action is allowed to become a price action with no circuit breaker**. Probe: whether writeoff can be split into recognition (accounting) and price impact (oracle), whether `_minBackingRatioAfter` has a hard lower bound, and whether liquidations should be frozen while a writeoff is in progress.

### AC-3 — Stale-FX redemption grind (KR-01)

**Goal:** buy JPYdf, redeem for collateral at an FX rate the market has already left.
**Verdict: open, bounded by the 30h window and by the re-anchoring behavior.**

1. JPY/USD moves materially (e.g. a weekend gap), but the provider still reports the old value, or reports the same value repeatedly so `lastGoodJpyUpdatedAt` keeps refreshing.
2. `fetchRedemptionPrice` sees age ≤ 30h → returns `(price, false)`; the redemption is priced as if the market had not moved.
3. If JPY weakened in reality, collateral per JPYdf is *higher* than fair on-chain → the redeemer over-collects and the remaining holders absorb it.
4. The redeemer repeats while the window lasts; each redemption burns JPYdf and removes collateral at the stale ratio.

**Verdict detail:** this is an **information/parameter** attack, not a code bug — unless a changed file alters which timestamps feed the gate, which price path the registry uses, or the ORDER of `max(stETH/USD, ETH/USD × stETH/ETH)`. Those three are the contest-relevant surfaces.

### AC-4 — Deny the exit

**Goal:** trap principal without stealing it.
**Verdict: partially open, and the sharpest liveness question in the protocol.**

Layered denial, cheapest first:

1. **Queue flood** — during any impairment, fill the FIFO queue so later requests wait `withdrawDelay`. Any holder can do this; no privilege needed.
2. **Valuation pause** — a single unreadable Strategy sets `available = false`, which the oracle treats as a pricing failure → liquidations return early, borrows revert. Requires a Strategy to break (venue outage is enough; TM-S-02).
3. **Shutdown + oracle failure** — after `hasBeenShutDown`, `_adjustTrove` reverts (including repay) and `fetchRedemptionPrice` returns the latched shutdown flag, so normal redemption is closed even with a healthy price; urgent redemption **reverts** rather than caching. The one remaining exit is `closeTrove`, which skips the price entirely in shutdown (`BorrowerOperations.sol:732-736`) — but it requires the caller to already hold 100% of `entireDebt` in JPYdf. Partial repayment is not available, and the natural way to obtain that JPYdf (redemption) is closed. Principal is therefore **soft-locked**, not hard-locked (TM-C-04, KR-03).
4. **`pauseClaim`** — GUARDIAN can pause the claim path that the impaired state depends on (TM-G-01/TM-V-10).
5. **GOV-dead** — `resumeFromOracleFailure` needs a healthy read *and* a caller; a dead governance layer makes the pause permanent.

**Probe:** whether there is any *permissionless* state transition that restores a safe price (there is not, today), and whether the combination "shutdown + oracle failure" can be reached without a prior price failure (e.g. via TM-O-08).

### AC-5 — Drain the buffer before the loss is recognized

**Goal:** make claims fail by consuming the liquidity they depend on.
**Verdict: blocked by construction, verify the edges.**

1. `_requiredBuffer` includes `pendingWithdrawals`, so allocation must leave claim liquidity on hand.
2. `transferYieldToTreasury` is surplus-only and reuses the same target.
3. `allocate` computes the send amount from `bufferBefore - targetBuffer` and caps it.

**Probe:** the *floor* term versus the *pending* term can double-count or under-count if `pendingWithdrawals` is decremented at a different point than the transfer. Also: a failed `_completeRedemption` must not decrement the request; and a `claim` must not be able to resend the same request.

### AC-6 — Poison the mark with a registered Strategy

**Goal:** make the oracle price wrong, then trade against it.
**Verdict: privileged-only, but one key is enough.**

A registered Strategy can: return a huge `est` (capped at `principal`), return 0 (markdown → price collapse), revert (pause latch), or call `receiveFromStrategy` with a mismatched amount (cache invalidation). Each maps to TM-V-05 / TM-O-08 / TM-S-01.

**Probe:** whether any *non-privileged* path can register a Strategy (registry is GOV-only — confirm), and whether a legitimate adapter can be induced by a third party to report a wrong `est` (e.g. donation-based share-price inflation in an ERC-4626 venue: a donation raises `est` above `principal`, so `min()` clips it — this specific play is **blocked**, which is worth stating explicitly).

### AC-7 — Zapper: manager dust and permit

**Verdict: low.**

1. Manager calls `adjustTroveWithUnderlying` on behalf of an owner with a withdrawal.
2. Principal goes to the owner's configured receiver; residual dust returns to the manager (`msg.sender`).
3. Amount is bounded by rounding, so this is not a theft vector — but it is worth a test to confirm no flow can leave material residue behind.

### AC-8 — Bridge the cap away

**Verdict: critical-if-live, inactive at final commit.**

1. Attacker holds a bridge minter (compromised, or a malicious L2 message path).
2. `bridgeMint` has **no cap check** (`JpydfToken.sol:211-216`): `_mint` runs unconditionally after role and recipient checks.
3. Supply inflates beyond `cap`; every Trove's debt book is now claimable for more JPYdf than the system can service; redemption denominator collapses.
4. `DToken`'s cap is untouched because it is a different token.

**Probe:** confirm that no current in-scope path can reach a minter role, and record the asymmetry (`mint` capped, `bridgeMint` uncapped) as a hardening item for the bridge activation milestone.

---

## 13. Ranked risk register

Ordered by (impact × plausibility), with current status. "Review candidate" means *worth a contest submission or an explicit spec decision*, not "confirmed bug".

| # | Threat | Severity | Likelihood | Status | Why it is where it is |
|---|---|---|---|---|---|
| 1 | TM-V-01 backing-gate bypass | Critical | Low | **Review candidate** | Highest consequence in the extension layer; the guard is cache-free, so a bypass would have to come from a path that skips it |
| 2 | TM-G-02 / TM-O-08 writeoff → liquidation cascade | Critical | P | **Review candidate** | No upper bound, no timelock, no liquidation freeze. Real loss requires a compromised key, but the *fat-finger* case is plausible |
| 3 | TM-G-05 uncapped `bridgeMint` | Critical | P/X | **Review candidate (deferred)** | Not exploitable at final commit (no minters); must be fixed before bridge activation |
| 4 | TM-S-01 valuation masking | High | X | **Known (KR-08)** | Structural; the audit surface is whether `est` can be wrong in a *deterministic* way |
| 5 | TM-C-01 / TM-C-04 liquidation halt + exit freeze | High | X | **Known (KR-02/03)** | Deliberate fail-closed design. Close is verified open in shutdown; the residual is the *JPYdf acquisition* leg and the absence of partial repayment |
| 6 | TM-V-09 / TM-O-08 over-markdown bounded only by a caller-chosen floor | High | P | **Review candidate** | Same root as #2; if #2 is accepted as policy, this is the parameter to bound |
| 7 | TM-O-06 miswire → silent branch DoS | Medium | P | **Known (KR-10)** | Event-only detection; verify monitoring |
| 8 | TM-C-02 stale-FX mispricing of every Trove | Medium | X | **Known (KR-01/04)** | Direction of error is systematic and one-directional per move |
| 9 | TM-C-03 silent cross-branch redemption shortfall | Medium | M | **Known (CS-JPYDF-013)** | No event, no re-allocation; user cannot see which branch failed |
| 10 | TM-V-03 / AC-5 buffer starvation | Medium | M | **Review candidate** | Depends on the exact `pendingWithdrawals` accounting point |
| 11 | TM-X-01 read-only reentrancy window | Medium | Low | **Review candidate** | No current trigger; a future integration makes it live |
| 12 | TM-G-09 placeholder activation ordering | Medium | P | **Review candidate (ops)** | Not a code bug, but no on-chain assertion prevents it |
| 13 | TM-O-09 30k stipend brittleness | Low | X | **Review candidate** | Silent normal-redemption disable |
| 14 | TM-Z-01 manager dust | Low | M | **Review candidate** | Dust only; cheap to test |
| 15 | TM-X-05 monitoring blind spots | Low | H | **Info** | Makes every other row worse |

---

## 14. Out of scope / explicitly not modelled

| Area | Why |
|---|---|
| Morpho / Aave / Euler / ERC-4626 venue internals | External protocols; assumed to behave as documented. Their *failure* is modelled (TM-S-02, TM-S-01), their *code* is not |
| Chainlink aggregator semantics, Lido's stETH mechanics | External; only their failure modes reach the protocol through the oracle |
| Liquity v2 core audit surface | Inherited, audited upstream; this model only covers the seam and the JPYdf-specific modifications (25 files / 535 nSLOC) |
| Deployment scripts, key management, multisig policy | Not in the repo; treated as assumptions B9/B10 |
| Frontend, indexers, referral ledger | No on-chain authority |
| Bridge message verification (L1/L2) | Bridge is inactive at the final commit; only the mint-cap asymmetry is flagged |
| Test coverage quality | Separate workstream; relevant here only as "what would have caught this" |

---

## 15. Assumptions to falsify

Each of these is a concrete experiment. A threat model is only useful if its assumptions are testable.

| # | Assumption | How to test | If false |
|---|---|---|---|
| A-01 | Every state-changing Vault entry point calls the cache-free backing guard | Enumerate `external` functions; grep for `_requireConfirmedFullyBacked` and prove coverage (including `redeemWithPermit`, `claim`, `deposit`) | Critical bypass (TM-V-01) |
| A-02 | `totalUnderlying` is never *higher* than realizable value | Mock a venue with a loss; assert `A_confirmed ≤ sum(true balances)`; fuzz `est` vs `principal` vs realized withdrawal | Over-borrow (TM-S-01) |
| A-03 | A single unreadable Strategy forces `M = 0` on every outbound path (not just allocation) | One reverting strategy; run deposit, redeem, claim, `transferYieldToTreasury`, oracle price | Partial view leak → over-send (TM-V-07) |
| A-04 | `pendingWithdrawals` is monotone-safe: incremented exactly once per request, decremented exactly once per successful payment | Fuzz queue maturity, partial settlement, reentrancy on `claim` | Buffer under-count → claim starvation (TM-V-03) |
| A-05 | No public path can set a positive dToken cap while the branch feed is the placeholder | Enumerate `setCap` callers and finalization order; attempt activation with the placeholder bound | Catastrophic mispricing (TM-G-09) |
| A-06 | `bridgeMint` is unreachable at the final commit (empty minter set, 48h timelock) | Read `JpydfToken` minter state + deploy scripts | Uncapped mint (TM-G-05) |
| A-07 | After shutdown, every exit path is either open or loudly reverts — close skips pricing, repay reverts, normal redemption is latched closed, urgent reverts | **Partially resolved [V]** for close (`BorrowerOperations.sol:732-736`); still to test: whether partial repay is unreachable, and what happens if `entireDebt` includes redistribution gains the user cannot see | Soft-locked principal (TM-C-04) |
| A-08 | The 30h JPY gate is the *only* freshness input to the normal redemption price, and the re-anchor path cannot extend it indefinitely | Trace `lastGoodJpyUpdatedAt` writes; simulate a feed repeating a value | Unbounded stale extraction (AC-3) |
| A-09 | Cross-branch redemption can never burn more JPYdf than it delivers, in any branch ordering | Fuzz branch price-failure combinations; assert `burned ≤ delivered` | Value destruction (TM-C-03) |
| A-10 | A registered Strategy cannot move Vault assets anywhere but the Vault | Grep every `safeTransfer` in Strategies against the Vault address; test `emergencyWithdraw`, `sendToVault`, `sweepRewardToken` | Principal theft (TM-S-04) |
| A-11 | The UUPS layout matches between base and upgrade in this diff | `forge inspect storageLayout` on both commits; diff slots and gaps | Storage corruption (TM-X-02) |
| A-12 | One `_completeRedemption` call settles exactly one request, so a blacklisted recipient cannot block others | **Resolved [V]**: `_completeRedemption` (`CollateralVault.sol:1009-1032`) queues at most one request and pays one receiver; `claim(uint256)` pays one owner. Re-test only if a batch-settlement path is added | Batch DoS (TM-V-08) |

---

## 16. Invariant ↔ threat matrix

Which invariant (from §1.4) each threat family breaks.

| Invariant | Broken by | Primary defence |
|---|---|---|
| 1. `backingRatio ≤ 1`, guard blocks user flows | TM-V-01, TM-V-02, TM-S-01 | Cache-free `A_confirmed`; live-only valuation |
| 2. Cache never admits a user flow | TM-V-01, TM-V-07 | `_requireConfirmedFullyBacked` vs `_managedUnderlying` split |
| 3. No user action can remove value when impaired | TM-V-03, TM-V-08, AC-5 | Pre-state guard + CEI + queue |
| 4. Pending claims are inside the buffer requirement | TM-V-03, TM-G-03 | Additive `_requiredBuffer` |
| 5. No flow consumes an "unreliable" price | TM-O-06, TM-O-07, TM-C-01, TM-C-04 | Failure bool + Proxy revert paths |
| 6. Strategies can only send toward the Vault | TM-S-04, TM-S-07, TM-V-05 | `receiveFromStrategy` gating; hard-coded Vault destination |
| 7. Finalization is one-shot and empty-branch-only | TM-C-08 | `_requireBranchReadyForFinalization` |
| 8. Bridge supply changes are capped/watched | TM-G-05 | **Gap**: no cap in `bridgeMint`; only the minter registry |

---

## 17. Open questions for the review itself

These are the questions I would put in front of an auditor on day one, ordered by expected yield:

1. ~~Is `_completeRedemption` per-request or batched?~~ **Answered [V]**: per-request. A blacklisted recipient isolates to their own claim. The remaining question is whether a *fee-on-transfer* underlying mis-sizes the queue (the shortfall is recorded as `needed - nominalSent`, not as the receiver delta — `:1015-1029`).
2. **Exact `pendingWithdrawals` lifecycle** versus the buffer target — the only place a claim can be starved (TM-V-03, A-04).
3. **Does any writeoff path let the caller choose a markdown that is not bounded by a GOV-set floor?** (TM-G-02, TM-V-09)
4. **Can a registered Strategy be induced to report a stale-high `est`** without the operator noticing — i.e. is there any *third-party* trigger (donation, share-price inflation, venue pause) that changes `est` while `principal` stays put? (TM-S-01, AC-6)
5. ~~The shutdown × oracle-failure overlap~~ **Answered [V]** for the close path: `closeTrove` skips pricing when shutdown (`BorrowerOperations.sol:732-736`). The open question is now the *JPYdf acquisition* leg: can a borrower who spent the borrowed JPYdf obtain it while normal + urgent redemption are closed, and is partial repay-after-shutdown deliberately impossible? (TM-C-04, A-07)
6. **Does `_requireBranchReadyForFinalization` assert the price feed is not the placeholder?** (TM-G-09, A-05)
7. **Is `bridgeMint`'s missing cap intentional?** (TM-G-05)
8. **Gas budget × `MAX_STRATEGIES`** — is the worst-case pricing call still under the block gas limit? (TM-V-06)
9. **Zapper leftover receiver semantics** for manager-driven flows (TM-Z-01).
10. **Read-only reentrancy**: is `totalUnderlying` (or the oracle price) ever consumed mid-`allocate`? (TM-X-01)
11. **The zero-backing policy**: a *genuine* total loss → 1-wei price → full-book liquidation is an argued design choice in `JpyFreezeLib`. The *non-genuine* zero (over-writeoff, mis-set `_minBackingRatioAfter`, or a Strategy reporting 0 while assets are recoverable) reaches the same outcome with no distinguishing check. Is there a code-level way to tell the two apart at pricing time — e.g. require a writeoff to be accompanied by a GOV-signed loss attestation, or freeze liquidations while the Vault's incident pause is active?

---

## 18. Maintenance

- This model is written against the **final commit** (`1b453c10…`) and the **25-file / 535-nSLOC diff** in `SCOPE.md`. If the diff changes, re-check the rows that cite `CollateralVault.sol`, `PriceFeedProxy.sol`, `JpydfToken.sol`, and `CollateralRegistry.sol` first — those carry the highest-consequence claims.
- Evidence tags are load-bearing. **Do not upgrade `[A]` to `[V]` without a line reference**, and do not cite a doc ID (KR-*, CS-JPYDF-*, VAULT-SEC-*) unless it is quoted in `CONTEXT.md` or verified in `docs/`.
- Everything in §15 is intended to become a test or a spec decision. When one is resolved, move the row to `docs/known-issues.md`-style status rather than deleting it — the reasoning is the asset.
- No dynamic analysis was performed. Any claim that depends on gas, on venue behavior, or on live feed behavior is best-effort and should be re-derived by running the suite once `forge` and `lib/` are available.
