'use strict';
// Smoke test for the harness itself. If this passes, the compile+execute path is usable
// for PoCs: contracts deploy, views decode, custom errors decode.
//
// Run: cd tools/critical && npm install && node smoke.test.js

const assert = require('assert');
const { compile } = require('./harness/compile');
const { Evm } = require('./harness/evm');

const EIP170 = 24576;

(async () => {
  const evm = await Evm.create();

  const vaultArtifacts = compile('src/CollateralVault.sol');
  const dtokenArtifacts = compile('src/DToken.sol');
  const Vault = vaultArtifacts['src/CollateralVault.sol:CollateralVault'];
  const DToken = dtokenArtifacts['src/DToken.sol:DToken'];

  const vault = await evm.deploy(Vault);
  const dtoken = await evm.deploy(DToken);

  const vaultCode = await evm.code(vault.address);
  const dtokenCode = await evm.code(dtoken.address);

  console.log(`CollateralVault runtime: ${vaultCode.size} bytes (EIP-170 headroom ${EIP170 - vaultCode.size})`);
  console.log(`DToken          runtime: ${dtokenCode.size} bytes (EIP-170 headroom ${EIP170 - dtokenCode.size})`);
  assert(vaultCode.size > 0 && vaultCode.size <= EIP170, 'vault must deploy under EIP-170');

  // View call without arguments.
  const strategyCount = await evm.call(vault.address, 'getStrategiesCount()');
  assert.strictEqual(strategyCount, 0n, 'fresh vault has no strategies');
  console.log('getStrategiesCount() ->', strategyCount.toString());

  // View call with an argument and a decoded struct/scalar return: DToken conversion needs config,
  // so we exercise the uninitialized read path instead (cap == 0).
  const cap = await evm.call(dtoken.address, 'cap()');
  assert.strictEqual(cap, 0n, 'fresh dToken has zero cap');
  console.log('dToken.cap() ->', cap.toString());

  // Custom-error decoding: the implementation disables initializers in its constructor.
  const reverted = await evm.expectRevert(vault.address, 'initialize(address,address,address,address)', [
    '0x0000000000000000000000000000000000000001',
    '0x0000000000000000000000000000000000000002',
    '0x0000000000000000000000000000000000000003',
    '0x0000000000000000000000000000000000000004',
  ]);
  console.log('initialize() on implementation reverted with:', `${reverted.custom.name}(${reverted.custom.args.join(', ')})`);
  assert(reverted.custom, 'revert reason must decode');
  assert(
    reverted.custom.name === 'InvalidInitialization' || /already initialized/i.test(String(reverted.custom.args[0])),
    `expected an already-initialized revert, got ${JSON.stringify(reverted.custom)}`
  );

  // Tier-1 recipe step 1: implementation + ERC1967 proxy with empty init data.
  const Proxy = compile('lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol')[
    'lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy'
  ];
  const proxy = await evm.deploy(Proxy, [vault.addressHex, '0x']);
  evm.attach(proxy.addressHex, Vault); // proxy bytecode carries no logic ABI
  const proxiedCount = await evm.call(proxy.address, 'getStrategiesCount()');
  console.log('proxy(delegatecall) getStrategiesCount() ->', proxiedCount.toString());
  assert.strictEqual(proxiedCount, 0n, 'proxy must delegate to the implementation');

  console.log('\nHarness OK: compile, deploy, proxy delegatecall, call, revert-decode all work.');
})().catch((e) => {
  console.error('\nSMOKE FAILED:', e.message);
  process.exit(1);
});
