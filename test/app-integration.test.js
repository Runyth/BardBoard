const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, test } = require('node:test');
const { createCookieClient, request, withTestServer } = require('../test-support/http');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bardboard-app-'));
const envPath = path.join(tempDir, '.env');
const sessionDir = path.join(tempDir, 'sessions').replace(/\\/g, '/');

function writeTestConfig(discordToken = 'fake-discord-token') {
  fs.writeFileSync(envPath, [
    `DISCORD_TOKEN=${discordToken}`,
    'AUTH_ADMIN_USER=admin',
    'AUTH_ADMIN_PASS=admin-secret',
    'AUTH_READONLY_USER=viewer',
    'AUTH_READONLY_PASS=viewer-secret',
    'SESSION_SECRET=test-session-secret',
    `SESSION_DIR=${sessionDir}`,
    'CORS_ORIGINS=https://allowed.example',
    'TRUST_PROXY=1',
    'RATE_LIMIT_AUDIO=1000',
    'RATE_LIMIT_AUDIO_STATUS=1000',
    'RATE_LIMIT_FILES=1000',
    'RATE_LIMIT_PLAYLIST=1000'
  ].join('\n') + '\n', 'utf8');
}

writeTestConfig();
process.env.BARDBOARD_ENV_PATH = envPath;
process.env.BARDBOARD_CONFIG_PATH = '';
process.env.BARDBOARD_USERS_PATH = path.join(tempDir, 'users.json');
delete process.env.TRUST_PROXY;
process.env.NODE_ENV = 'test';

const { app, discordClient } = require('../server/app');

after(() => {
  discordClient.guilds.cache.clear();
  discordClient.destroy();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('complete Express application', { concurrency: false }, () => {
  test('health is public while bot APIs require authentication', async () => {
    await withTestServer(app, async baseUrl => {
      assert.deepEqual(await request(baseUrl, '/health'), { status: 200, body: { ok: true } });
      assert.deepEqual(await request(baseUrl, '/voice-channels'), {
        status: 401,
        body: { error: 'Unauthorized' }
      });
      assert.equal((await request(baseUrl, '/api-docs.json')).status, 401);
    });
  });

  test('CORS allows configured origins and rejects all others', async () => {
    await withTestServer(app, async baseUrl => {
      const allowed = await fetch(`${baseUrl}/health`, {
        headers: { origin: 'https://allowed.example' }
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://allowed.example');

      const denied = await request(baseUrl, '/health', {
        headers: { origin: 'https://denied.example' }
      });
      assert.deepEqual(denied, { status: 403, body: { error: 'Origin not allowed' } });
    });
  });

  test('invalid credentials are rejected', async () => {
    await withTestServer(app, async baseUrl => {
      const response = await request(baseUrl, '/auth/login', {
        method: 'POST',
        body: { username: 'admin', password: 'wrong' }
      });
      assert.deepEqual(response, {
        status: 401,
        body: { error: 'Invalid username or password' }
      });
    });
  });

  test('trust proxy keys login limits by forwarded client address', async () => {
    assert.equal(app.get('trust proxy'), 1);

    await withTestServer(app, async baseUrl => {
      const login = forwardedFor => fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': forwardedFor
        },
        body: JSON.stringify({ username: 'admin', password: 'wrong' })
      });

      const limitedClient = '203.0.113.10';
      const otherClient = '203.0.113.11';
      for (let attempt = 0; attempt < 20; attempt += 1) {
        assert.equal((await login(limitedClient)).status, 401);
      }

      const blocked = await login(limitedClient);
      assert.equal(blocked.status, 429);
      assert.match(blocked.headers.get('ratelimit-policy') || '', /20/);

      assert.equal((await login(otherClient)).status, 401);
    });
  });

  test('concurrent logins persist independent authenticated sessions', async () => {
    await withTestServer(app, async baseUrl => {
      const logins = await Promise.all(Array.from({ length: 8 }, () => fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin-secret', remember: true })
      })));
      assert.equal(logins.every(response => response.status === 200), true);

      const cookies = logins.map(response => response.headers.get('set-cookie')?.split(';', 1)[0]);
      assert.equal(cookies.every(Boolean), true);
      assert.equal(new Set(cookies).size, cookies.length);

      const statuses = await Promise.all(cookies.map(cookie => fetch(`${baseUrl}/auth/status`, {
        headers: { cookie }
      }).then(response => response.json())));
      assert.equal(statuses.every(status => status.authenticated && status.role === 'admin'), true);
    });
  });

  test('readonly users can use the bot but cannot manage settings', async () => {
    await withTestServer(app, async baseUrl => {
      const client = createCookieClient(baseUrl);
      const login = await client('/auth/login', {
        method: 'POST',
        body: { username: 'viewer', password: 'viewer-secret' }
      });
      assert.equal(login.status, 200);
      assert.deepEqual(login.body, { ok: true, role: 'user' });

      const status = await client('/auth/status');
      assert.equal(status.body.authenticated, true);
      assert.equal(status.body.role, 'user');
      assert.equal(status.body.canManageSettings, false);
      assert.equal((await client('/voice-channels')).status, 200);
      assert.deepEqual((await client('/settings/config')).body, { error: 'Forbidden' });
      assert.deepEqual((await client('/settings/config/')).body, { error: 'Forbidden' });
      assert.deepEqual((await client('/Users')).body, { error: 'Forbidden' });
      assert.deepEqual((await client('/SETTINGS/restart', { method: 'POST' })).body, { error: 'Forbidden' });
    });
  });

  test('admins can read settings and API docs, then log out', async () => {
    await withTestServer(app, async baseUrl => {
      const client = createCookieClient(baseUrl);
      const login = await client('/auth/login', {
        method: 'POST',
        body: { username: 'admin', password: 'admin-secret', remember: true }
      });
      assert.deepEqual(login.body, { ok: true, role: 'admin' });
      assert.match(login.headers.get('set-cookie'), /Expires=/i);

      const settings = await client('/settings/config');
      assert.equal(settings.status, 200);
      assert.equal(Array.isArray(settings.body.items), true);
      const tokenItem = settings.body.items.find(item => item.key === 'DISCORD_TOKEN');
      assert.equal(tokenItem.value, '');
      assert.equal(tokenItem.configured, true);
      assert.equal((await client('/api-docs.json')).status, 200);

      assert.deepEqual((await client('/auth/logout', { method: 'POST' })).body, { ok: true });
      assert.equal((await client('/settings/config')).status, 401);
    });
  });

  test('admins can validate and update runtime configuration', async () => {
    await withTestServer(app, async baseUrl => {
      const client = createCookieClient(baseUrl);
      await client('/auth/login', {
        method: 'POST',
        body: { username: 'admin', password: 'admin-secret' }
      });

      const invalid = await client('/settings/config', {
        method: 'POST',
        body: { values: { RATE_LIMIT_AUDIO: '-1' } }
      });
      assert.equal(invalid.status, 400);
      assert.match(invalid.body.error, /Invalid integer/);

      const updated = await client('/settings/config', {
        method: 'POST',
        body: { values: { NOISES_VOLUME: '3' } }
      });
      assert.deepEqual(updated.body, {
        ok: true,
        changedKeys: ['NOISES_VOLUME'],
        authChanged: false,
        botRestartRequired: true,
        webRestartRequired: false
      });

      const restart = await client('/settings/restart', {
        method: 'POST',
        body: {}
      });
      assert.deepEqual(restart.body, { ok: true, restarting: false });
    });
    writeTestConfig();
  });

  test('voice channels are filtered and sorted by guild, position and name', async () => {
    const guildA = {
      id: 'guild-a',
      name: 'Alpha',
      channels: {
        cache: new Map([
          ['text', { id: 'text', name: 'chat', isVoiceBased: () => false }],
          ['voice-2', { id: 'voice-2', name: 'Beta', rawPosition: 2, isVoiceBased: () => true }],
          ['voice-1', { id: 'voice-1', name: 'Alpha', rawPosition: 2, isVoiceBased: () => true }]
        ])
      }
    };
    const guildZ = {
      id: 'guild-z',
      name: 'Zulu',
      channels: {
        cache: new Map([
          ['voice-3', { id: 'voice-3', name: 'General', rawPosition: 0, isVoiceBased: () => true }]
        ])
      }
    };
    discordClient.guilds.cache.set(guildZ.id, guildZ);
    discordClient.guilds.cache.set(guildA.id, guildA);

    await withTestServer(app, async baseUrl => {
      const client = createCookieClient(baseUrl);
      await client('/auth/login', {
        method: 'POST',
        body: { username: 'viewer', password: 'viewer-secret' }
      });
      const response = await client('/voice-channels');
      assert.deepEqual(response.body.channels.map(channel => channel.channelId), [
        'voice-1',
        'voice-2',
        'voice-3'
      ]);
    });
  });

  test('the last active admin cannot be demoted, disabled, or deleted', async () => {
    await withTestServer(app, async baseUrl => {
      const admin = createCookieClient(baseUrl);
      await admin('/auth/login', {
        method: 'POST',
        body: { username: 'admin', password: 'admin-secret' }
      });

      const users = await admin('/users');
      const adminUser = users.body.users.find(user => user.role === 'admin');
      assert.ok(adminUser);

      assert.equal((await admin(`/users/${adminUser.id}`, {
        method: 'PATCH',
        body: { role: 'user' }
      })).status, 409);
      assert.equal((await admin(`/users/${adminUser.id}`, {
        method: 'PATCH',
        body: { disabled: true }
      })).status, 409);
      assert.equal((await admin(`/users/${adminUser.id}`, {
        method: 'DELETE'
      })).status, 409);
    });
  });

  test('admins manage users, roles, passwords, and session invalidation', async () => {
    await withTestServer(app, async baseUrl => {
      const admin = createCookieClient(baseUrl);
      await admin('/auth/login', {
        method: 'POST',
        body: { username: 'admin', password: 'admin-secret' }
      });

      const created = await admin('/users', {
        method: 'POST',
        body: { username: 'managed-user', password: 'managed-secret', role: 'user' }
      });
      assert.equal(created.status, 201);
      const userId = created.body.user.id;

      try {
        const member = createCookieClient(baseUrl);
        const login = await member('/auth/login', {
          method: 'POST',
          body: { username: 'managed-user', password: 'managed-secret' }
        });
        assert.deepEqual(login.body, { ok: true, role: 'user' });
        assert.equal((await member('/settings/config')).status, 403);
        assert.equal((await member('/users')).status, 403);
        assert.equal((await member('/play-audio', {
          method: 'POST',
          body: { fileName: 'missing.mp3', channelId: 'invalid' }
        })).status, 400);

        const promoted = await admin(`/users/${userId}`, {
          method: 'PATCH',
          body: { role: 'admin' }
        });
        assert.equal(promoted.status, 200);
        assert.equal(promoted.body.user.role, 'admin');
        assert.equal((await member('/voice-channels')).status, 401);

        const promotedLogin = await member('/auth/login', {
          method: 'POST',
          body: { username: 'managed-user', password: 'managed-secret' }
        });
        assert.deepEqual(promotedLogin.body, { ok: true, role: 'admin' });
        assert.equal((await member('/users')).status, 200);

        const passwordReset = await admin(`/users/${userId}/password`, {
          method: 'POST',
          body: { password: 'managed-secret-2' }
        });
        assert.equal(passwordReset.status, 200);
        assert.equal((await member('/voice-channels')).status, 401);

        const oldPassword = await member('/auth/login', {
          method: 'POST',
          body: { username: 'managed-user', password: 'managed-secret' }
        });
        assert.equal(oldPassword.status, 401);
        const newPassword = await member('/auth/login', {
          method: 'POST',
          body: { username: 'managed-user', password: 'managed-secret-2' }
        });
        assert.deepEqual(newPassword.body, { ok: true, role: 'admin' });
      } finally {
        assert.equal((await admin(`/users/${userId}`, { method: 'DELETE' })).status, 200);
      }
    });
  });

});
