# Critical PoC harness (Foundry-free)

Fallback runner for the critical-bug workflow when `forge`/`cast` are unavailable. Pure JavaScript:
**solc-js** compiles the repository's Solidity, **@ethereumjs/vm** executes it. No network at run
time, no downloaded binaries, no JSON-RPC node.

Used by [`../../CRITICAL-BUG-WORKFLOW.md`](../../CRITICAL-BUG-WORKFLOW.md). Foundry remains the
preferred runner; port any PoC to `packages/contracts/test/critical/` when it is available. The
assertions are the deliverable, not the harness.

## Quick start

```bash
cd tools/critical
npm install          # solc 0.8.24, @ethereumjs/vm 8, ethers 6
node smoke.test.js
```

Expected output:

```
CollateralVault runtime: 24216 bytes (EIP-170 headroom 360)
DToken          runtime: 12108 bytes (EIP-170 headroom 12468)
getStrategiesCount() -> 0
dToken.cap() -> 0
initialize() on implementation reverted with: Error(Initializable: contract is already initialized)
proxy(delegatecall) getStrategiesCount() -> 0

Harness OK: compile, deploy, proxy delegatecall, call, revert-decode all work.
```

## Prerequisites

Solidity sources import from `packages/contracts/lib/`, which is gitignored. Install it once:

```bash
python3 packages/contracts/setup.py     # clones the 5 pinned libs (~10 s)
```

## API

```js
const { compile } = require('./harness/compile');
const { Evm } = require('./harness/evm');

const evm = await Evm.create();                                   // cancun, chainId 31337
const V = compile('src/CollateralVault.sol')['src/CollateralVault.sol:CollateralVault'];

const vault = await evm.deploy(V);                                // { address, addressHex, bytecode }
const proxy = await evm.deploy(ProxyArtifact, [vault.addressHex, '0x']);
evm.attach(proxy.addressHex, V);                                  // proxy carries no logic ABI

await evm.call(proxy.address, 'getStrategiesCount()');            // decodes return values
await evm.expectRevert(vault.address, 'initialize(address,address,address,address)', [a, b, c, d]);
evm.setTimestamp(1_800_000_000); evm.advance(86_400);             // withdrawDelay, JPY staleness
await evm.storage(proxy.address, 0);                              // raw slot read
```

- `call` / `expectRevert` accept ethereumjs `Address` objects or hex strings.
- Custom errors decode through the bound ABI; `Error(string)` and `Panic(uint256)` are handled explicitly.
- Every call uses a fresh funded EOA, so `CREATE` addresses never collide between deploys.

## Known constraints

| Constraint | Detail |
|---|---|
| Upgradeable OZ is 4.x | `_disableInitializers()` reverts with the **string** `"Initializable: contract is already initialized"`, not `InvalidInitialization()` |
| ganache is not usable | ganache 7.9.2 fails on Node 22 (`uws_linux_x64_127.node` missing). Do not retry it |
| Foundry is not installable here | release assets redirect to a host that is unreachable; compile via `solc-js` instead |
| No test fixtures | this contest snapshot ships only 5 oracle test files; Vault/core harnesses must be built |
| Contract size | Vault runtime is 24,216 B — 360 B under EIP-170. A PoC must not require production code growth |

## Tier-1 deployment order (Vault + dToken)

The initializers are circular, so follow this order:

1. deploy Vault implementation → deploy `ERC1967Proxy` with **empty** init data;
2. deploy DToken implementation → proxy → `DToken.initialize(vaultProxy, owner)`;
3. `vaultProxy.initialize(underlying, dToken, treasury, admin)` — checks `dToken.vault() == this`;
4. allow the underlying on the dToken, then `setTokenInfo(name, symbol, underlying)`;
5. `vault.setUnderlying(underlying)` → wire roles → register a mock Strategy.

## Layout

```
tools/critical/
├── package.json
├── smoke.test.js      # harness self-test (must pass before any PoC work)
└── harness/           # named 'harness', not 'lib' — the repo gitignores **/lib
    ├── compile.js     # solc-js + packages/contracts/remappings.txt
    └── evm.js         # deploy / call / expectRevert / timestamps / storage
```

PoCs belong in `poc_<target>.js` files; prefix them with the workflow card id (e.g. `poc_C01_backing_guard.js`).
