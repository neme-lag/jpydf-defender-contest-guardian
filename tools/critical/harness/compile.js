'use strict';
// Solidity compilation through solc-js, using the repository's own remappings.
// No network, no Foundry, no binaries: the compiler is the official npm wasm build.

const fs = require('fs');
const path = require('path');
const solc = require('solc');

const HERE = __dirname;
const CONTRACTS = path.resolve(HERE, '../../../packages/contracts');

function loadRemappings() {
  const file = path.join(CONTRACTS, 'remappings.txt');
  const lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.map((l) => {
    const [from, to] = l.split('=');
    return [from, to];
  });
}

const REMAP = loadRemappings();

function resolveSource(importPath) {
  for (const [from, to] of REMAP) {
    if (importPath.startsWith(from)) return path.join(CONTRACTS, to + importPath.slice(from.length));
  }
  return path.join(CONTRACTS, importPath);
}

const cache = new Map();

/**
 * Compile one entry source (e.g. "src/CollateralVault.sol") and return
 * { "src/CollateralVault.sol:CollateralVault": { abi, bytecode } }.
 */
function compile(entry, settings = {}) {
  const key = entry + JSON.stringify(settings);
  if (cache.has(key)) return cache.get(key);

  const input = {
    language: 'Solidity',
    sources: { [entry]: { content: fs.readFileSync(resolveSource(entry), 'utf8') } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
      ...settings,
    },
  };

  const findImports = (p) => {
    try {
      return { contents: fs.readFileSync(resolveSource(p), 'utf8') };
    } catch (e) {
      return { error: `not found: ${p}` };
    }
  };

  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) {
    const msg = errors.map((e) => e.formattedMessage).join('\n');
    throw new Error(`solc failed for ${entry}:\n${msg}`);
  }

  const contracts = {};
  for (const file of Object.keys(out.contracts)) {
    for (const name of Object.keys(out.contracts[file])) {
      const c = out.contracts[file][name];
      contracts[`${file}:${name}`] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
    }
  }
  cache.set(key, contracts);
  return contracts;
}

/** Find one contract by name across an entry, e.g. get('src/CollateralVault.sol', 'CollateralVault'). */
function get(entry, name) {
  const all = compile(entry);
  const hit = all[`${entry}:${name}`];
  if (!hit) throw new Error(`contract ${name} not found in ${entry}`);
  return hit;
}

module.exports = { compile, get, CONTRACTS };
