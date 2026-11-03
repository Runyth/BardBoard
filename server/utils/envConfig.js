/**
  BardBoard - A DiscordJS bot soundboard
  Copyright (C) 2024 Giovanbattista Abbate

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomically } = require('./atomicFile');
const {
  detectConfigFormat,
  getConfigFilePath,
  normalizeConfigValues,
  readConfigFile,
  writeConfigFile
} = require('./configFile');

const CONFIG_FIELDS = [
  { key: 'DISCORD_TOKEN', label: 'Discord Token', section: 'Required Discord Settings', description: 'Bot token from the Discord Developer Portal.', secret: true, restartScope: 'bot' },
  { key: 'AUTH_ADMIN_USER', settingsEditable: false, label: 'Admin Username', section: 'Auth and Session Settings', description: 'Username for admin login.', restartScope: 'bot' },
  { key: 'AUTH_ADMIN_PASS', settingsEditable: false, label: 'Admin Password', section: 'Auth and Session Settings', description: 'Password for admin login.', secret: true, restartScope: 'bot' },
  { key: 'AUTH_READONLY_USER', settingsEditable: false, label: 'User Username', section: 'Auth and Session Settings', description: 'Username for readonly user login.', restartScope: 'bot' },
  { key: 'AUTH_READONLY_PASS', settingsEditable: false, label: 'User Password', section: 'Auth and Session Settings', description: 'Password for readonly user login.', secret: true, restartScope: 'bot' },
  { key: 'SESSION_SECRET', label: 'Session Secret', section: 'Auth and Session Settings', description: 'Secret used to sign session cookies.', secret: true, restartScope: 'bot' },
  { key: 'LOGIN_REMEMBER_DAYS', label: 'Login Remember Days', section: 'Auth and Session Settings', description: 'Remember-me cookie duration in days.', type: 'integer', restartScope: 'bot' },
  { key: 'SESSION_DIR', label: 'Session Directory', section: 'Auth and Session Settings', description: 'Directory where session files are stored.', restartScope: 'bot' },
  { key: 'NOISES_FOLDER', label: 'Noises Folder', section: 'Audio File Behavior', description: 'Category folder name used for overlay noise tracks.', restartScope: 'bot' },
  { key: 'NOISES_VOLUME', label: 'Noises Volume', section: 'Audio File Behavior', description: 'Overlay noise gain from 0 to 10. Use 1 for the original level or 2 to double the noise amplitude.', type: 'number', min: 0, max: 10, restartScope: 'bot' },
  { key: 'WEB_PORT', label: 'Web Port', section: 'Network and Ports', description: 'Port exposed by the Next.js web UI.', type: 'integer', restartScope: 'web', settingsEditable: false },
  { key: 'BOT_PORT', label: 'Bot/API Port', section: 'Network and Ports', description: 'Port exposed by the bot/API process.', type: 'integer', restartScope: 'bot', settingsEditable: false },
  { key: 'BACKEND_URL', label: 'Backend URL', section: 'Network and Ports', description: 'URL used by Next.js to proxy API requests.', restartScope: 'web', settingsEditable: false },
  { key: 'UPLOAD_MAX_MB', label: 'Upload Max MB', section: 'Uploads and Rate Limit', description: 'Maximum upload size per file in MB.', type: 'integer', restartScope: 'both', settingsEditable: false },
  { key: 'RATE_LIMIT_AUDIO', label: 'Audio Rate Limit', section: 'Uploads and Rate Limit', description: 'Per-minute limit for playback control requests.', type: 'integer', restartScope: 'bot' },
  { key: 'RATE_LIMIT_FILES', label: 'Files Rate Limit', section: 'Uploads and Rate Limit', description: 'Per-minute limit for file-management requests.', type: 'integer', restartScope: 'bot' },
  { key: 'RATE_LIMIT_AUDIO_STATUS', label: 'Audio Status Rate Limit', section: 'Uploads and Rate Limit', description: 'Per-minute limit for status polling endpoints.', type: 'integer', restartScope: 'bot' },
  { key: 'RATE_LIMIT_LOGIN', label: 'Login Attempt Limit', section: 'Uploads and Rate Limit', description: 'Failed login attempts allowed per 15 minutes.', type: 'integer', restartScope: 'bot' },
  { key: 'RATE_LIMIT_SETUP', label: 'Setup Attempt Limit', section: 'Uploads and Rate Limit', description: 'Failed setup attempts allowed per 15 minutes.', type: 'integer', restartScope: 'bot' },
  { key: 'RATE_LIMIT_PLAYLIST', label: 'Playlist Rate Limit', section: 'Uploads and Rate Limit', description: 'Per-minute limit for playlist operations.', type: 'integer', restartScope: 'bot' },
  { key: 'CORS_ORIGINS', label: 'CORS Origins', section: 'CORS (Optional)', description: 'Comma-separated list of allowed origins.', restartScope: 'bot' },
  { key: 'SESSION_FILE_RETRIES', label: 'Session File Retries', section: 'Session File Retry Tuning', description: 'Retry count used by session-file-store.', type: 'integer', restartScope: 'bot' },
  { key: 'SESSION_FILE_RETRY_FACTOR', label: 'Session Retry Factor', section: 'Session File Retry Tuning', description: 'Backoff factor used by session-file-store.', type: 'integer', restartScope: 'bot' },
  { key: 'SESSION_FILE_RETRY_MIN_MS', label: 'Session Retry Min ms', section: 'Session File Retry Tuning', description: 'Minimum retry wait (ms) for session-file-store.', type: 'integer', restartScope: 'bot' },
  { key: 'SESSION_FILE_RETRY_MAX_MS', label: 'Session Retry Max ms', section: 'Session File Retry Tuning', description: 'Maximum retry wait (ms) for session-file-store.', type: 'integer', restartScope: 'bot' },
  { key: 'SESSION_WRITE_RETRIES', label: 'Session Write Retries', section: 'Session File Retry Tuning', description: 'Extra retries for EPERM/EBUSY during session writes.', type: 'integer', restartScope: 'bot' }
];

const CONFIG_FIELD_MAP = new Map(CONFIG_FIELDS.map(field => [field.key, field]));
const EDITABLE_CONFIG_KEYS = new Set(CONFIG_FIELDS
  .filter(field => field.settingsEditable !== false)
  .map(field => field.key));
const REQUIRED_FIRST_BOOT_KEYS = ['DISCORD_TOKEN', 'AUTH_ADMIN_USER', 'AUTH_ADMIN_PASS'];
const DEFAULT_CONFIG_VALUES = {
  AUTH_READONLY_USER: '',
  AUTH_READONLY_PASS: '',
  AUTH_ADMIN_USER: '',
  AUTH_ADMIN_PASS: '',
  LOGIN_REMEMBER_DAYS: '30',
  SESSION_DIR: './sessions',
  NOISES_FOLDER: '!noises',
  NOISES_VOLUME: '2',
  WEB_PORT: '3000',
  BOT_PORT: '3001',
  BACKEND_URL: 'http://localhost:3001',
  UPLOAD_MAX_MB: '50',
  RATE_LIMIT_AUDIO: '120',
  RATE_LIMIT_FILES: '60',
  RATE_LIMIT_AUDIO_STATUS: '600',
  RATE_LIMIT_LOGIN: '20',
  RATE_LIMIT_SETUP: '10',
  RATE_LIMIT_PLAYLIST: '120',
  CORS_ORIGINS: '',
  SESSION_FILE_RETRIES: '5',
  SESSION_FILE_RETRY_FACTOR: '1',
  SESSION_FILE_RETRY_MIN_MS: '50',
  SESSION_FILE_RETRY_MAX_MS: '200',
  SESSION_WRITE_RETRIES: '6'
};

let activeConfigPath = '';
let activeConfigValues = {};

function getEnvFilePath() {
  const explicitEnvPath = String(process.env.BARDBOARD_ENV_PATH || '').trim();
  if (explicitEnvPath) {
    return path.resolve(explicitEnvPath);
  }
  return path.join(process.cwd(), '.env');
}

function getActiveConfigPath() {
  return activeConfigPath;
}

function generateSessionSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function unquote(raw) {
  const value = (raw || '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
    const quote = value[0];
    const inner = value.slice(1, -1);
    let unescaped = '';
    for (let i = 0; i < inner.length; i += 1) {
      if (inner[i] === '\\' && (inner[i + 1] === '\\' || inner[i + 1] === quote)) {
        i += 1;
      }
      unescaped += inner[i];
    }
    return unescaped;
  }
  return value;
}

function quoteIfNeeded(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (/[\s#"'\\]/.test(text)) {
    const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, '\\\'');
    return `'${escaped}'`;
  }
  return text;
}

function parseEnvLines(rawText) {
  const lines = rawText.split(/\r?\n/);
  const values = {};
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1];
    values[key] = unquote(match[2]);
  }
  return { lines, values };
}

function defaultFromProcess(key, fallback) {
  if (Object.prototype.hasOwnProperty.call(process.env, key)) {
    return String(process.env[key] ?? '');
  }
  return fallback;
}

function getEffectiveDefaults() {
  const sessionSecret = String(process.env.SESSION_SECRET || '').trim() || generateSessionSecret();
  return {
    DISCORD_TOKEN: defaultFromProcess('DISCORD_TOKEN', ''),
    SESSION_SECRET: sessionSecret,
    ...Object.fromEntries(Object.entries(DEFAULT_CONFIG_VALUES).map(([key, value]) => [key, defaultFromProcess(key, value)]))
  };
}

function ensureEnvFile() {
  const envPath = getEnvFilePath();
  const defaults = getEffectiveDefaults();
  const before = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const parsed = parseEnvLines(before);

  const values = { ...parsed.values };
  let changed = false;

  for (const key of REQUIRED_FIRST_BOOT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      values[key] = defaults[key] || '';
      changed = true;
    }
  }

  if (!String(values.SESSION_SECRET || '').trim()) {
    values.SESSION_SECRET = defaults.SESSION_SECRET;
    changed = true;
  }

  for (const [key, value] of Object.entries(defaults)) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      values[key] = value;
      changed = true;
    }
  }

  if (!fs.existsSync(envPath) || changed) {
    const orderedKeys = [];
    const seen = new Set();
    CONFIG_FIELDS.forEach(field => {
      if (!seen.has(field.key)) {
        orderedKeys.push(field.key);
        seen.add(field.key);
      }
    });
    Object.keys(values).forEach(key => {
      if (!seen.has(key)) {
        orderedKeys.push(key);
        seen.add(key);
      }
    });

    const lines = orderedKeys.map(key => `${key}=${quoteIfNeeded(values[key] ?? '')}`);
    const normalized = `${lines.join('\n')}\n`;
    writeFileAtomically(envPath, normalized);
  }
}

function isConfiguredForFirstBoot(values) {
  const discordToken = String(values.DISCORD_TOKEN || '').trim();
  const adminUser = String(values.AUTH_ADMIN_USER || '').trim();
  const adminPass = String(values.AUTH_ADMIN_PASS || '').trim();
  if (!discordToken || /pasteyourdiscordbottokenhere/i.test(discordToken)) return false;
  if (!adminUser) return false;
  if (!adminPass) return false;
  return true;
}

function readCurrentConfig() {
  const envPath = getEnvFilePath();
  const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const parsed = parseEnvLines(raw);

  return CONFIG_FIELDS.map(field => {
    const hasConfigValue = Object.prototype.hasOwnProperty.call(activeConfigValues, field.key);
    const hasFileValue = Object.prototype.hasOwnProperty.call(parsed.values, field.key);
    const processValue = Object.prototype.hasOwnProperty.call(process.env, field.key) ? String(process.env[field.key] ?? '') : '';
    const value = hasConfigValue
      ? activeConfigValues[field.key]
      : (hasFileValue ? parsed.values[field.key] : processValue);
    return {
      ...field,
      value,
      configured: value !== ''
    };
  });
}

function validateFieldValue(field, value, key = field?.key || 'value') {
  if (value.length > 2048) {
    return { error: `Value too long for ${key}` };
  }

  if (field?.type === 'integer' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || `${parsed}` !== value.trim() || parsed < 0) {
      return { error: `Invalid integer for ${key}` };
    }
  }

  if (field?.type === 'number' && value.trim() !== '') {
    const trimmed = value.trim();
    const parsed = Number(trimmed);
    const min = Number.isFinite(field.min) ? field.min : Number.NEGATIVE_INFINITY;
    const max = Number.isFinite(field.max) ? field.max : Number.POSITIVE_INFINITY;
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed) || !Number.isFinite(parsed) || parsed < min || parsed > max) {
      return { error: `Invalid number for ${key}` };
    }
  }

  return { value };
}

function validateConfigValues(inputValues) {
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(inputValues || {})) {
    const key = String(rawKey || '').trim();
    const field = CONFIG_FIELD_MAP.get(key);
    if (!field) {
      return { error: `Unknown configuration key: ${key}` };
    }
    const value = String(rawValue ?? '');
    const validation = validateFieldValue(field, value, key);
    if (validation.error) return validation;
    out[key] = value;
  }
  return { values: out };
}

function resetConfigFileState() {
  activeConfigPath = '';
  activeConfigValues = {};
}

function loadConfigFileIntoEnv() {
  activeConfigPath = getConfigFilePath();
  activeConfigValues = {};
  if (!activeConfigPath) return null;

  detectConfigFormat(activeConfigPath);
  let values;
  try {
    values = readConfigFile(activeConfigPath);
  } catch (error) {
    throw new Error(`Could not read configuration file ${activeConfigPath}: ${error.message}`);
  }
  const validated = validateConfigValues(values);
  if (validated.error) {
    throw new Error(`Invalid configuration file ${activeConfigPath}: ${validated.error}`);
  }

  activeConfigValues = validated.values;
  Object.assign(process.env, activeConfigValues);
  return activeConfigPath;
}

function validateInput(inputValues, currentItems) {
  const out = {};
  const currentMap = new Map(currentItems.map(item => [item.key, item]));
  for (const [rawKey, rawValue] of Object.entries(inputValues || {})) {
    const key = String(rawKey || '').trim();
    if (!EDITABLE_CONFIG_KEYS.has(key)) continue;
    const field = currentMap.get(key);
    const value = String(rawValue ?? '');
    const validation = validateFieldValue(field, value, key);
    if (validation.error) return validation;

    if (field?.secret && value === '' && field.configured) {
      continue;
    }

    out[key] = value;
  }
  return { values: out };
}

function writeConfig(updatedValues, options = {}) {
  const fsImpl = options.fs || fs;
  const configPath = activeConfigPath || getConfigFilePath();
  if (configPath) {
    const beforeValues = readConfigFile(configPath);
    const nextValues = normalizeConfigValues(updatedValues);
    const changedKeys = Object.keys(nextValues).filter(key => (
      !Object.prototype.hasOwnProperty.call(beforeValues, key)
      || String(beforeValues[key]) !== String(nextValues[key])
    ));

    if (changedKeys.length) {
      writeConfigFile(configPath, nextValues, { fs: fsImpl });
      activeConfigPath = configPath;
      activeConfigValues = { ...activeConfigValues, ...nextValues };
    }
    return changedKeys;
  }

  const envPath = getEnvFilePath();
  const before = fsImpl.existsSync(envPath) ? fsImpl.readFileSync(envPath, 'utf8') : '';
  const parsed = parseEnvLines(before);
  const lines = parsed.lines.length ? [...parsed.lines] : [];
  const changedKeys = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1];
    if (!Object.prototype.hasOwnProperty.call(updatedValues, key)) continue;
    seen.add(key);
    const nextValue = quoteIfNeeded(updatedValues[key]);
    const nextLine = `${key}=${nextValue}`;
    if (line !== nextLine) {
      lines[i] = nextLine;
      changedKeys.push(key);
    }
  }

  for (const [key, value] of Object.entries(updatedValues)) {
    if (seen.has(key)) continue;
    const nextLine = `${key}=${quoteIfNeeded(value)}`;
    lines.push(nextLine);
    changedKeys.push(key);
  }

  const normalized = `${lines.join('\n').replace(/\n*$/, '')}\n`;
  if (normalized !== before) {
    writeFileAtomically(envPath, normalized, fsImpl);
  }

  return changedKeys;
}

module.exports = {
  CONFIG_FIELDS,
  DEFAULT_CONFIG_VALUES,
  ensureEnvFile,
  getActiveConfigPath,
  getEnvFilePath,
  isConfiguredForFirstBoot,
  loadConfigFileIntoEnv,
  readCurrentConfig,
  resetConfigFileState,
  validateConfigValues,
  validateInput,
  writeConfig
};
