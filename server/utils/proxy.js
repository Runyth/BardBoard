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
function parseTrustProxy(rawValue) {
  const value = String(rawValue ?? '').trim().toLowerCase();
  if (!value || value === 'false' || value === '0') return false;
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new Error('TRUST_PROXY must be false or a trusted hop count');
}

function applyTrustProxy(app, rawValue = process.env.TRUST_PROXY) {
  const setting = parseTrustProxy(rawValue);
  app.set('trust proxy', setting);
  return setting;
}

module.exports = {
  applyTrustProxy,
  parseTrustProxy
};
