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
const { AUDIO_DIR, STAGING_DIR_NAME } = require('../constants');
const { hasAllowedExt, hasPlayableExt } = require('../utils/path');
const { hashAudioFile } = require('../utils/audioHash');

function createAudioLibrary(options = {}) {
  const audioDir = path.resolve(options.audioDir || AUDIO_DIR);
  const fsImpl = options.fs || fs;
  const hashFile = options.hashFile || hashAudioFile;
  const stagingDir = path.join(audioDir, STAGING_DIR_NAME);
  const stagingMaxAgeMs = options.stagingMaxAgeMs ?? 24 * 60 * 60 * 1000;
  const hashCache = new Map();
  let operationQueue = Promise.resolve();

  function normalizeRelativePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  }

  function isLibraryFile(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) return false;
    const segments = normalized.split('/');
    if (segments.some(segment => !segment || segment === '..' || segment.startsWith('.'))) return false;
    return hasPlayableExt(normalized);
  }

  function collectFiles(dir, relativeDir, files) {
    let entries;
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        collectFiles(fullPath, relativePath, files);
      } else if (entry.isFile() && hasPlayableExt(entry.name)) {
        files.push({ relativePath, fullPath });
      }
    }
  }

  function pruneStaging(now = Date.now()) {
    let entries;
    try {
      entries = fsImpl.readdirSync(stagingDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !/\.(upload|backup)$/.test(entry.name)) continue;
      const fullPath = path.join(stagingDir, entry.name);
      try {
        const stat = fsImpl.statSync(fullPath);
        if (now - stat.mtimeMs >= stagingMaxAgeMs) fsImpl.unlinkSync(fullPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          console.warn('Could not prune staged upload:', error.message);
        }
      }
    }
  }

  async function scan() {
    pruneStaging();
    const files = [];
    collectFiles(audioDir, '', files);
    const seen = new Set();
    const entries = [];

    for (const file of files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
      seen.add(file.relativePath);
      try {
        const stat = fsImpl.statSync(file.fullPath);
        if (!stat.isFile()) continue;
        const cached = hashCache.get(file.relativePath);
        let hash;
        if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
          hash = cached.hash;
        } else {
          hash = await hashFile(file.fullPath, fsImpl);
          hashCache.set(file.relativePath, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            hash
          });
        }

        entries.push({
          path: file.relativePath,
          name: path.basename(file.relativePath),
          extension: path.extname(file.relativePath).toLowerCase(),
          size: stat.size,
          modifiedAt: stat.mtimeMs,
          hash,
          uploadSupported: hasAllowedExt(file.relativePath)
        });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }

    for (const key of hashCache.keys()) {
      if (!seen.has(key)) hashCache.delete(key);
    }

    return entries;
  }

  function findDuplicate(entries, hash, excludedPath = '') {
    const excluded = normalizeRelativePath(excludedPath);
    return entries.find(entry => entry.hash === hash && entry.path !== excluded) || null;
  }

  function withLock(task) {
    const run = operationQueue.then(task, task);
    operationQueue = run.catch(() => {});
    return run;
  }

  return {
    audioDir,
    stagingDir,
    isLibraryFile,
    normalizeRelativePath,
    pruneStaging,
    scan,
    findDuplicate,
    withLock
  };
}

module.exports = { createAudioLibrary };
