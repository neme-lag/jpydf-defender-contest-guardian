'use strict';
// Minimal EVM harness: deploy + call Solidity from Node with @ethereumjs/vm.
// Purpose: execute PoCs for the critical-bug workflow when Foundry is unavailable.
// Deliberately small — no JSON-RPC, no fixtures, no cheatcodes. Extend as needed.

const { VM } = require('@ethereumjs/vm');
const { Common, Hardfork } = require('@ethereumjs/common');
const { Block } = require('@ethereumjs/block');
const { Account, Address, hexToBytes, bytesToHex } = require('@ethereumjs/util');
const { Interface, AbiCoder, getAddress } = require('ethers');

/** Accept ethereumjs Address objects, hex strings, or 0x-checksummed addresses. */
function toHexAddress(a) {
  if (typeof a === 'string') return getAddress(a);
  if (a && a.bytes) return getAddress(bytesToHex(a.bytes));
  throw new Error('unusable address argument: ' + String(a));
}

const GAS = 30_000_000n;

class Evm {
  constructor(vm, common) {
    this.vm = vm;
    this.common = common;
    this.timestamp = 1_700_000_000n;
    this.counter = 1;
    this.accounts = new Map(); // address -> Interface (for revert decoding)
  }

  static async create({ chainId = 31337, timestamp = 1_700_000_000 } = {}) {
    const common = Common.custom({ chainId }, { hardfork: Hardfork.Cancun });
    const vm = await VM.create({ common });
    const evm = new Evm(vm, common);
    evm.timestamp = BigInt(timestamp);
    return evm;
  }

  /** Deterministic funded EOA; each call gets a fresh one so CREATE addresses never collide. */
  async signer(tag = '') {
    const salt = tag || String(this.counter++);
    const hex = Buffer.from(`jpydf-${salt}`).toString('hex').padEnd(40, '0').slice(0, 40);
    const address = new Address(hexToBytes('0x' + hex));
    const existing = await this.vm.stateManager.getAccount(address);
    if (!existing) await this.vm.stateManager.putAccount(address, new Account(0n, 10n ** 24n));
    return address;
  }

  block() {
    return Block.fromBlockData({ header: { timestamp: this.timestamp } }, { common: this.common });
  }

  setTimestamp(ts) {
    this.timestamp = BigInt(ts);
  }

  advance(seconds) {
    this.timestamp += BigInt(seconds);
  }

  /**
   * Deploy a compiled contract.
   * @param {{abi: any[], bytecode: string}} contract
   * @param {any[]} args constructor arguments
   * @param {object} opts { value }
   */
  async deploy(contract, args = [], opts = {}) {
    const coder = AbiCoder.defaultAbiCoder();
    const ctorArgs = args.map((a) => (a && a.bytes ? toHexAddress(a) : a));
    const encoded = args.length ? coder.encode(this._ctorTypes(contract.abi), ctorArgs).slice(2) : '';
    const caller = await this.signer(`deploy-${this.counter++}`);
    const res = await this.vm.evm.runCall({
      caller,
      data: hexToBytes(contract.bytecode + encoded),
      value: BigInt(opts.value || 0),
      gasLimit: GAS,
      block: this.block(),
    });
    const err = res.execResult.exceptionError;
    if (err) throw new Error(`deploy failed: ${err.error} ${this._revertData(res.execResult)}`);
    const address = res.createdAddress;
    if (!address) throw new Error('deploy produced no address');
    this.accounts.set(toHexAddress(address), new Interface(contract.abi));
    return {
      address,
      addressHex: toHexAddress(address),
      createdAt: address.toString(),
      bytecode: await this.code(address),
    };
  }

  _ctorTypes(abi) {
    const ctor = abi.find((x) => x.type === 'constructor');
    return ctor ? ctor.inputs.map((i) => i.type) : [];
  }

  _iface(address) {
    return this.accounts.get(toHexAddress(address));
  }

  /**
   * Bind an ABI to an address that was deployed with a different ABI — the normal case for
   * UUPS proxies, where the proxy bytecode is generic and the logic ABI lives on the impl.
   */
  attach(address, contract) {
    this.accounts.set(toHexAddress(address), new Interface(contract.abi));
    return address;
  }

  /** Raw call; returns { ok, data (hex), gasUsed, logs }. */
  async rawCall(to, data, opts = {}) {
    const caller = opts.caller || (await this.signer(`call-${this.counter++}`));
    const res = await this.vm.evm.runCall({
      caller,
      to: to instanceof Address ? to : new Address(hexToBytes(toHexAddress(to))),
      data: typeof data === 'string' ? hexToBytes(data) : data,
      value: BigInt(opts.value || 0),
      gasLimit: opts.gasLimit || GAS,
      block: this.block(),
    });
    const out = res.execResult;
    return {
      ok: !out.exceptionError,
      error: out.exceptionError ? out.exceptionError.error : null,
      data: bytesToHex(out.returnValue),
      revertData: this._revertData(out),
      gasUsed: out.executionGasUsed,
      logs: out.logs,
    };
  }

  _revertData(execResult) {
    if (!execResult.returnValue || execResult.returnValue.length === 0) return '';
    return bytesToHex(execResult.returnValue);
  }

  /** Call a function and decode the return values. Throws on revert unless opts.allowRevert. */
  async call(to, signature, args = [], opts = {}) {
    const iface = this._iface(to);
    const callArgs = args.map((a) => (a && a.bytes ? toHexAddress(a) : a));
    const data = iface.encodeFunctionData(signature, callArgs);
    const res = await this.rawCall(to, data, opts);
    if (!res.ok) {
      if (opts.allowRevert) return { reverted: true, ...res, decodedError: this._decodeError(iface, res.revertData) };
      throw new Error(`${signature} reverted (${res.error}) ${res.decodedError || res.revertData}`);
    }
    const decoded = iface.decodeFunctionResult(signature, res.data);
    return decoded.length === 1 ? decoded[0] : decoded;
  }

  /** Call expecting revert; returns the decoded custom error name + args if any. */
  async expectRevert(to, signature, args = [], opts = {}) {
    const iface = this._iface(to);
    const callArgs = args.map((a) => (a && a.bytes ? toHexAddress(a) : a));
    const data = iface.encodeFunctionData(signature, callArgs);
    const res = await this.rawCall(to, data, opts);
    if (res.ok) throw new Error(`expected revert from ${signature}, call succeeded`);
    return { error: res.error, custom: this._decodeError(iface, res.revertData), revertData: res.revertData };
  }

  _decodeError(iface, revertData) {
    if (!revertData || revertData === '0x') return null;
    // Solidity built-ins first: Error(string) and Panic(uint256).
    const selector = revertData.slice(0, 10);
    if (selector === '0x08c379a0') {
      try {
        return { name: 'Error', args: [AbiCoder.defaultAbiCoder().decode(['string'], '0x' + revertData.slice(10))[0]] };
      } catch (e) {
        return { name: 'Error', args: [] };
      }
    }
    if (selector === '0x4e487b71') {
      try {
        return { name: 'Panic', args: [AbiCoder.defaultAbiCoder().decode(['uint256'], '0x' + revertData.slice(10))[0].toString()] };
      } catch (e) {
        return { name: 'Panic', args: [] };
      }
    }
    try {
      const parsed = iface.parseError(revertData);
      return parsed ? { name: parsed.name, args: parsed.args.map(String) } : null;
    } catch (e) {
      return null;
    }
  }

  async code(address) {
    const code = await this.vm.stateManager.getContractCode(
      address instanceof Address ? address : new Address(hexToBytes(getAddress(address)))
    );
    return { size: code.length, hex: bytesToHex(code) };
  }

  async balance(address) {
    const acc = await this.vm.stateManager.getAccount(
      address instanceof Address ? address : new Address(hexToBytes(getAddress(address)))
    );
    return acc ? acc.balance : 0n;
  }

  async setBalance(address, value) {
    const addr = address instanceof Address ? address : new Address(hexToBytes(getAddress(address)));
    const acc = await this.vm.stateManager.getAccount(addr);
    await this.vm.stateManager.putAccount(addr, new Account(acc ? acc.nonce : 0n, BigInt(value)));
  }

  async storage(address, slot) {
    const res = await this.vm.stateManager.getContractStorage(
      address instanceof Address ? address : new Address(hexToBytes(getAddress(address))),
      hexToBytes('0x' + BigInt(slot).toString(16).padStart(64, '0'))
    );
    return BigInt(bytesToHex(res));
  }
}

module.exports = { Evm, GAS, toHexAddress };
