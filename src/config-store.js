import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_RETRY = {
  enabled: false, statusRules: [], codeRules: [], messageRules: [], maxRetries: 2,
  baseDelayMs: 250, exponentialBackoff: true, maxDelayMs: 5000,
  totalTimeoutMs: 30000, preflightBytes: 262144, preflightMs: 10000,
};

export function defaultConfig(upstreamUrl) {
  return {
    version: 1, upstreamUrl: upstreamUrl || '', promptRules: [], retry: { ...structuredClone(DEFAULT_RETRY), preflightBytes: integerBetween(process.env.MAX_SSE_PREFLIGHT_BYTES, 1024, 16 * 1024 * 1024, DEFAULT_RETRY.preflightBytes), preflightMs: integerBetween(process.env.MAX_SSE_PREFLIGHT_MS, 100, 120000, DEFAULT_RETRY.preflightMs) },
    metrics: { requests: 0, promptHits: 0, retries: 0, retrySuccesses: 0, retryExhausted: 0 },
  };
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

export class ConfigStore {
  constructor(dataDir, upstreamUrl) {
    this.dataDir = dataDir; this.file = path.join(dataDir, 'config.json'); this.adminFile = path.join(dataDir, 'admin.json');
    this.config = defaultConfig(upstreamUrl); this.writeChain = Promise.resolve(); this.operationChain = Promise.resolve();
  }
  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try { this.config = normalizeConfig(JSON.parse(await fs.readFile(this.file, 'utf8')), this.config); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await this.persist(this.config); }
    await this.ensureAdmin();
  }
  snapshot() { return clone(this.config); }
  async update(mutator) {
    const operation = this.operationChain.then(async () => {
      const previous = this.config; const next = clone(previous); const value = await mutator(next);
      const candidate = normalizeConfig(value || next, previous); await this.persist(candidate); this.config = candidate; return this.snapshot();
    });
    this.operationChain = operation.catch(() => {}); return operation;
  }
  async persist(config = this.config) {
    const data = JSON.stringify(config, null, 2);
    const write = this.writeChain.catch(() => {}).then(async () => { const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`; await fs.writeFile(temp, data, { mode: 0o600 }); await fs.rename(temp, this.file); });
    this.writeChain = write.catch(() => {}); return write;
  }
  async incrementMetric(name, amount = 1) { return this.update((next) => { if (Object.hasOwn(next.metrics, name)) next.metrics[name] += amount; return next; }); }
  async ensureAdmin() {
    try { this.admin = JSON.parse(await fs.readFile(this.adminFile, 'utf8')); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const username = process.env.ADMIN_USERNAME; const password = process.env.ADMIN_PASSWORD;
    if (!username || !password || password.length < 12) throw new Error('First start requires ADMIN_USERNAME and ADMIN_PASSWORD (minimum 12 characters)');
    this.admin = { username, passwordHash: await hashPassword(password), createdAt: new Date().toISOString() };
    await writeAtomic(this.adminFile, this.admin);
  }
  async verifyAdmin(username, password) { return Boolean(this.admin && username === this.admin.username && await verifyPassword(password, this.admin.passwordHash)); }
}

function normalizeConfig(input, fallback) {
  const source = input && typeof input === 'object' ? input : {}; const retry = source.retry && typeof source.retry === 'object' ? source.retry : {};
  return {
    version: 1, upstreamUrl: typeof source.upstreamUrl === 'string' ? source.upstreamUrl : fallback.upstreamUrl,
    promptRules: Array.isArray(source.promptRules) ? source.promptRules.filter(validPromptRule).map((r) => ({ id: r.id || crypto.randomUUID(), modelId: r.modelId, prompt: r.prompt, enabled: Boolean(r.enabled), createdAt: r.createdAt || new Date().toISOString(), updatedAt: r.updatedAt || new Date().toISOString(), hits: Number(r.hits) || 0 })) : [],
    retry: { ...(fallback.retry || DEFAULT_RETRY), ...retry, statusRules: normalizeStatusRules(retry.statusRules ?? fallback.retry?.statusRules), codeRules: normalizeErrorRules(retry.codeRules), messageRules: normalizeErrorRules(retry.messageRules), maxRetries: integerBetween(retry.maxRetries, 0, 10, 2), baseDelayMs: integerBetween(retry.baseDelayMs, 0, 60000, 250), maxDelayMs: integerBetween(retry.maxDelayMs, 0, 300000, 5000), totalTimeoutMs: integerBetween(retry.totalTimeoutMs, 100, 3600000, 30000), preflightBytes: integerBetween(retry.preflightBytes, 1024, 16 * 1024 * 1024, 262144), preflightMs: integerBetween(retry.preflightMs, 100, 120000, 10000), enabled: Boolean(retry.enabled), exponentialBackoff: retry.exponentialBackoff !== false },
    metrics: { ...fallback.metrics, ...(source.metrics || {}) },
  };
}
function validPromptRule(r) { return r && typeof r.modelId === 'string' && r.modelId.length > 0 && r.modelId.length <= 512 && typeof r.prompt === 'string'; }
function normalizeStatusRules(rules) { return Array.isArray(rules) ? rules.map((rule) => ({ id: rule?.id || crypto.randomUUID(), status: Number(rule?.status ?? rule?.value), enabled: rule?.enabled !== false })).filter((rule) => Number.isInteger(rule.status) && rule.status >= 400 && rule.status <= 599) : []; }
function normalizeErrorRules(rules) { return Array.isArray(rules) ? rules.filter((r) => r && typeof r.value === 'string' && r.value.length <= 512).map((r) => ({ id: r.id || crypto.randomUUID(), value: r.value, mode: r.mode === 'substring-ci' ? 'substring-ci' : 'exact', enabled: r.enabled !== false })) : []; }
function integerBetween(value, min, max, fallback) { const n = Number(value); return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback; }

async function writeAtomic(file, value) { const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); await fs.rename(temp, file); }

export async function hashPassword(password) { const salt = crypto.randomBytes(16).toString('hex'); const derived = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (e, key) => e ? reject(e) : resolve(key.toString('hex')))); return `scrypt$${salt}$${derived}`; }
export async function verifyPassword(password, encoded) { const [, salt, expected] = String(encoded || '').split('$'); if (!salt || !expected) return false; const actual = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (e, key) => e ? reject(e) : resolve(key.toString('hex')))); return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex')); }
