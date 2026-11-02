const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, test } = require('node:test');
const {
  createUserStore,
  getUsersFilePath,
  hasPermission,
  hashPassword,
  PERMISSIONS,
  ROLES,
  validatePassword,
  validateRole,
  validateUsername,
  verifyPassword
} = require('../server/utils/users');

const temporaryDirs = [];

function temporaryStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bardboard-users-'));
  temporaryDirs.push(dir);
  const filePath = path.join(dir, 'users.json');
  return {
    filePath,
    store: createUserStore({ filePath, ...options })
  };
}

afterEach(() => {
  while (temporaryDirs.length) {
    fs.rmSync(temporaryDirs.pop(), { recursive: true, force: true });
  }
});

describe('user store', () => {
  test('hashes and verifies passwords', () => {
    const hash = hashPassword('correct horse battery staple');
    assert.equal(verifyPassword('correct horse battery staple', hash), true);
    assert.equal(verifyPassword('wrong password', hash), false);
    assert.equal(verifyPassword('anything', 'not-a-hash'), false);
    assert.equal(hash.includes('correct horse'), false);
  });

  test('validates usernames, passwords, and roles', () => {
    assert.equal(validateUsername(' admin '), 'admin');
    assert.throws(() => validateUsername(''), /Username/);
    assert.throws(() => validatePassword('short'), /at least 8/);
    assert.throws(() => validatePassword('x'.repeat(257)), /at most 256/);
    assert.equal(validateRole('admin'), 'admin');
    assert.throws(() => validateRole('owner'), /Unknown role/);
  });

  test('maps roles to permissions', () => {
    assert.equal(hasPermission({ role: 'admin' }, PERMISSIONS.USERS_MANAGE), true);
    assert.equal(hasPermission({ role: 'admin' }, PERMISSIONS.SYSTEM_RESTART), true);
    assert.equal(hasPermission({ role: 'user' }, PERMISSIONS.AUDIO_CONTROL), true);
    assert.equal(hasPermission({ role: 'user' }, PERMISSIONS.FILES_MANAGE), true);
    assert.equal(hasPermission({ role: 'user' }, PERMISSIONS.SETTINGS_MANAGE), false);
    assert.equal(hasPermission({ role: 'user', disabled: true }, PERMISSIONS.AUDIO_CONTROL), false);
    assert.equal(ROLES.admin.permissions.includes(PERMISSIONS.USERS_MANAGE), true);
  });

  test('creates, updates, resets, and deletes users', () => {
    const { store, filePath } = temporaryStore();
    const admin = store.create({ username: 'admin', password: 'admin-secret', role: 'admin' });
    const member = store.create({ username: 'member', password: 'member-secret', role: 'user' });

    assert.equal(store.list().length, 2);
    assert.equal(store.verifyCredentials('ADMIN', 'admin-secret').id, admin.id);
    assert.equal(store.verifyCredentials('member', 'wrong'), null);

    const promoted = store.update(member.id, { role: 'admin' });
    assert.equal(promoted.role, 'admin');
    assert.equal(store.countAdmins(), 2);

    const reset = store.setPassword(member.id, 'member-secret-2');
    assert.equal(reset.username, 'member');
    assert.equal(store.verifyCredentials('member', 'member-secret'), null);
    assert.equal(store.verifyCredentials('member', 'member-secret-2').id, member.id);

    assert.equal(store.remove(member.id), true);
    assert.equal(store.list().length, 1);

    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(saved.version, 1);
    assert.equal(saved.users.some(user => user.passwordHash.includes('admin-secret')), false);
  });

  test('prevents duplicate usernames and the last admin from losing access', () => {
    const { store } = temporaryStore();
    const admin = store.create({ username: 'Admin', password: 'admin-secret', role: 'admin' });
    assert.throws(
      () => store.create({ username: 'admin', password: 'another-secret', role: 'user' }),
      error => error.statusCode === 409
    );

    assert.throws(() => store.update(admin.id, { role: 'user' }), error => error.statusCode === 409);
    assert.throws(() => store.update(admin.id, { disabled: true }), error => error.statusCode === 409);
    assert.throws(() => store.remove(admin.id), error => error.statusCode === 409);
  });

  test('seeds legacy credentials once and then ignores them', () => {
    const { store, filePath } = temporaryStore({
      legacyUsers: [
        { username: 'legacy-admin', password: 'legacy-secret', role: 'admin' },
        { username: 'legacy-user', password: 'legacy-user-secret', role: 'user' }
      ]
    });

    assert.equal(store.list().length, 2);
    assert.equal(store.verifyCredentials('legacy-admin', 'legacy-secret').role, 'admin');
    assert.equal(fs.existsSync(filePath), true);
    assert.equal(fs.readFileSync(filePath, 'utf8').includes('legacy-secret'), false);

    const reloaded = createUserStore({
      filePath,
      legacyUsers: [{ username: 'ignored-admin', password: 'ignored-secret', role: 'admin' }]
    });
    assert.equal(reloaded.list().length, 2);
    assert.equal(reloaded.verifyCredentials('ignored-admin', 'ignored-secret'), null);
  });

  test('disabled users cannot authenticate', () => {
    const { store } = temporaryStore();
    const admin = store.create({ username: 'admin', password: 'admin-secret', role: 'admin' });
    const member = store.create({ username: 'member', password: 'member-secret', role: 'user' });
    store.update(member.id, { disabled: true });
    assert.equal(store.verifyCredentials('member', 'member-secret'), null);
    assert.equal(store.countAdmins(), 1);
    assert.equal(store.findById(admin.id).role, 'admin');
  });

  test('rejects malformed users files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bardboard-users-bad-'));
    temporaryDirs.push(dir);
    const filePath = path.join(dir, 'users.json');
    fs.writeFileSync(filePath, '{ not valid json', 'utf8');
    assert.throws(() => createUserStore({ filePath }), /Could not read users file/);
  });

  test('derives the users file path from config and environment paths', () => {
    const previous = process.env.BARDBOARD_USERS_PATH;
    try {
      delete process.env.BARDBOARD_USERS_PATH;
      assert.equal(
        getUsersFilePath({ configPath: '/srv/config/bardboard.config.yaml' }),
        path.join('/srv/config', 'users.json')
      );
      assert.equal(
        getUsersFilePath({ envPath: '/srv/app/.env' }),
        path.join('/srv/app', 'users.json')
      );
      process.env.BARDBOARD_USERS_PATH = '/srv/accounts/users.json';
      assert.equal(getUsersFilePath(), path.resolve('/srv/accounts/users.json'));
    } finally {
      if (previous === undefined) delete process.env.BARDBOARD_USERS_PATH;
      else process.env.BARDBOARD_USERS_PATH = previous;
    }
  });
});
