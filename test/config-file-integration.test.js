const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, test } = require('node:test');
const { createCookieClient, request, withTestServer } = require('../test-support/http');
const { readConfigFile } = require('../server/utils/configFile');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bardboard-config-file-'));
const envPath = path.join(tempDir, '.env');
const configPath = path.join(tempDir, 'bardboard.config.yaml');
const sessionDir = path.join(tempDir, 'sessions').replace(/\\/g, '/');

fs.writeFileSync(envPath, 'DISCORD_TOKEN=\nAUTH_ADMIN_USER=\nAUTH_ADMIN_PASS=\n', 'utf8');
fs.writeFileSync(configPath, [
  'DISCORD_TOKEN: integration-token',
  'AUTH_ADMIN_USER: admin',
  'AUTH_ADMIN_PASS: admin-secret',
  'SESSION_SECRET: integration-session-secret',
  `SESSION_DIR: ${sessionDir}`,
  'NOISES_VOLUME: 3',
  'RATE_LIMIT_AUDIO: 1000',
  'RATE_LIMIT_AUDIO_STATUS: 1000',
  'RATE_LIMIT_FILES: 1000',
  'RATE_LIMIT_PLAYLIST: 1000'
].join('\n') + '\n', 'utf8');

process.env.BARDBOARD_ENV_PATH = envPath;
process.env.BARDBOARD_CONFIG_PATH = configPath;
process.env.NODE_ENV = 'test';

const { app, discordClient } = require('../server/app');

after(() => {
  discordClient.guilds.cache.clear();
  discordClient.destroy();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('configuration file integration', { concurrency: false }, () => {
  test('loads setup state and settings from the active YAML file', async () => {
    await withTestServer(app, async baseUrl => {
      assert.deepEqual(await request(baseUrl, '/setup/status'), {
        status: 200,
        body: { setupRequired: false }
      });

      const client = createCookieClient(baseUrl);
      const login = await client('/auth/login', {
        method: 'POST',
        body: { username: 'admin', password: 'admin-secret' }
      });
      assert.equal(login.status, 200);

      const settings = await client('/settings/config');
      const items = Object.fromEntries(settings.body.items.map(item => [item.key, item.value]));
      assert.equal(items.NOISES_VOLUME, '3');
      assert.equal(items.AUTH_ADMIN_USER, 'admin');
    });
  });

  test('settings updates are written back to the active YAML file', async () => {
    await withTestServer(app, async baseUrl => {
      const client = createCookieClient(baseUrl);
      await client('/auth/login', {
        method: 'POST',
        body: { username: 'admin', password: 'admin-secret' }
      });

      const updated = await client('/settings/config', {
        method: 'POST',
        body: { values: { NOISES_VOLUME: '4' } }
      });
      assert.equal(updated.status, 200);
      assert.deepEqual(updated.body.changedKeys, ['NOISES_VOLUME']);
      assert.equal(updated.body.botRestartRequired, true);

      const saved = readConfigFile(configPath);
      assert.equal(saved.NOISES_VOLUME, '4');
      assert.equal(saved.AUTH_ADMIN_USER, 'admin');
      assert.equal(saved.DISCORD_TOKEN, 'integration-token');
    });
  });
});
