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
const express = require('express');

function handleError(res, error) {
  return res.status(error?.statusCode || 400).json({
    error: error?.message || 'User operation failed'
  });
}

function createUserRoutes(userStore) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    res.json({ users: userStore.list(), roles: userStore.getRoles() });
  });

  router.post('/', (req, res) => {
    try {
      const user = userStore.create({
        username: req.body?.username,
        password: req.body?.password,
        role: req.body?.role || 'user'
      });
      return res.status(201).json({ ok: true, user });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.patch('/:id', (req, res) => {
    try {
      const user = userStore.update(req.params.id, {
        username: req.body?.username,
        role: req.body?.role,
        disabled: req.body?.disabled
      });
      return res.json({ ok: true, user });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.post('/:id/password', (req, res) => {
    try {
      const user = userStore.setPassword(req.params.id, req.body?.password);
      return res.json({ ok: true, user });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.delete('/:id', (req, res) => {
    try {
      userStore.remove(req.params.id);
      return res.json({ ok: true });
    } catch (error) {
      return handleError(res, error);
    }
  });

  return router;
}

module.exports = createUserRoutes;
