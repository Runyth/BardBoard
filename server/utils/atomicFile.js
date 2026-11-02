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

function writeFileAtomically(filePath, contents, fsImpl = fs) {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );

  try {
    fsImpl.writeFileSync(tempPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fsImpl.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fsImpl.rmSync(tempPath, { force: true });
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        console.warn('Could not remove temporary config file:', cleanupError.message);
      }
    }
    throw error;
  }
}

module.exports = { writeFileAtomically };
