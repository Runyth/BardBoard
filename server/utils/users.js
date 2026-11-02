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

const PERMISSIONS = {
  AUDIO_CONTROL: 'audio:control',
  PLAYLIST_MANAGE: 'playlist:manage',
  FILES_MANAGE: 'files:manage',
  SETTINGS_MANAGE: 'settings:manage',
  USERS_MANAGE: 'users:manage',
  SYSTEM_RESTART: 'system:restart'
};

const ROLES = {
  admin: {
    label: 'Admin',
    description: 'Full access to the soundboard, files, settings, users, and restarts.',
    permissions: Object.values(PERMISSIONS)
  },
  user: {
    label: 'User',
    description: 'Use the soundboard and manage files and playlists.',
    permissions: [
      PERMISSIONS.AUDIO_CONTROL,
      PERMISSIONS.PLAYLIST_MANAGE,
      PERMISSIONS.FILES_MANAGE
    ]
  }
};

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const USERNAME_PATTERN = /^[^\x00-\x1F\x7F]{1,64}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 256;

function createError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function validateUsername(username) {
  const value = String(username || '').trim();
  if (!USERNAME_PATTERN.test(value)) {
    throw createError('Username must be 1-64 characters and contain no control characters.');
  }
  return value;
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < PASSWORD_MIN) {
    throw createError(`Password must be at least ${PASSWORD_MIN} characters.`);
  }
  if (value.length > PASSWORD_MAX) {
    throw createError(`Password must be at most ${PASSWORD_MAX} characters.`);
  }
  return value;
}

function validateRole(role) {
  if (!Object.prototype.hasOwnProperty.call(ROLES, role)) {
    throw createError('Unknown role.');
  }
  return role;
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const derived = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem
  });
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64url'),
    derived.toString('base64url')
  ].join('$');
}

function verifyPassword(password, storedHash) {
  try {
    const [scheme, n, r, p, salt, hash] = String(storedHash || '').split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const expected = Buffer.from(hash, 'base64url');
    const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

const DUMMY_HASH = hashPassword('invalid-password-placeholder');

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    disabled: Boolean(user.disabled),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt || null
  };
}

function hasPermission(user, permission) {
  if (!user || user.disabled) return false;
  const role = ROLES[user.role];
  if (!role) return false;
  return role.permissions.includes('*') || role.permissions.includes(permission);
}

function getUsersFilePath(options = {}) {
  const explicit = String(options.explicitPath ?? process.env.BARDBOARD_USERS_PATH ?? '').trim();
  if (explicit) return path.resolve(explicit);
  if (options.configPath) return path.join(path.dirname(options.configPath), 'users.json');
  if (options.envPath) return path.join(path.dirname(options.envPath), 'users.json');
  return path.join(process.cwd(), 'users.json');
}

function createUserStore(options = {}) {
  const filePath = options.filePath || getUsersFilePath(options);
  const fsImpl = options.fs || fs;
  const legacyUsers = Array.isArray(options.legacyUsers) ? options.legacyUsers : [];
  let users = [];
  let loaded = false;

  function persist() {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileAtomically(filePath, `${JSON.stringify({ version: 1, users }, null, 2)}\n`, fsImpl);
  }

  function normalizeUser(raw) {
    if (!raw || typeof raw !== 'object') throw createError('Invalid user record.');
    const username = validateUsername(raw.username);
    const role = validateRole(raw.role);
    if (typeof raw.passwordHash !== 'string' || !raw.passwordHash) {
      throw createError('Invalid user password record.');
    }
    return {
      id: String(raw.id || crypto.randomUUID()),
      username,
      role,
      passwordHash: raw.passwordHash,
      disabled: Boolean(raw.disabled),
      authVersion: Number.isInteger(raw.authVersion) ? raw.authVersion : 1,
      createdAt: String(raw.createdAt || new Date().toISOString()),
      updatedAt: String(raw.updatedAt || raw.createdAt || new Date().toISOString()),
      lastLoginAt: raw.lastLoginAt ? String(raw.lastLoginAt) : null
    };
  }

  function load() {
    if (loaded) return;
    loaded = true;
    if (fsImpl.existsSync(filePath)) {
      const raw = fsImpl.readFileSync(filePath, 'utf8');
      if (raw.trim()) {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          throw createError(`Could not read users file ${filePath}: ${error.message}`);
        }
        if (!parsed || !Array.isArray(parsed.users)) {
          throw createError(`Invalid users file ${filePath}.`);
        }
        users = parsed.users.map(normalizeUser);
      }
    }

    if (users.length === 0 && legacyUsers.length > 0) {
      let seeded = false;
      for (const legacy of legacyUsers) {
        const rawUsername = String(legacy?.username || '').trim();
        const password = String(legacy?.password || '');
        if (!rawUsername || !password) continue;
        let username;
        try {
          username = validateUsername(rawUsername);
        } catch {
          console.warn(`Skipping legacy user with invalid username: ${rawUsername}`);
          continue;
        }
        if (users.some(user => user.username.toLowerCase() === username.toLowerCase())) continue;
        const now = new Date().toISOString();
        users.push({
          id: crypto.randomUUID(),
          username,
          role: validateRole(legacy.role || 'user'),
          passwordHash: hashPassword(password),
          disabled: false,
          authVersion: 1,
          createdAt: now,
          updatedAt: now,
          lastLoginAt: null
        });
        seeded = true;
      }
      if (seeded) persist();
    }
  }

  function save() {
    persist();
  }

  function list() {
    load();
    return users.slice().sort((a, b) => a.username.localeCompare(b.username)).map(publicUser);
  }

  function findByUsername(username) {
    load();
    const key = String(username || '').trim().toLowerCase();
    if (!key) return null;
    return users.find(user => user.username.toLowerCase() === key) || null;
  }

  function findById(id) {
    load();
    return users.find(user => user.id === id) || null;
  }

  function countAdmins() {
    load();
    return users.filter(user => user.role === 'admin' && !user.disabled).length;
  }

  function hasUsers() {
    load();
    return users.length > 0;
  }

  function hasAdmin() {
    return countAdmins() > 0;
  }

  function verifyCredentials(username, password) {
    load();
    const user = findByUsername(username);
    const valid = verifyPassword(String(password || ''), user?.passwordHash || DUMMY_HASH);
    if (!user || user.disabled || !valid) return null;
    user.lastLoginAt = new Date().toISOString();
    try {
      save();
    } catch {
      // Authentication can proceed even if the audit timestamp cannot be persisted.
    }
    return user;
  }

  function create({ username, password, role }) {
    load();
    const name = validateUsername(username);
    const pass = validatePassword(password);
    const nextRole = validateRole(role);
    if (findByUsername(name)) throw createError('Username already exists.', 409);
    const now = new Date().toISOString();
    const user = {
      id: crypto.randomUUID(),
      username: name,
      role: nextRole,
      passwordHash: hashPassword(pass),
      disabled: false,
      authVersion: 1,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null
    };
    users.push(user);
    save();
    return publicUser(user);
  }

  function update(id, changes = {}) {
    load();
    const user = findById(id);
    if (!user) throw createError('User not found.', 404);

    if (changes.disabled !== undefined && typeof changes.disabled !== 'boolean') {
      throw createError('Invalid disabled value.');
    }
    const nextUsername = changes.username === undefined ? user.username : validateUsername(changes.username);
    const nextRole = changes.role === undefined ? user.role : validateRole(changes.role);
    const nextDisabled = changes.disabled === undefined ? user.disabled : changes.disabled;
    const existing = findByUsername(nextUsername);
    if (existing && existing.id !== user.id) throw createError('Username already exists.', 409);

    const losesAdmin = user.role === 'admin' && !user.disabled
      && (nextRole !== 'admin' || nextDisabled);
    if (losesAdmin && countAdmins() <= 1) {
      throw createError('At least one active admin is required.', 409);
    }

    const authChanged = user.role !== nextRole || user.disabled !== nextDisabled;
    user.username = nextUsername;
    user.role = nextRole;
    user.disabled = nextDisabled;
    user.updatedAt = new Date().toISOString();
    if (authChanged) user.authVersion += 1;
    save();
    return publicUser(user);
  }

  function setPassword(id, password) {
    load();
    const user = findById(id);
    if (!user) throw createError('User not found.', 404);
    user.passwordHash = hashPassword(validatePassword(password));
    user.authVersion += 1;
    user.updatedAt = new Date().toISOString();
    save();
    return publicUser(user);
  }

  function remove(id) {
    load();
    const user = findById(id);
    if (!user) throw createError('User not found.', 404);
    if (user.role === 'admin' && !user.disabled && countAdmins() <= 1) {
      throw createError('At least one active admin is required.', 409);
    }
    users = users.filter(item => item.id !== id);
    save();
    return true;
  }

  function upsertForSetup(username, password, role) {
    load();
    const name = validateUsername(username);
    const pass = validatePassword(password);
    const nextRole = validateRole(role);
    const existing = findByUsername(name);
    if (!existing) return create({ username: name, password: pass, role: nextRole });

    if (nextRole === 'user' && existing.role === 'admin') {
      throw createError('An admin cannot be replaced by a standard user during setup.', 409);
    }
    existing.passwordHash = hashPassword(pass);
    existing.role = nextRole;
    existing.disabled = false;
    existing.authVersion += 1;
    existing.updatedAt = new Date().toISOString();
    save();
    return publicUser(existing);
  }

  function getRoles() {
    return Object.fromEntries(Object.entries(ROLES).map(([key, role]) => [key, {
      label: role.label,
      description: role.description,
      permissions: role.permissions.slice()
    }]));
  }

  load();

  return {
    filePath,
    list,
    findById,
    findByUsername,
    verifyCredentials,
    create,
    update,
    setPassword,
    remove,
    upsertForSetup,
    countAdmins,
    hasUsers,
    hasAdmin,
    getRoles
  };
}

module.exports = {
  PERMISSIONS,
  ROLES,
  createUserStore,
  getUsersFilePath,
  hasPermission,
  hashPassword,
  validatePassword,
  validateRole,
  validateUsername,
  verifyPassword
};
