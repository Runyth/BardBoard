'use client';

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
import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export default function UsersPage() {
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState({});
  const [drafts, setDrafts] = useState({});
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'user' });
  const [savingId, setSavingId] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [resetModal, setResetModal] = useState({ open: false, user: null, password: '' });
  const [deleteModal, setDeleteModal] = useState({ open: false, user: null });

  const roleEntries = useMemo(() => Object.entries(roles), [roles]);

  const loadUsers = async () => {
    const response = await fetch('/api/users', { cache: 'no-store' });
    if (response.status === 401) {
      window.location.replace('/login');
      throw new Error('Unauthorized');
    }
    if (response.status === 403) {
      window.location.replace('/');
      throw new Error('Forbidden');
    }
    const data = await readJson(response);
    if (!response.ok) throw new Error(data.error || 'Failed to load users.');
    const nextUsers = Array.isArray(data.users) ? data.users : [];
    setUsers(nextUsers);
    setRoles(data.roles || {});
    setDrafts(Object.fromEntries(nextUsers.map(user => [user.id, {
      username: user.username,
      role: user.role,
      disabled: Boolean(user.disabled)
    }])));
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const authResponse = await fetch('/api/auth/status', { cache: 'no-store' });
        if (authResponse.status === 401) {
          window.location.replace('/login');
          return;
        }
        const auth = await readJson(authResponse);
        if (!auth.authEnabled || !auth.canManageUsers) {
          window.location.replace('/');
          return;
        }
        if (cancelled) return;
        await loadUsers();
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load users.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const updateDraft = (id, changes) => {
    setDrafts(previous => ({ ...previous, [id]: { ...previous[id], ...changes } }));
  };

  const createUser = async event => {
    event.preventDefault();
    setError('');
    setStatus('');
    setCreating(true);
    try {
      const response = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newUser)
      });
      const data = await readJson(response);
      if (response.status === 401) {
        window.location.replace('/login');
        return;
      }
      if (!response.ok) throw new Error(data.error || 'Failed to create user.');
      setNewUser({ username: '', password: '', role: 'user' });
      await loadUsers();
      setStatus(`User "${data.user.username}" created.`);
    } catch (err) {
      setError(err?.message || 'Failed to create user.');
    } finally {
      setCreating(false);
    }
  };

  const saveUser = async user => {
    const draft = drafts[user.id];
    if (!draft) return;
    setSavingId(user.id);
    setError('');
    setStatus('');
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(user.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft)
      });
      const data = await readJson(response);
      if (response.status === 401) {
        window.location.replace('/login');
        return;
      }
      if (!response.ok) throw new Error(data.error || 'Failed to update user.');
      await loadUsers();
      setStatus(`User "${data.user.username}" updated.`);
    } catch (err) {
      setError(err?.message || 'Failed to update user.');
    } finally {
      setSavingId('');
    }
  };

  const resetPassword = async event => {
    event.preventDefault();
    const user = resetModal.user;
    if (!user) return;
    setError('');
    setStatus('');
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(user.id)}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: resetModal.password })
      });
      const data = await readJson(response);
      if (response.status === 401) {
        window.location.replace('/login');
        return;
      }
      if (!response.ok) throw new Error(data.error || 'Failed to reset password.');
      setResetModal({ open: false, user: null, password: '' });
      setStatus(`Password reset for "${user.username}".`);
    } catch (err) {
      setError(err?.message || 'Failed to reset password.');
    }
  };

  const deleteUser = async () => {
    const user = deleteModal.user;
    if (!user) return;
    setError('');
    setStatus('');
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' });
      const data = await readJson(response);
      if (response.status === 401) {
        window.location.replace('/login');
        return;
      }
      if (!response.ok) throw new Error(data.error || 'Failed to delete user.');
      setDeleteModal({ open: false, user: null });
      await loadUsers();
      setStatus(`User "${user.username}" deleted.`);
    } catch (err) {
      setError(err?.message || 'Failed to delete user.');
    }
  };

  return (
    <div className="settings-page">
      <div className="ambient-bg" aria-hidden="true">
        <div className="particle" />
        <div className="particle" />
        <div className="particle" />
        <div className="particle" />
      </div>
      <main className="settings-main">
        <section className="settings-surface">
          <header className="settings-header">
            <h1 className="settings-title">Users</h1>
            <p className="settings-subtitle">Manage accounts, roles, and access to BardBoard.</p>
          </header>

          {loading ? (
            <div className="settings-loading">
              <Image className="loader-ouroboros" src="/ouroboros.svg" alt="Loading users" width={72} height={72} />
              <p>Loading users...</p>
            </div>
          ) : (
            <>
              <section className="settings-section">
                <h2>Create user</h2>
                <form className="user-create" onSubmit={createUser}>
                  <label className="settings-field">
                    <span className="field-label">Username</span>
                    <input
                      className="field-input login-input"
                      value={newUser.username}
                      onChange={event => setNewUser(previous => ({ ...previous, username: event.target.value }))}
                      autoComplete="off"
                      required
                    />
                  </label>
                  <label className="settings-field">
                    <span className="field-label">Password</span>
                    <input
                      className="field-input login-input"
                      type="password"
                      value={newUser.password}
                      onChange={event => setNewUser(previous => ({ ...previous, password: event.target.value }))}
                      autoComplete="new-password"
                      minLength={8}
                      required
                    />
                  </label>
                  <label className="settings-field">
                    <span className="field-label">Role</span>
                    <select
                      className="field-input login-input"
                      value={newUser.role}
                      onChange={event => setNewUser(previous => ({ ...previous, role: event.target.value }))}
                    >
                      {roleEntries.map(([value, role]) => (
                        <option key={value} value={value}>{role.label}</option>
                      ))}
                    </select>
                  </label>
                  <button className="ctrl-btn ctrl-upload" type="submit" disabled={creating}>
                    {creating ? 'Creating...' : 'Create user'}
                  </button>
                </form>
              </section>

              <section className="settings-section">
                <h2>Existing users</h2>
                <div className="user-list">
                  {users.map(user => {
                    const draft = drafts[user.id] || user;
                    return (
                      <div key={user.id} className={`user-row${draft.disabled ? ' user-row-disabled' : ''}`}>
                        <label className="settings-field">
                          <span className="field-label">Username</span>
                          <input
                            className="field-input login-input"
                            value={draft.username}
                            onChange={event => updateDraft(user.id, { username: event.target.value })}
                          />
                        </label>
                        <label className="settings-field">
                          <span className="field-label">Role</span>
                          <select
                            className="field-input login-input"
                            value={draft.role}
                            onChange={event => updateDraft(user.id, { role: event.target.value })}
                          >
                            {roleEntries.map(([value, role]) => (
                              <option key={value} value={value}>{role.label}</option>
                            ))}
                          </select>
                        </label>
                        <label className="user-checkbox">
                          <input
                            type="checkbox"
                            checked={Boolean(draft.disabled)}
                            onChange={event => updateDraft(user.id, { disabled: event.target.checked })}
                          />
                          Disabled
                        </label>
                        <div className="user-actions">
                          <button className="ctrl-btn" type="button" onClick={() => void saveUser(user)} disabled={savingId === user.id}>
                            {savingId === user.id ? 'Saving...' : 'Save'}
                          </button>
                          <button className="ctrl-btn" type="button" onClick={() => setResetModal({ open: true, user, password: '' })}>
                            Reset password
                          </button>
                          <button className="ctrl-btn confirm-danger" type="button" onClick={() => setDeleteModal({ open: true, user })}>
                            Delete
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              {error && <p className="login-error settings-error">{error}</p>}
              {status && <p className="settings-status">{status}</p>}

              <div className="settings-actions">
                <Link className="ctrl-btn login-submit" href="/">Back to dashboard</Link>
                <Link className="ctrl-btn login-submit" href="/settings">Settings</Link>
              </div>
            </>
          )}
        </section>
      </main>

      <div className={`confirm-modal${resetModal.open ? ' open' : ''}`} onClick={event => { if (event.target === event.currentTarget) setResetModal({ open: false, user: null, password: '' }); }}>
        <div className="confirm-panel">
          <h2>Reset password</h2>
          <p>Set a new password for &quot;{resetModal.user?.username}&quot;.</p>
          <form onSubmit={resetPassword}>
            <label className="settings-field">
              <span className="field-label">New password</span>
              <input
                className="field-input login-input"
                type="password"
                value={resetModal.password}
                onChange={event => setResetModal(previous => ({ ...previous, password: event.target.value }))}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </label>
            <div className="confirm-actions">
              <button className="ctrl-btn" type="button" onClick={() => setResetModal({ open: false, user: null, password: '' })}>Cancel</button>
              <button className="ctrl-btn ctrl-upload" type="submit">Reset password</button>
            </div>
          </form>
        </div>
      </div>

      <div className={`confirm-modal${deleteModal.open ? ' open' : ''}`} onClick={event => { if (event.target === event.currentTarget) setDeleteModal({ open: false, user: null }); }}>
        <div className="confirm-panel">
          <h2>Delete user</h2>
          <p>Delete &quot;{deleteModal.user?.username}&quot;? This action cannot be undone.</p>
          <div className="confirm-actions">
            <button className="ctrl-btn" type="button" onClick={() => setDeleteModal({ open: false, user: null })}>Cancel</button>
            <button className="ctrl-btn confirm-danger" type="button" onClick={() => void deleteUser()}>Delete user</button>
          </div>
        </div>
      </div>
    </div>
  );
}
