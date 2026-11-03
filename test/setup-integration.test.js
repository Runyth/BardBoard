const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, test } = require('node:test');
const { createCookieClient, request, withTestServer } = require('../test-support/http');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bardboard-setup-'));
const envPath = path.join(tempDir, '.env');
const usersPath = path.join(tempDir, 'users.json');
const sessionDir = path.join(tempDir, 'sessions').replace(/\\/g, '/');

fs.writeFileSync(envPath, [
  'DISCORD_TOKEN=',
  'SESSION_SECRET=setup-test-session-secret',
  `SESSION_DIR=${sessionDir}`,
  'RATE_LIMIT_AUDIO=1000',
  'RATE_LIMIT_AUDIO_STATUS=1000',
  'RATE_LIMIT_FILES=1000',
  'RATE_LIMIT_PLAYLIST=1000'
].join('\n') + '\n', 'utf8');

process.env.BARDBOARD_ENV_PATH = envPath;
process.env.BARDBOARD_CONFIG_PATH = '';
process.env.BARDBOARD_USERS_PATH = usersPath;
process.env.NODE_ENV = 'test';

const { app, discordClient } = require('../server/app');

const originalLogin = discordClient.login;
const loginCalls = [];
discordClient.login = async token => {
  loginCalls.push(token);
  return discordClient;
};

after(() => {
  discordClient.login = originalLogin;
  discordClient.destroy();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('first-boot setup integration', { concurrency: false }, () => {
  test('setup mode blocks normal APIs and rejects invalid input', async () => {
    await withTestServer(app, async baseUrl => {
      assert.deepEqual(await request(baseUrl, '/setup/status'), {
        status: 200,
        body: { setupRequired: true }
      });
      assert.equal((await request(baseUrl, '/health')).status, 200);
      assert.deepEqual(await request(baseUrl, '/voice-channels'), {
        status: 503,
        body: { error: 'Initial setup required', setupRequired: true }
      });
      assert.equal((await request(baseUrl, '/auth/login', {
        method: 'POST',
        body: { username: 'admin', password: 'admin-secret' }
      })).status, 503);

      assert.equal((await request(baseUrl, '/setup/complete', {
        method: 'POST',
        body: {
          discordToken: 'PasteYourDiscordBotTokenHere',
          adminUser: 'admin',
          adminPass: 'admin-secret'
        }
      })).status, 400);

      assert.equal((await request(baseUrl, '/setup/complete', {
        method: 'POST',
        body: {
          discordToken: 'setup-token',
          adminUser: 'admin',
          adminPass: 'short'
        }
      })).status, 400);

      assert.equal((await request(baseUrl, '/setup/complete', {
        method: 'POST',
        body: {
          discordToken: 'setup-token',
          adminUser: 'admin',
          adminPass: 'admin-secret',
          readonlyEnabled: true,
          readonlyUser: 'viewer'
        }
      })).status, 400);

      assert.equal((await request(baseUrl, '/setup/complete', {
        method: 'POST',
        body: {
          discordToken: 'setup-token',
          adminUser: 'admin',
          adminPass: 'admin-secret',
          readonlyEnabled: true,
          readonlyUser: 'admin',
          readonlyPass: 'viewer-secret'
        }
      })).status, 400);
    });
  });

  test('setup creates hashed users, persists the token, and enables login', async () => {
    await withTestServer(app, async baseUrl => {
      const response = await request(baseUrl, '/setup/complete', {
        method: 'POST',
        body: {
          discordToken: 'setup-token',
          adminUser: 'setup-admin',
          adminPass: 'setup-admin-secret',
          readonlyEnabled: true,
          readonlyUser: 'setup-user',
          readonlyPass: 'setup-user-secret'
        }
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.changedKeys.includes('DISCORD_TOKEN'), true);
      assert.deepEqual(loginCalls, ['setup-token']);
      assert.deepEqual(await request(baseUrl, '/setup/status'), {
        status: 200,
        body: { setupRequired: false }
      });

      const savedEnv = fs.readFileSync(envPath, 'utf8');
      assert.match(savedEnv, /^DISCORD_TOKEN=setup-token$/m);
      const users = JSON.parse(fs.readFileSync(usersPath, 'utf8')).users;
      assert.equal(users.some(user => user.username === 'setup-admin' && user.role === 'admin'), true);
      assert.equal(users.some(user => user.username === 'setup-user' && user.role === 'user'), true);
      assert.equal(users.every(user => typeof user.passwordHash === 'string'), true);
      assert.equal(users.some(user => String(user.passwordHash).includes('setup-admin-secret')), false);

      const admin = createCookieClient(baseUrl);
      const login = await admin('/auth/login', {
        method: 'POST',
        body: { username: 'setup-admin', password: 'setup-admin-secret' }
      });
      assert.deepEqual(login.body, { ok: true, role: 'admin' });
      const status = await admin('/auth/status');
      assert.equal(status.body.canManageUsers, true);
      assert.equal(status.body.permissions.includes('users:manage'), true);

      assert.equal((await request(baseUrl, '/setup/complete', {
        method: 'POST',
        body: {
          discordToken: 'another-token',
          adminUser: 'setup-admin',
          adminPass: 'setup-admin-secret'
        }
      })).status, 409);

      fs.writeFileSync(envPath, savedEnv.replace('DISCORD_TOKEN=setup-token', 'DISCORD_TOKEN='), 'utf8');
      process.env.DISCORD_TOKEN = '';
      assert.deepEqual(await request(baseUrl, '/setup/status'), {
        status: 200,
        body: { setupRequired: false }
      });
      assert.equal((await request(baseUrl, '/setup/complete', {
        method: 'POST',
        body: {
          discordToken: 'attacker-token',
          adminUser: 'setup-admin',
          adminPass: 'attacker-secret'
        }
      })).status, 409);
    });
  });
});
