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
const multer = require('multer');
const { AUDIO_DIR, ALLOWED_EXT } = require('../constants');
const { sanitizeCategory } = require('../utils/path');

function createUpload(options = {}) {
  const audioDir = options.audioDir || AUDIO_DIR;
  const allowedExt = options.allowedExt || ALLOWED_EXT;
  const fsImpl = options.fs || fs;
  const maxUploadMb = options.maxUploadMb
    ?? Math.max(1, Number.parseInt(process.env.UPLOAD_MAX_MB || '50', 10));

  const storage = {
    _handleFile(req, file, cb) {
      const input = String(req.query.category || '').trim();
      const category = sanitizeCategory(input);
      const fileName = path.basename(file.originalname);
      const targetDir = category ? path.join(audioDir, category) : audioDir;
      const targetPath = path.join(targetDir, fileName);
      let output;
      let opened = false;
      let settled = false;

      const recordFailure = error => {
        const message = error?.message || 'Upload failed';
        if (file.stream && typeof file.stream.resume === 'function') file.stream.resume();
        if (Array.isArray(req.uploadFailures)) {
          req.uploadFailures.push({ index: file._batchIndex, fileName, error: message });
          return cb(null, { skipped: true, index: file._batchIndex, filename: fileName });
        }
        return cb(error);
      };

      if (input && category !== input) return recordFailure(new Error('Invalid category'));

      let fd;
      try {
        fsImpl.mkdirSync(targetDir, { recursive: true });
        fd = fsImpl.openSync(targetPath, 'wx');
        output = fsImpl.createWriteStream(targetPath, { fd, autoClose: true });
        opened = true;
      } catch (error) {
        if (fd !== undefined) {
          try {
            fsImpl.closeSync(fd);
          } catch {
            // The descriptor may already be closed by a failed stream setup.
          }
          try {
            fsImpl.unlinkSync(targetPath);
          } catch {
            // Best-effort cleanup for a zero-byte reservation.
          }
        }
        const uploadError = error.code === 'EEXIST'
          ? Object.assign(new Error('A file with the same name already exists'), { code: error.code })
          : error;
        return recordFailure(uploadError);
      }

      const finish = error => {
        if (settled) return;
        settled = true;

        if (!error) {
          return cb(null, {
            destination: targetDir,
            filename: fileName,
            path: targetPath,
            size: output.bytesWritten,
            index: file._batchIndex
          });
        }

        const uploadError = error.code === 'EEXIST'
          ? Object.assign(new Error('A file with the same name already exists'), { code: error.code })
          : error;
        if (file.stream && typeof file.stream.unpipe === 'function') file.stream.unpipe(output);
        if (!opened) return recordFailure(uploadError);

        fsImpl.unlink(targetPath, cleanupError => {
          if (cleanupError && cleanupError.code !== 'ENOENT') {
            console.warn('Could not remove partial upload:', cleanupError.message);
          }
          recordFailure(uploadError);
        });
      };

      output.on('error', finish);
      file.stream.on('error', finish);
      file.stream.pipe(output);
      output.on('finish', () => finish());
      output.on('close', () => {
        if (!settled) finish(new Error('Upload stream closed unexpectedly'));
      });
    },

    _removeFile(_req, file, cb) {
      if (!file.path) return cb(null);
      fsImpl.unlink(file.path, cb);
    }
  };

  return multer({
    storage,
    limits: {
      fileSize: maxUploadMb * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
      const index = Number.isInteger(req._batchIndex) ? req._batchIndex : 0;
      req._batchIndex = index + 1;
      file._batchIndex = index;

      const ext = path.extname(file.originalname).toLowerCase();
      if (!allowedExt.has(ext)) {
        if (Array.isArray(req.uploadFailures)) {
          req.uploadFailures.push({
            index,
            fileName: path.basename(file.originalname),
            error: 'Unsupported file type'
          });
          return cb(null, false);
        }
        return cb(new Error('Unsupported file type'));
      }
      cb(null, true);
    }
  });
}

module.exports = { createUpload };
