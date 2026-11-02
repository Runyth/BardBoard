const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, test } = require('node:test');
const {
  CONFIG_FIELDS,
  ensureEnvFile,
  isConfiguredForFirstBoot,
  loadConfigFileIntoEnv,
  readCurrentConfig,
  resetConfigFileState,
  validateConfigValues,
  validateInput,
  writeConfig
} = require('../server/utils/envConfig');
const { getConfigFilePath, readConfigFile, serializeConfig } = require('../server/utils/configFile');
const { hasAllowedExt, resolveAudioPathFrom, sanitizeCategory } = require('../server/utils/path');
const { isValidChannelId, normalizeAudioFileName } = require('../server/utils/validation');

const originalEnvPath = process.env.BARDBOARD_ENV_PATH;
const originalConfigPath = process.env.BARDBOARD_CONFIG_PATH;
const trackedEnvKeys = ['NOISES_VOLUME', 'RATE_LIMIT_AUDIO', 'CORS_ORIGINS', 'AUTH_ADMIN_USER'];
const originalTrackedEnv = Object.fromEntries(trackedEnvKeys.map(key => [key, process.env[key]]));
const temporaryDirs = [];

afterEach(() => {
  if (originalEnvPath === undefined) delete process.env.BARDBOARD_ENV_PATH;
  else process.env.BARDBOARD_ENV_PATH = originalEnvPath;
  if (originalConfigPath === undefined) delete process.env.BARDBOARD_CONFIG_PATH;
  else process.env.BARDBOARD_CONFIG_PATH = originalConfigPath;
  for (const key of trackedEnvKeys) {
    if (originalTrackedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalTrackedEnv[key];
  }
  resetConfigFileState();
  while (temporaryDirs.length) {
    fs.rmSync(temporaryDirs.pop(), { recursive: true, force: true });
  }
});

function setupTemporaryEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bardboard-env-'));
  temporaryDirs.push(dir);
  const envPath = path.join(dir, '.env');
  process.env.BARDBOARD_ENV_PATH = envPath;
  return envPath;
}

function setupTemporaryConfig(format, values) {
  const envPath = setupTemporaryEnv();
  const configPath = path.join(path.dirname(envPath), `bardboard.config.${format}`);
  fs.writeFileSync(configPath, serializeConfig(values, format), 'utf8');
  process.env.BARDBOARD_CONFIG_PATH = configPath;
  return configPath;
}

function currentItems(values = {}) {
  return CONFIG_FIELDS.map(field => ({
    ...field,
    value: values[field.key] || '',
    configured: Boolean(values[field.key])
  }));
}

function createFsError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

describe('path and request validation', () => {
  test('resolveAudioPathFrom confines paths to the configured audio directory', () => {
    const base = path.resolve(os.tmpdir(), 'bardboard-audio-root');
    assert.equal(resolveAudioPathFrom(base, 'Combat/roar.mp3'), path.join(base, 'Combat', 'roar.mp3'));
    assert.equal(resolveAudioPathFrom(base, '../secret.mp3'), null);
    assert.equal(resolveAudioPathFrom(base, path.resolve(base, '..', 'secret.mp3')), null);
  });

  test('category, extension and channel validators accept only supported values', () => {
    assert.equal(sanitizeCategory(' Combat! '), 'Combat!');
    assert.equal(sanitizeCategory('../Combat'), 'Combat');
    assert.equal(hasAllowedExt('track.MP3'), true);
    assert.equal(hasAllowedExt('track.flac'), false);
    assert.equal(isValidChannelId('12345678901234567'), true);
    assert.equal(isValidChannelId('1234'), false);
    assert.equal(normalizeAudioFileName('Combat\\roar.ogg'), 'Combat/roar.ogg');
    assert.equal(normalizeAudioFileName('../roar.ogg'), null);
  });
});

describe('environment configuration', () => {
  test('first-boot validation requires token and admin credentials', () => {
    assert.equal(isConfiguredForFirstBoot({}), false);
    assert.equal(isConfiguredForFirstBoot({
      DISCORD_TOKEN: 'PasteYourDiscordBotTokenHere',
      AUTH_ADMIN_USER: 'admin',
      AUTH_ADMIN_PASS: 'secret'
    }), false);
    assert.equal(isConfiguredForFirstBoot({
      DISCORD_TOKEN: 'token',
      AUTH_ADMIN_USER: 'admin',
      AUTH_ADMIN_PASS: 'secret'
    }), true);
  });

  test('validateInput filters unknown keys and validates numeric fields', () => {
    const items = currentItems({ AUTH_ADMIN_PASS: 'existing' });
    assert.deepEqual(validateInput({ UNKNOWN: 'ignored', RATE_LIMIT_AUDIO: '25' }, items), {
      values: { RATE_LIMIT_AUDIO: '25' }
    });
    assert.match(validateInput({ RATE_LIMIT_AUDIO: '-1' }, items).error, /Invalid integer/);
    assert.match(validateInput({ RATE_LIMIT_AUDIO: '1.5' }, items).error, /Invalid integer/);
    assert.match(validateInput({ NOISES_VOLUME: '10.1' }, items).error, /Invalid number/);
    assert.deepEqual(validateInput({ AUTH_ADMIN_PASS: '' }, items), { values: {} });
    assert.match(validateInput({ AUTH_ADMIN_USER: 'x'.repeat(2049) }, items).error, /Value too long/);
  });

  test('ensureEnvFile creates defaults and writeConfig round-trips quoted secrets', () => {
    const envPath = setupTemporaryEnv();
    ensureEnvFile();
    assert.equal(fs.existsSync(envPath), true);

    const secret = "two words \\ and 'quotes'";
    const changed = writeConfig({
      DISCORD_TOKEN: 'token',
      AUTH_ADMIN_USER: 'admin',
      AUTH_ADMIN_PASS: secret
    });
    assert.deepEqual(changed.sort(), ['AUTH_ADMIN_PASS', 'AUTH_ADMIN_USER', 'DISCORD_TOKEN']);

    const values = Object.fromEntries(readCurrentConfig().map(item => [item.key, item.value]));
    assert.equal(values.DISCORD_TOKEN, 'token');
    assert.equal(values.AUTH_ADMIN_USER, 'admin');
    assert.equal(values.AUTH_ADMIN_PASS, secret);
    assert.equal(isConfiguredForFirstBoot(values), true);
  });

  test('writeConfig preserves unrelated lines and reports only changed keys', () => {
    const envPath = setupTemporaryEnv();
    fs.writeFileSync(envPath, '# custom\nDISCORD_TOKEN=old\nEXTRA=value\n', 'utf8');
    assert.deepEqual(writeConfig({ DISCORD_TOKEN: 'new' }), ['DISCORD_TOKEN']);
    assert.match(fs.readFileSync(envPath, 'utf8'), /^# custom\nDISCORD_TOKEN=new\nEXTRA=value\n$/);
    assert.deepEqual(writeConfig({ DISCORD_TOKEN: 'new' }), []);
  });

  test('writeConfig keeps the previous config when the atomic replace fails', () => {
    const envPath = setupTemporaryEnv();
    const original = '# keep this file intact\nDISCORD_TOKEN=old\n';
    fs.writeFileSync(envPath, original, 'utf8');
    const failingFs = Object.assign(Object.create(fs), {
      renameSync: () => {
        throw createFsError('EIO', 'simulated replace failure');
      }
    });

    assert.throws(
      () => writeConfig({ DISCORD_TOKEN: 'new' }, { fs: failingFs }),
      error => error.code === 'EIO'
    );
    assert.equal(fs.readFileSync(envPath, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(path.dirname(envPath)), ['.env']);
  });

  for (const format of ['yaml', 'json', 'toml']) {
    test(`loads ${format} configuration files with normalized values`, () => {
      const configPath = setupTemporaryConfig(format, {
        NOISES_VOLUME: 3,
        RATE_LIMIT_AUDIO: 42,
        CORS_ORIGINS: ['https://one.example', 'https://two.example'],
        AUTH_ADMIN_USER: 'admin'
      });

      assert.equal(loadConfigFileIntoEnv(), configPath);
      assert.equal(process.env.NOISES_VOLUME, '3');
      assert.equal(process.env.RATE_LIMIT_AUDIO, '42');
      assert.equal(process.env.CORS_ORIGINS, 'https://one.example,https://two.example');

      const items = Object.fromEntries(readCurrentConfig().map(item => [item.key, item.value]));
      assert.equal(items.NOISES_VOLUME, '3');
      assert.equal(items.RATE_LIMIT_AUDIO, '42');
      assert.equal(items.CORS_ORIGINS, 'https://one.example,https://two.example');
    });
  }

  test('configuration files override .env values', () => {
    process.env.NOISES_VOLUME = '3';
    setupTemporaryConfig('yaml', { NOISES_VOLUME: 5 });
    loadConfigFileIntoEnv();
    assert.equal(process.env.NOISES_VOLUME, '5');
  });

  test('writeConfig updates the active configuration file', () => {
    const configPath = setupTemporaryConfig('json', { NOISES_VOLUME: 2 });
    loadConfigFileIntoEnv();

    const changed = writeConfig({ NOISES_VOLUME: '4', AUTH_ADMIN_USER: 'admin' });
    assert.deepEqual(changed.sort(), ['AUTH_ADMIN_USER', 'NOISES_VOLUME']);
    assert.deepEqual(readConfigFile(configPath), {
      NOISES_VOLUME: '4',
      AUTH_ADMIN_USER: 'admin'
    });
    assert.deepEqual(writeConfig({ NOISES_VOLUME: '4' }), []);

    const items = Object.fromEntries(readCurrentConfig().map(item => [item.key, item.value]));
    assert.equal(items.NOISES_VOLUME, '4');
    assert.equal(items.AUTH_ADMIN_USER, 'admin');
  });

  for (const format of ['yaml', 'json', 'toml']) {
    test(`writeConfig writes ${format} configuration files`, () => {
      const configPath = setupTemporaryConfig(format, { NOISES_VOLUME: 2 });
      loadConfigFileIntoEnv();
      assert.deepEqual(writeConfig({ NOISES_VOLUME: '4' }), ['NOISES_VOLUME']);
      assert.equal(readConfigFile(configPath).NOISES_VOLUME, '4');
    });
  }

  test('writeConfig creates an explicitly configured file when missing', () => {
    const envPath = setupTemporaryEnv();
    const configPath = path.join(path.dirname(envPath), 'bardboard.config.toml');
    process.env.BARDBOARD_CONFIG_PATH = configPath;

    assert.equal(loadConfigFileIntoEnv(), configPath);
    assert.equal(fs.existsSync(configPath), false);
    assert.deepEqual(writeConfig({ RATE_LIMIT_AUDIO: '25' }), ['RATE_LIMIT_AUDIO']);
    assert.equal(readConfigFile(configPath).RATE_LIMIT_AUDIO, '25');
  });

  test('configuration validation rejects unknown keys and invalid values', () => {
    assert.match(validateConfigValues({ UNKNOWN: 'x' }).error, /Unknown configuration key/);
    assert.match(validateConfigValues({ RATE_LIMIT_AUDIO: '1.5' }).error, /Invalid integer/);
    assert.match(validateConfigValues({ NOISES_VOLUME: '11' }).error, /Invalid number/);

    setupTemporaryConfig('yaml', { UNKNOWN: 'x' });
    assert.throws(() => loadConfigFileIntoEnv(), /Unknown configuration key/);
  });

  test('malformed configuration files report a readable error', () => {
    const envPath = setupTemporaryEnv();
    const configPath = path.join(path.dirname(envPath), 'bardboard.config.json');
    fs.writeFileSync(configPath, '{ not valid json', 'utf8');
    process.env.BARDBOARD_CONFIG_PATH = configPath;
    assert.throws(() => loadConfigFileIntoEnv(), /Could not read configuration file/);
  });

  test('default configuration files are auto-detected in the working directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bardboard-config-detect-'));
    temporaryDirs.push(dir);
    const configPath = path.join(dir, 'bardboard.config.toml');
    fs.writeFileSync(configPath, 'NOISES_VOLUME = "2"\n', 'utf8');
    delete process.env.BARDBOARD_CONFIG_PATH;
    assert.equal(getConfigFilePath({ cwd: dir }), configPath);

    const nestedDir = path.join(dir, 'config');
    fs.mkdirSync(nestedDir);
    const nestedPath = path.join(nestedDir, 'bardboard.config.yaml');
    fs.writeFileSync(nestedPath, 'NOISES_VOLUME: 2\n', 'utf8');
    fs.rmSync(configPath);
    assert.equal(getConfigFilePath({ cwd: dir }), nestedPath);
  });

  test('an explicit configuration path with an unsupported extension is rejected', () => {
    const envPath = setupTemporaryEnv();
    process.env.BARDBOARD_CONFIG_PATH = path.join(path.dirname(envPath), 'bardboard.config.ini');
    assert.throws(() => loadConfigFileIntoEnv(), /Unsupported configuration format/);
  });
});
