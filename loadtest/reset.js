#!/usr/bin/env node
'use strict';

// Resets Postgres + Redis stock/claim state between load test runs.
// Goes through `docker compose exec` (psql / redis-cli already inside those
// containers) instead of opening DB ports to the host or adding a backend
// endpoint — this is test housekeeping, not simulated user traffic.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const COMPOSE_FILE = path.join(ROOT, 'deploy', 'docker-compose.yml');
const ENV_FILE = path.join(ROOT, 'deploy', '.env');
const SEED_FILE = path.join(ROOT, 'backend', 'data', 'products-seed.json');

function loadEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return env;
}

function compose(...args) {
  return execFileSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    encoding: 'utf-8',
  });
}

function scanKeys(pattern) {
  return compose('exec', '-T', 'redis', 'redis-cli', '--scan', '--pattern', pattern)
    .split('\n')
    .map((k) => k.trim())
    .filter(Boolean);
}

function main() {
  const env = loadEnv(ENV_FILE);
  const pgUser = env.POSTGRES_USER || 'flash_sale';
  const pgDb = env.POSTGRES_DB || 'flash_sale';
  const products = JSON.parse(fs.readFileSync(SEED_FILE, 'utf-8'));

  console.log('Resetting Postgres (orders truncated, remaining_stock restored)...');
  compose(
    'exec', '-T', 'postgres',
    'psql', '-U', pgUser, '-d', pgDb,
    '-c', 'TRUNCATE orders RESTART IDENTITY; UPDATE products SET remaining_stock = available_stock;',
  );

  console.log('Resetting Redis stock/claim state...');
  for (const p of products) {
    compose('exec', '-T', 'redis', 'redis-cli', 'SET', `cache:stock:${p.productId}`, String(p.availableStock));
    compose('exec', '-T', 'redis', 'redis-cli', 'DEL', `cache:claim:${p.productId}`);
  }

  console.log('Clearing template + metrics cache so hit ratios start clean...');
  const templateKeys = scanKeys('cache:template:*');
  if (templateKeys.length) compose('exec', '-T', 'redis', 'redis-cli', 'DEL', ...templateKeys);

  const metricKeys = scanKeys('cache:m:*');
  if (metricKeys.length) compose('exec', '-T', 'redis', 'redis-cli', 'DEL', ...metricKeys);

  console.log('Reset complete.');
}

main();
