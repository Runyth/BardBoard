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
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Events, Client, GatewayIntentBits } = require('discord.js');
const helmet = require('helmet');
const cors = require('cors');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const FileStore = require('session-file-store')(session);
const fs = require('fs');
const { createDiscordAudioService } = require('./services/discordAudio');
const createAudioRoutes = require('./routes/audio');
const createPlaylistRoutes = require('./routes/playlist');
const createFileRoutes = require('./routes/files');
const openApiSpec = require('./docs/openapi');
const { ensureEnvFile, getActiveConfigPath, getEnvFilePath, loadConfigFileIntoEnv, readCurrentConfig, validateInput, writeConfig } = require('./utils/envConfig');
const { createUserStore, getUsersFilePath, hasPermission, PERMISSIONS, ROLES } = require('./utils/users');
const createUserRoutes = require('./routes/users');
const deploymentEnvKeys = ['WEB_PORT', 'BOT_PORT', 'BACKEND_URL', 'UPLOAD_MAX_MB', 'SESSION_DIR'];
const deploymentEnv = Object.fromEntries(deploymentEnvKeys
  .filter(key => Object.prototype.hasOwnProperty.call(process.env, key))
  .map(key => [key, process.env[key]]));
ensureEnvFile();
require('dotenv').config({ path: getEnvFilePath(), override: true });
loadConfigFileIntoEnv();
Object.assign(process.env, deploymentEnv);

const userStore = createUserStore({
  filePath: getUsersFilePath({
    configPath: getActiveConfigPath(),
    envPath: getEnvFilePath()
  }),
  legacyUsers: [
    { username: process.env.AUTH_ADMIN_USER, password: process.env.AUTH_ADMIN_PASS, role: 'admin' },
    { username: process.env.AUTH_READONLY_USER, password: process.env.AUTH_READONLY_PASS, role: 'user' }
  ]
});

const app = express();
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const audioService = createDiscordAudioService(discordClient);


const corsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const sessionDir = process.env.SESSION_DIR || path.join(__dirname, '..', 'sessions');
const sessionStoreLogFn = (message) => {
  const text = String(message || '');
  if (text.includes('ENOENT') && text.includes('[session-file-store]')) return;
  console.warn(text);
};
const sessionStore = new FileStore({
  path: sessionDir,
  retries: Number.parseInt(process.env.SESSION_FILE_RETRIES || '5', 10),
  factor: Number.parseInt(process.env.SESSION_FILE_RETRY_FACTOR || '1', 10),
  minTimeout: Number.parseInt(process.env.SESSION_FILE_RETRY_MIN_MS || '50', 10),
  maxTimeout: Number.parseInt(process.env.SESSION_FILE_RETRY_MAX_MS || '200', 10),
  logFn: sessionStoreLogFn
});

function withFsRetry(store, methodName) {
  const original = store[methodName];
  if (typeof original !== 'function') return;

  store[methodName] = function wrappedStoreMethod(sessionId, sessionData, callback) {
    const maxAttempts = Math.max(1, Number.parseInt(process.env.SESSION_WRITE_RETRIES || '6', 10));
    let attempt = 0;

    const run = () => {
      original.call(store, sessionId, sessionData, (err, value) => {
        if (err && (err.code === 'EPERM' || err.code === 'EBUSY') && attempt < maxAttempts - 1) {
          attempt += 1;
          const delayMs = Math.min(40 * (attempt + 1), 250);
          return setTimeout(run, delayMs);
        }
        if (typeof callback === 'function') callback(err, value);
      });
    };

    run();
  };
}

function withMissingSessionAsEmpty(store) {
  const original = store.get;
  if (typeof original !== 'function') return;

  store.get = function wrappedGet(sessionId, callback) {
    original.call(store, sessionId, (err, value) => {
      if (err && err.code === 'ENOENT') {
        if (typeof callback === 'function') callback(null, null);
        return;
      }
      if (typeof callback === 'function') callback(err, value);
    });
  };
}

withFsRetry(sessionStore, 'set');
withFsRetry(sessionStore, 'touch');
withMissingSessionAsEmpty(sessionStore);

function isSetupRequiredNow() {
  return !userStore.hasAdmin();
}

function getAuthConfig() {
  return {
    rememberDays: Math.max(1, Number.parseInt(process.env.LOGIN_REMEMBER_DAYS || '30', 10)),
    authEnabled: userStore.hasUsers()
  };
}

function getSessionUser(req) {
  if (!req.session?.authenticated || !req.session.userId) return null;
  const user = userStore.findById(req.session.userId);
  if (!user || user.disabled || user.authVersion !== req.session.authVersion) return null;
  return user;
}

function permissionsForUser(user) {
  if (!user || !ROLES[user.role]) return [];
  return ROLES[user.role].permissions.slice();
}

function cleanupNonRememberSessions() {
  try {
    if (!fs.existsSync(sessionDir)) return;
    const files = fs.readdirSync(sessionDir);
    files.forEach(file => {
      if (!file.endsWith('.json')) return;
      const fullPath = path.join(sessionDir, file);
      try {
        const raw = fs.readFileSync(fullPath, 'utf8');
        const data = JSON.parse(raw);
        if (!data || !data.remember) {
          fs.unlinkSync(fullPath);
        }
      } catch (err) {
        fs.unlinkSync(fullPath);
      }
    });
  } catch (err) {
    console.warn('Session cleanup skipped:', err.message);
  }
}

function purgeAllSessions() {
  try {
    if (!fs.existsSync(sessionDir)) return;
    const files = fs.readdirSync(sessionDir);
    for (const file of files) {
      const fullPath = path.join(sessionDir, file);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) fs.unlinkSync(fullPath);
      } catch {
        // Ignore per-file errors during purge.
      }
    }
  } catch (err) {
    console.warn('Session purge skipped:', err.message);
  }
}

app.use(helmet({ contentSecurityPolicy: false }));
if (corsOrigins.length > 0) {
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || corsOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('Not allowed by CORS'));
    },
    credentials: true
  }));
  app.use((err, _req, res, next) => {
    if (err?.message === 'Not allowed by CORS') {
      return res.status(403).json({ error: 'Origin not allowed' });
    }
    return next(err);
  });
}
cleanupNonRememberSessions();
const sessionSecret = String(process.env.SESSION_SECRET || '').trim();
if (!sessionSecret) {
  const generated = crypto.randomBytes(32).toString('hex');
  process.env.SESSION_SECRET = generated;
  console.warn('SESSION_SECRET was empty; generated a random secret for this process.');
}
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    sameSite: 'lax'
  }
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use((req, _res, next) => {
  if (!req.body) req.body = {};
  next();
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number.parseInt(process.env.RATE_LIMIT_LOGIN || '20', 10),
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' }
});
const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number.parseInt(process.env.RATE_LIMIT_SETUP || '10', 10),
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many setup attempts. Try again later.' }
});

app.get('/setup/status', (_req, res) => {
  res.status(200).json({ setupRequired: isSetupRequiredNow() });
});

app.post('/setup/complete', setupLimiter, (req, res) => {
  if (!isSetupRequiredNow()) return res.status(409).json({ error: 'Setup already completed' });

  const discordToken = String(req.body?.discordToken || '').trim();
  const adminUserInput = String(req.body?.adminUser || '').trim();
  const adminPassInput = String(req.body?.adminPass || '');
  const readonlyEnabled = Boolean(req.body?.readonlyEnabled);
  const readonlyUserInput = String(req.body?.readonlyUser || '').trim();
  const readonlyPassInput = String(req.body?.readonlyPass || '');

  if (!discordToken || /pasteyourdiscordbottokenhere/i.test(discordToken)) {
    return res.status(400).json({ error: 'Discord token is required' });
  }
  if (!adminUserInput) return res.status(400).json({ error: 'Admin username is required' });
  if (!adminPassInput) return res.status(400).json({ error: 'Admin password is required' });
  if (readonlyEnabled && (!readonlyUserInput || !readonlyPassInput)) {
    return res.status(400).json({ error: 'Readonly credentials must include both username and password' });
  }
  if (readonlyEnabled && readonlyUserInput.toLowerCase() === adminUserInput.toLowerCase()) {
    return res.status(400).json({ error: 'Admin and standard user usernames must be different' });
  }

  let admin;
  try {
    admin = userStore.upsertForSetup(adminUserInput, adminPassInput, 'admin');
    if (readonlyEnabled) {
      userStore.upsertForSetup(readonlyUserInput, readonlyPassInput, 'user');
    }
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message });
  }

  const changedKeys = writeConfig({
    DISCORD_TOKEN: discordToken,
    BACKEND_URL: process.env.BACKEND_URL || `http://localhost:${process.env.BOT_PORT || '3001'}`
  });

  process.env.DISCORD_TOKEN = discordToken;

  req.session.regenerate(error => {
    if (error) return res.status(500).json({ error: 'Setup failed' });
    req.session.authenticated = true;
    req.session.userId = admin.id;
    req.session.username = admin.username;
    req.session.role = admin.role;
    req.session.authVersion = userStore.findById(admin.id)?.authVersion || 1;
    req.session.remember = false;
    req.session.save(() => {
      ensureDiscordLogin();
      res.status(200).json({ ok: true, changedKeys, restartRequired: true });
    });
  });
});

app.post('/auth/login', loginLimiter, (req, res) => {
  if (isSetupRequiredNow()) return res.status(503).json({ error: 'Initial setup required', setupRequired: true });
  const auth = getAuthConfig();
  if (!auth.authEnabled) return res.status(200).json({ ok: true });

  const username = (req.body.username || '').toString();
  const password = (req.body.password || '').toString();
  const user = userStore.verifyCredentials(username, password);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  req.session.regenerate(error => {
    if (error) return res.status(500).json({ error: 'Login failed' });
    req.session.authenticated = true;
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.authVersion = user.authVersion;
    req.session.remember = Boolean(req.body.remember);
    if (req.body.remember) {
      req.session.cookie.maxAge = auth.rememberDays * 24 * 60 * 60 * 1000;
    }
    req.session.save(saveError => {
      if (saveError) return res.status(500).json({ error: 'Login failed' });
      return res.status(200).json({ ok: true, role: user.role });
    });
  });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.status(200).json({ ok: true });
  });
});

app.get('/auth/status', (req, res) => {
  const auth = getAuthConfig();
  const user = getSessionUser(req);
  res.status(200).json({
    setupRequired: isSetupRequiredNow(),
    authEnabled: Boolean(auth.authEnabled),
    authenticated: Boolean(user),
    username: user?.username || null,
    role: user?.role || null,
    permissions: permissionsForUser(user),
    canManageSettings: hasPermission(user, PERMISSIONS.SETTINGS_MANAGE),
    canManageUsers: hasPermission(user, PERMISSIONS.USERS_MANAGE)
  });
});

app.use((req, res, next) => {
  const auth = getAuthConfig();
  if (isSetupRequiredNow()) {
    if (req.path === '/setup/status' || req.path === '/setup/complete') return next();
    if (req.path === '/health') return next();
    if (req.path === '/auth/status') return next();
    return res.status(503).json({ error: 'Initial setup required', setupRequired: true });
  }
  if (!auth.authEnabled) return next();
  const user = getSessionUser(req);
  if (user) {
    req.user = user;
    return next();
  }
  if (req.path === '/auth/login' || req.path === '/auth/logout' || req.path === '/auth/status') return next();
  if (req.path === '/health') return next();
  if (req.path === '/api-docs') return res.redirect('/login');
  return res.status(401).json({ error: 'Unauthorized' });
});

const ACTION_PERMISSIONS = new Map([
  ['POST /play-audio', PERMISSIONS.AUDIO_CONTROL],
  ['POST /toggle-pause', PERMISSIONS.AUDIO_CONTROL],
  ['POST /stop-audio', PERMISSIONS.AUDIO_CONTROL],
  ['POST /switch-channel', PERMISSIONS.AUDIO_CONTROL],
  ['POST /leave-channel', PERMISSIONS.AUDIO_CONTROL],
  ['POST /toggle-repeat', PERMISSIONS.AUDIO_CONTROL],
  ['POST /set-volume', PERMISSIONS.AUDIO_CONTROL],
  ['POST /seek', PERMISSIONS.AUDIO_CONTROL],
  ['POST /playlist/add', PERMISSIONS.PLAYLIST_MANAGE],
  ['POST /playlist/set', PERMISSIONS.PLAYLIST_MANAGE],
  ['POST /playlist/shuffle', PERMISSIONS.PLAYLIST_MANAGE],
  ['POST /playlist/clear', PERMISSIONS.PLAYLIST_MANAGE],
  ['POST /playlist/play', PERMISSIONS.PLAYLIST_MANAGE],
  ['POST /playlist/skip', PERMISSIONS.PLAYLIST_MANAGE],
  ['POST /upload-audio', PERMISSIONS.FILES_MANAGE],
  ['POST /upload-audio-batch', PERMISSIONS.FILES_MANAGE],
  ['POST /audio-file/move', PERMISSIONS.FILES_MANAGE],
  ['POST /audio-file/rename', PERMISSIONS.FILES_MANAGE],
  ['DELETE /audio-file', PERMISSIONS.FILES_MANAGE],
  ['POST /audio-category', PERMISSIONS.FILES_MANAGE],
  ['POST /audio-category/rename', PERMISSIONS.FILES_MANAGE],
  ['DELETE /audio-category', PERMISSIONS.FILES_MANAGE]
]);

function normalizeRequestPath(rawPath) {
  const segments = String(rawPath || '').split('/').filter(Boolean).map(segment => segment.toLowerCase());
  return segments.length ? `/${segments.join('/')}` : '/';
}

function permissionForRequest(req) {
  const requestPath = normalizeRequestPath(req.path);
  if (requestPath === '/settings/restart') return PERMISSIONS.SYSTEM_RESTART;
  if (requestPath.startsWith('/settings/')) return PERMISSIONS.SETTINGS_MANAGE;
  if (requestPath === '/users' || requestPath.startsWith('/users/')) return PERMISSIONS.USERS_MANAGE;
  return ACTION_PERMISSIONS.get(`${req.method} ${requestPath}`) || null;
}

app.use((req, res, next) => {
  const permission = permissionForRequest(req);
  if (!permission) return next();
  if (hasPermission(req.user, permission)) return next();
  return res.status(403).json({ error: 'Forbidden' });
});

app.use('/users', createUserRoutes(userStore));

app.get('/env-config', (req, res) => {
  const uploadMaxMb = Math.max(1, Number.parseInt(process.env.UPLOAD_MAX_MB || '50', 10));
  res.json({
    uploadMaxMb
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/settings/config', (_req, res) => {
  const items = readCurrentConfig()
    .filter(item => item.settingsEditable !== false)
    .map(item => ({
    key: item.key,
    label: item.label,
    description: item.description || '',
    section: item.section,
    secret: Boolean(item.secret),
    type: item.type || 'string',
    configured: Boolean(item.configured),
    value: item.secret ? '' : item.value
    }));
  res.json({ items });
});

app.post('/settings/config', (req, res) => {
  const currentItems = readCurrentConfig();
  const currentMap = new Map(currentItems.map(item => [item.key, item]));
  const validated = validateInput(req.body?.values, currentItems);
  if (validated.error) return res.status(400).json({ error: validated.error });

  const changedKeys = writeConfig(validated.values || {});
  const changedItems = changedKeys
    .map(key => currentMap.get(key))
    .filter(Boolean);
  const botRestartRequired = changedItems.some(item => item.restartScope === 'bot' || item.restartScope === 'both');
  const webRestartRequired = changedItems.some(item => item.restartScope === 'web' || item.restartScope === 'both');
  const authChanged = changedKeys.includes('SESSION_SECRET');

  return res.json({
    ok: true,
    changedKeys,
    authChanged,
    botRestartRequired,
    webRestartRequired
  });
});

app.post('/settings/restart', (req, res) => {
  if (req.body?.purgeSessions) purgeAllSessions();
  const isDev = process.env.NODE_ENV !== 'production';
  res.json({ ok: true, restarting: !isDev });
  if (isDev) return;
  setTimeout(() => {
    shutdownAndExit('settings restart');
  }, 200);
});

app.get('/voice-channels', (_req, res) => {
  const channels = [];

  for (const guild of discordClient.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (typeof channel.isVoiceBased !== 'function' || !channel.isVoiceBased()) continue;
      channels.push({
        guildId: guild.id,
        guildName: guild.name,
        channelId: channel.id,
        channelName: channel.name,
        position: Number(channel.rawPosition) || 0
      });
    }
  }

  channels.sort((a, b) => {
    const guildCmp = a.guildName.localeCompare(b.guildName);
    if (guildCmp !== 0) return guildCmp;
    if (a.position !== b.position) return a.position - b.position;
    return a.channelName.localeCompare(b.channelName);
  });

  res.json({ channels });
});

app.use(createAudioRoutes(audioService));
app.use(createPlaylistRoutes(audioService));
app.use(createFileRoutes(audioService));

app.get('/api-docs.json', (_req, res) => {
  res.json(openApiSpec);
});

app.get('/api-docs', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>BardBoard API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: '/api-docs.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis],
      layout: 'BaseLayout',
      tagsSorter: 'alpha',
      operationsSorter: (a, b) => {
        const methodOrder = { get: 0, post: 1, put: 2, delete: 3, patch: 4, options: 5, head: 6 };
        const aMethod = String(a.get('method') || '').toLowerCase();
        const bMethod = String(b.get('method') || '').toLowerCase();
        const aRank = Object.prototype.hasOwnProperty.call(methodOrder, aMethod) ? methodOrder[aMethod] : 999;
        const bRank = Object.prototype.hasOwnProperty.call(methodOrder, bMethod) ? methodOrder[bMethod] : 999;
        if (aRank !== bRank) return aRank - bRank;

        const aPath = String(a.get('path') || '');
        const bPath = String(b.get('path') || '');
        const pathCmp = aPath.localeCompare(bPath);
        if (pathCmp !== 0) return pathCmp;

        return aMethod.localeCompare(bMethod);
      }
    });
  </script>
</body>
</html>`);
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  console.error('Unhandled API error:', error);
  res.status(error?.statusCode || 500).json({ error: 'Internal server error' });
});

discordClient.on(Events.ClientReady, () => {
  console.log(`Logged in as ${discordClient.user.tag}!`);
});

discordClient.on('error', err => {
  console.error('Discord client error:', err?.message || err);
});

let discordLoginStarted = false;
function ensureDiscordLogin() {
  const discordToken = (process.env.DISCORD_TOKEN || '').trim();
  if (!discordToken) {
    console.warn('DISCORD_TOKEN not configured. API is running, but Discord features are disabled.');
    return;
  }
  if (discordLoginStarted) return;
  discordLoginStarted = true;
  discordClient.login(discordToken).catch(err => {
    discordLoginStarted = false;
    console.error('Discord login failed. API is running, but Discord features are disabled.');
    console.error(err?.message || err);
  });
}
const port = Number.parseInt(process.env.BOT_PORT || '3001', 10);
let httpServer = null;
let stopPromise = null;

function start() {
  if (httpServer) return httpServer;
  stopPromise = null;
  ensureDiscordLogin();
  httpServer = app.listen(port, '0.0.0.0', () => console.log('Bot/API server running on port', port));
  return httpServer;
}

function stop() {
  if (stopPromise) return stopPromise;
  const serverToClose = httpServer;

  stopPromise = Promise.all([
    new Promise((resolve, reject) => {
      if (!serverToClose) return resolve();
      serverToClose.close(error => error ? reject(error) : resolve());
      if (typeof serverToClose.closeIdleConnections === 'function') {
        serverToClose.closeIdleConnections();
      }
    }),
    Promise.resolve().then(() => audioService.shutdown()),
    Promise.resolve().then(() => discordClient.destroy())
  ]).then(() => {
    if (httpServer === serverToClose) httpServer = null;
    discordLoginStarted = false;
  });

  return stopPromise;
}

let exitStarted = false;
async function shutdownAndExit(reason, exitCode = 0) {
  if (exitStarted) return;
  exitStarted = true;
  console.log(`Shutting down (${reason})...`);
  const forceExitTimer = setTimeout(() => {
    console.error('Graceful shutdown timed out; forcing exit.');
    process.exit(1);
  }, 10000);
  forceExitTimer.unref();

  try {
    await stop();
    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  } catch (error) {
    clearTimeout(forceExitTimer);
    console.error('Graceful shutdown failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  process.once('SIGTERM', () => shutdownAndExit('SIGTERM'));
  process.once('SIGINT', () => shutdownAndExit('SIGINT'));
  start();
}

module.exports = {
  app,
  audioService,
  discordClient,
  ensureDiscordLogin,
  start,
  stop
};
