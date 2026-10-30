# JPYdf

DeltaForesight's JPYdf smart contracts, extracted for the Guardian Defender contest.

## Build and Test

Requires Git, Python 3.9+ and [Foundry 1.7.1](https://github.com/foundry-rs/foundry/releases/tag/v1.7.1). Run from the repository root:

```sh
python3 packages/contracts/setup.py
forge build --root packages/contracts
forge test --root packages/contracts --threads 1 -vv
```

Dependencies are pinned in `foundry.lock`. No RPC endpoint or wallet key is needed. Add proofs of concept under `packages/contracts/test/`.

## Documentation

- [Protocol context brief](CONTEXT.md) — consolidated protocol model, architecture, parameters,
  invariants, known risks, and scope notes assembled from this repository's docs and source
- [Threat model](THREAT_MODEL.md) — assets, adversaries, trust boundaries, per-zone threat
  catalogue, attack chains, ranked residual risks, and assumptions to falsify
- [Critical-bug workflow](CRITICAL-BUG-WORKFLOW.md) — critical-only execution plan: ranked targets,
  reproduce-or-kill loop, work cards, evidence bar, and a Foundry-free PoC harness
- [Changes in scope](docs/review-boundaries.md)
- [Client’s original review scope](SCOPE.md) — historical main-review context; the contest scope above controls eligibility. Links and commands in this file refer to the original audit package.
- [Contracts in scope](docs/contracts-scope.md)
- [Previously reported findings](docs/known-issues.md)
- [Protocol specifications](docs/protocol/spec/)

Eligibility is limited to the baseline-to-final changes in the listed files, including their interactions with unchanged code. Findings must reproduce at the final commit. Full source is included for building and testing; the included tests cover selected oracle behavior.
