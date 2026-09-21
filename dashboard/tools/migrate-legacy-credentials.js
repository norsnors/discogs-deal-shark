'use strict';

// Marketplace credentials are stored per Electron user-data profile and encrypted with that
// profile's own key, so renaming the app (Deal Watcher -> Deal Shark, and the dev-mode
// discogs-deal-dashboard folder) strands them: main.js only falls back to a legacy profile when
// the new one is completely empty, and the encrypted blob cannot simply be copied across.
//
// This tool re-encrypts instead of copying. Electron's safeStorage on Windows writes Chromium
// OSCrypt "v10" envelopes: AES-256-GCM under a random profile key that itself lives DPAPI-wrapped
// in that profile's Local State. So the migration is: unwrap the source key, decrypt, re-encrypt
// under the destination key, write. Plaintext secrets stay in memory and are never printed.
//
//   node dashboard/tools/migrate-legacy-credentials.js            # report what would move
//   node dashboard/tools/migrate-legacy-credentials.js --apply    # actually move it

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CREDENTIAL_FILES = ['ebay-credentials.json', 'tradera-credentials.json', 'marktplaats-credentials.json'];
// Marketplace preferences live in settings.json in the clear. A stranded credential is useless if
// the marketplace it belongs to is still switched off in the destination profile.
const SETTINGS_PREFIXES = ['ebay', 'tradera', 'marktplaats'];
const DEFAULT_TARGET = 'Discogs Deal Shark';
const LEGACY_PROFILES = ['Discogs Deal Watcher', 'discogs-deal-dashboard', 'Electron'];
const KEY_PREFIX = Buffer.from('DPAPI', 'ascii');
const ENVELOPE_PREFIX = Buffer.from('v10', 'ascii');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function appDataDir() {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// DPAPI is not exposed to Node. PowerShell reaches the same CryptUnprotectData the browser used,
// and the unwrapped key comes back over stdout as base64 rather than being written anywhere.
function dpapiUnprotect(blob) {
  const script = '$ErrorActionPreference = "Stop";'
    + 'Add-Type -AssemblyName System.Security;'
    + '$in = [Console]::In.ReadToEnd().Trim();'
    + '$bytes = [Convert]::FromBase64String($in);'
    + '$out = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, '
    + '[System.Security.Cryptography.DataProtectionScope]::CurrentUser);'
    + '[Console]::Out.Write([Convert]::ToBase64String($out));';
  const stdout = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: blob.toString('base64'),
    encoding: 'utf8',
    windowsHide: true,
  });
  return Buffer.from(String(stdout).trim(), 'base64');
}

function profileKey(profileDir) {
  const localState = readJson(path.join(profileDir, 'Local State'));
  const encoded = localState && localState.os_crypt && localState.os_crypt.encrypted_key;
  if (!encoded) throw new Error(`No os_crypt key in ${path.join(profileDir, 'Local State')}; open the app once with this profile first.`);
  const wrapped = Buffer.from(String(encoded), 'base64');
  if (!wrapped.subarray(0, KEY_PREFIX.length).equals(KEY_PREFIX)) throw new Error(`Unexpected key format in ${profileDir}.`);
  const key = dpapiUnprotect(wrapped.subarray(KEY_PREFIX.length));
  if (key.length !== 32) throw new Error(`Unwrapped key for ${profileDir} is ${key.length} bytes, expected 32.`);
  return key;
}

function decryptSecret(base64Value, key) {
  const blob = Buffer.from(String(base64Value), 'base64');
  if (!blob.subarray(0, ENVELOPE_PREFIX.length).equals(ENVELOPE_PREFIX)) {
    throw new Error('Secret is not a v10 OSCrypt envelope; it was written by a different Electron build.');
  }
  const nonce = blob.subarray(ENVELOPE_PREFIX.length, ENVELOPE_PREFIX.length + NONCE_BYTES);
  const body = blob.subarray(ENVELOPE_PREFIX.length + NONCE_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]);
}

function encryptSecret(plaintext, key) {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ENVELOPE_PREFIX, nonce, body, cipher.getAuthTag()]).toString('base64');
}

function parseArgs(argv) {
  const args = { apply: false, from: null, to: null };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--apply') args.apply = true;
    else if (argv[index] === '--from') args.from = argv[++index];
    else if (argv[index] === '--to') args.to = argv[++index];
  }
  return args;
}

function hasCredentials(dir) {
  return CREDENTIAL_FILES.some((name) => {
    const record = readJson(path.join(dir, name));
    return !!(record && record.secret);
  });
}

function migrate({ from, to, apply, log = console.log }) {
  const report = { from, to, moved: [], skipped: [], settings: [] };
  const sourceKey = profileKey(from);
  const targetKey = profileKey(to);

  for (const name of CREDENTIAL_FILES) {
    const source = readJson(path.join(from, name));
    if (!source || !source.secret) { report.skipped.push({ name, reason: 'nothing stored in the legacy profile' }); continue; }
    const existing = readJson(path.join(to, name));
    if (existing && existing.secret) { report.skipped.push({ name, reason: 'already present in the destination profile' }); continue; }
    const plaintext = decryptSecret(source.secret, sourceKey);
    const record = { ...source, secret: encryptSecret(plaintext, targetKey), updatedAt: Date.now() };
    plaintext.fill(0);
    if (apply) fs.writeFileSync(path.join(to, name), JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    // The identifier halves (App ID, Client ID) are not secret and are worth reporting back.
    const identifier = source.clientId || source.appId || '';
    report.moved.push({ name, identifier });
  }

  const sourceSettings = readJson(path.join(from, 'settings.json')) || {};
  const targetSettings = readJson(path.join(to, 'settings.json')) || {};
  const patch = {};
  for (const [key, value] of Object.entries(sourceSettings)) {
    if (!SETTINGS_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (key in targetSettings) continue;
    patch[key] = value;
  }
  if (Object.keys(patch).length) {
    report.settings = Object.keys(patch);
    if (apply) fs.writeFileSync(path.join(to, 'settings.json'), JSON.stringify({ ...targetSettings, ...patch }, null, 2), 'utf8');
  }

  sourceKey.fill(0);
  targetKey.fill(0);

  log(`${apply ? 'Migrated' : 'Would migrate'}`);
  log(`  from ${from}`);
  log(`  into ${to}`);
  for (const entry of report.moved) log(`  credentials: ${entry.name}${entry.identifier ? ` (${entry.identifier})` : ''}`);
  for (const entry of report.skipped) log(`  skipped:     ${entry.name} — ${entry.reason}`);
  if (report.settings.length) log(`  settings:    ${report.settings.join(', ')}`);
  if (!report.moved.length && !report.settings.length) log('  nothing to do');
  else if (!apply) log('\nRe-run with --apply to write these. Close the app first.');
  return report;
}

module.exports = { migrate, decryptSecret, encryptSecret, profileKey, parseArgs, CREDENTIAL_FILES };

if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert');
  const key = crypto.randomBytes(32);
  const other = crypto.randomBytes(32);
  const envelope = encryptSecret(Buffer.from('cert-id-value'), key);
  assert.strictEqual(decryptSecret(envelope, key).toString(), 'cert-id-value');
  assert.throws(() => decryptSecret(envelope, other), /unable to authenticate|bad decrypt/i, 'a blob is bound to the profile key that wrote it');
  assert.throws(() => decryptSecret(Buffer.from('plain').toString('base64'), key), /v10 OSCrypt envelope/);
  assert.deepStrictEqual(parseArgs(['--from', 'a', '--to', 'b', '--apply']), { apply: true, from: 'a', to: 'b' });
  console.log('migrate-legacy-credentials selftest: OK');
} else if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const root = appDataDir();
  const to = args.to || path.join(root, DEFAULT_TARGET);
  const from = args.from
    || LEGACY_PROFILES.map((name) => path.join(root, name)).find((dir) => fs.existsSync(dir) && hasCredentials(dir));
  try {
    if (!from) throw new Error('No legacy profile with stored credentials was found. Pass --from "<folder>" explicitly.');
    if (!fs.existsSync(to)) throw new Error(`Destination profile ${to} does not exist. Start the app once, then re-run.`);
    if (path.resolve(from) === path.resolve(to)) throw new Error('Source and destination are the same profile.');
    migrate({ from, to, apply: args.apply });
  } catch (error) {
    console.error(`Migration failed: ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  }
}
