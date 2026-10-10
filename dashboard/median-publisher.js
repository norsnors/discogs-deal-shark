'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { parseGitHubOwner, sameAccount, filterRealMedians, mergeSoldMedians } = require('./git-policy');

function run(file, args, { cwd, timeout = 45_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd,
      timeout,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout, stderr) => {
      if (error) { error.stderr = stderr; return reject(error); }
      resolve((stdout || '').trim());
    });
  });
}

async function defaultGitHubAccount() {
  try { return (await run('gh', ['api', 'user', '--jq', '.login'], { timeout: 15_000 })).trim() || null; }
  catch { return null; }
}

function safeRemove(dir) {
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  const target = path.resolve(dir);
  if (!target.startsWith(tempRoot)) throw new Error(`Refusing cleanup outside the temporary directory: ${target}`);
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function makeMedianPublisher({ repoDir, accountProvider = defaultGitHubAccount } = {}) {
  if (!repoDir) throw new Error('repoDir is required');
  const repoGit = (args, timeout) => run('git', args, { cwd: repoDir, timeout });

  async function verifyAccount() {
    const remoteUrl = await repoGit(['remote', 'get-url', '--push', 'origin']);
    const owner = parseGitHubOwner(remoteUrl);
    let configured = null;
    try { configured = await repoGit(['config', '--get', 'credential.https://github.com.username']); } catch { /* optional */ }
    const active = await accountProvider();
    if (owner && configured && !sameAccount(owner, configured)) {
      throw new Error(`Git remote belongs to ${owner}, but this repository is configured for ${configured}.`);
    }
    if (owner && active && !sameAccount(owner, active)) {
      throw new Error(`Git remote belongs to ${owner}, but GitHub CLI is logged in as ${active}. Run: gh auth switch --user ${owner}`);
    }
    return { owner, active: active || configured || null };
  }

  async function publish(input) {
    const local = filterRealMedians(input);
    if (!Object.keys(local).length) return { ok: true, pushed: false, reason: 'no real medians' };
    const identity = await verifyAccount();
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      let worktree = null;
      try {
        await repoGit(['fetch', 'origin', 'main'], 90_000);
        worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'ddw-medians-'));
        await repoGit(['worktree', 'add', '--detach', worktree, 'origin/main'], 90_000);

        const target = path.join(worktree, 'soldmedians.json');
        const remote = readJson(target, {});
        const merged = mergeSoldMedians(remote, local);
        fs.writeFileSync(target, JSON.stringify(merged));
        await run('git', ['add', 'soldmedians.json'], { cwd: worktree });

        let changed = true;
        try { await run('git', ['diff', '--cached', '--quiet', '--', 'soldmedians.json'], { cwd: worktree }); changed = false; }
        catch { /* non-zero means the isolated worktree has a median change */ }
        if (!changed) return { ok: true, pushed: false, reason: 'unchanged', entries: Object.keys(merged).length, account: identity.active };

        await run('git', ['-c', 'user.name=deal-watcher', '-c', 'user.email=deal-watcher@users.noreply.github.com',
          'commit', '-m', 'Auto: refresh sold-medians from dashboard scan'], { cwd: worktree });
        await run('git', ['push', 'origin', 'HEAD:main'], { cwd: worktree, timeout: 60_000 });
        return { ok: true, pushed: true, entries: Object.keys(merged).length, account: identity.active };
      } catch (error) {
        lastError = error;
        const message = String((error && (error.stderr || error.message)) || error);
        if (attempt === 3 || !/non-fast-forward|fetch first|rejected/i.test(message)) throw error;
      } finally {
        if (worktree) {
          try { await repoGit(['worktree', 'remove', '--force', worktree], 30_000); }
          catch { safeRemove(worktree); try { await repoGit(['worktree', 'prune']); } catch { /* best effort */ } }
        }
      }
    }
    throw lastError || new Error('Could not publish sold medians');
  }

  return { publish, verifyAccount };
}

module.exports = { makeMedianPublisher, defaultGitHubAccount, run };

if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddw-publisher-test-'));
  const remote = path.join(tmp, 'remote.git');
  const seed = path.join(tmp, 'seed');
  const repo = path.join(tmp, 'repo');
  (async () => {
    try {
      await run('git', ['init', '--bare', remote]);
      await run('git', ['init', '-b', 'main', seed]);
      fs.writeFileSync(path.join(seed, 'soldmedians.json'), JSON.stringify({ 1: { median: 10, ts: 10 } }));
      fs.writeFileSync(path.join(seed, 'unrelated.txt'), 'base');
      await run('git', ['add', '.'], { cwd: seed });
      await run('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'seed'], { cwd: seed });
      await run('git', ['remote', 'add', 'origin', remote], { cwd: seed });
      await run('git', ['push', '-u', 'origin', 'main'], { cwd: seed });
      await run('git', ['clone', '--branch', 'main', remote, repo]);

      fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'user work');
      await run('git', ['add', 'unrelated.txt'], { cwd: repo });
      const headBefore = await run('git', ['rev-parse', 'HEAD'], { cwd: repo });
      const statusBefore = await run('git', ['status', '--porcelain=v1'], { cwd: repo });
      const publisher = makeMedianPublisher({ repoDir: repo, accountProvider: async () => null });
      const result = await publisher.publish({ 1: { median: 11, ts: 20 }, 2: { median: 22, ts: 30 } });
      assert.ok(result.pushed);
      assert.strictEqual(await run('git', ['rev-parse', 'HEAD'], { cwd: repo }), headBefore, 'publisher never moves the working branch');
      assert.strictEqual(await run('git', ['status', '--porcelain=v1'], { cwd: repo }), statusBefore, 'publisher preserves staged user work exactly');

      const verify = path.join(tmp, 'verify');
      await run('git', ['clone', '--branch', 'main', remote, verify]);
      const published = readJson(path.join(verify, 'soldmedians.json'));
      assert.strictEqual(published[1].median, 11);
      assert.strictEqual(published[2].median, 22);
      console.log('median-publisher selftest: all assertions passed');
    } finally {
      safeRemove(tmp);
    }
  })().catch((error) => { console.error('FAILED:', error.stack || error); process.exit(1); });
}
