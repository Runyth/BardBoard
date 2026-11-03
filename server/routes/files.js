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
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { createUpload } = require('../middleware/upload');
const { createAudioLibrary } = require('../services/audioLibrary');
const { hashAudioFile } = require('../utils/audioHash');
const { AUDIO_DIR } = require('../constants');
const { sanitizeCategory, resolveAudioPathFrom, hasPlayableExt } = require('../utils/path');

function createFileRoutes(audioService, options = {}) {
  const router = express.Router();
  const audioDir = path.resolve(options.audioDir || AUDIO_DIR);
  const fsImpl = options.fs || fs;
  const library = options.audioLibrary || createAudioLibrary({ audioDir, fs: fsImpl });
  const uploadMiddleware = options.upload || createUpload({ audioDir, fs: fsImpl, stagingDir: library.stagingDir });
  const resolveAudioPath = relativePath => resolveAudioPathFrom(audioDir, relativePath);
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number.parseInt(process.env.RATE_LIMIT_FILES || '60', 10),
    standardHeaders: 'draft-7',
    legacyHeaders: false
  });

  const normalizeRelativePath = value => String(value || '').replace(/\\/g, '/');

  function discardStaged(stagingPath) {
    if (!stagingPath) return;
    try {
      fsImpl.unlinkSync(stagingPath);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Could not remove staged upload:', error.message);
    }
  }

  function commitStaged(stagingPath, targetPath) {
    fsImpl.mkdirSync(path.dirname(targetPath), { recursive: true });
    try {
      fsImpl.linkSync(stagingPath, targetPath);
      fsImpl.unlinkSync(stagingPath);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      fsImpl.copyFileSync(stagingPath, targetPath, fs.constants.COPYFILE_EXCL);
      fsImpl.unlinkSync(stagingPath);
    }
  }

  function finalizeUpload(file, category, entries) {
    const targetRelPath = category ? `${category}/${file.filename}` : file.filename;
    const targetPath = resolveAudioPath(targetRelPath);
    if (!targetPath) return { error: 'Invalid target path' };

    const existingTarget = entries.find(entry => entry.path === targetRelPath);
    if (existingTarget && existingTarget.hash !== file.hash) {
      return { error: 'A file with the same name already exists' };
    }
    if (fsImpl.existsSync(targetPath) && !existingTarget) {
      return { error: 'A file with the same name already exists' };
    }

    const duplicate = existingTarget || library.findDuplicate(entries, file.hash);
    if (duplicate) {
      return {
        duplicate: {
          token: path.basename(file.stagingPath),
          fileName: file.filename,
          category,
          existingPath: duplicate.path,
          size: file.size,
          hash: file.hash,
          index: file.index
        }
      };
    }

    try {
      commitStaged(file.stagingPath, targetPath);
      return { uploaded: { index: file.index, fileName: file.filename, path: targetRelPath } };
    } catch (error) {
      if (error.code === 'EEXIST') return { error: 'A file with the same name already exists' };
      console.error('Could not finalize upload:', error);
      return { error: 'Upload failed' };
    }
  }

  function replaceStagedUpload(stagingPath, existingPath, targetPath) {
    if (existingPath === targetPath) {
      fsImpl.renameSync(stagingPath, targetPath);
      return;
    }

    if (fsImpl.existsSync(targetPath)) {
      throw Object.assign(new Error('A file with the same name already exists'), { code: 'EEXIST' });
    }

    const backupPath = `${stagingPath}.backup`;
    let backedUp = false;
    let removedExisting = false;

    try {
      fsImpl.linkSync(existingPath, backupPath);
      backedUp = true;
      fsImpl.unlinkSync(existingPath);
      removedExisting = true;
      commitStaged(stagingPath, targetPath);
    } catch (error) {
      if (removedExisting) {
        try {
          fsImpl.linkSync(backupPath, existingPath);
        } catch (restoreError) {
          console.error('Could not restore replaced track:', restoreError);
        }
      }
      throw error;
    } finally {
      if (backedUp) {
        try {
          fsImpl.unlinkSync(backupPath);
        } catch (error) {
          if (error.code !== 'ENOENT') console.warn('Could not remove replacement backup:', error.message);
        }
      }
    }
  }

  function resolveStagedPath(token) {
    const raw = String(token || '');
    if (!raw || raw !== path.basename(raw) || raw.includes('..')) return null;
    const stagingRoot = path.resolve(library.stagingDir);
    const stagedPath = path.resolve(stagingRoot, raw);
    if (!stagedPath.startsWith(stagingRoot + path.sep)) return null;
    return stagedPath;
  }

  /**
   * Handles the `/audio-files` API endpoint to return a list of audio files
   * from the `audio-files` directory.
   *
   * @route GET /audio-files
   * @returns {string[]} A list of audio file names.
   */
  router.get('/audio-files', limiter, (req, res) => {
    const baseDir = audioDir;

    let entries = [];
    try {
      entries = fsImpl.readdirSync(baseDir, { withFileTypes: true });
    } catch (e) {
      console.error('Could not read audio-files directory:', e);
      return res.json({ root: [], categories: {} });
    }

    const response = { root: [], categories: {} };

    entries.forEach(entry => {
      if (entry.name.startsWith('.')) return;
      if (entry.isFile() && hasPlayableExt(entry.name)) {
        response.root.push(entry.name);
      } else if (entry.isDirectory()) {
        const subDirPath = path.join(baseDir, entry.name);
        try {
          const subFiles = fsImpl.readdirSync(subDirPath)
            .filter(f => hasPlayableExt(f))
            .map(f => `${entry.name}/${f}`);
          response.categories[entry.name] = subFiles;
        } catch (err) {
          console.error(`Error reading subdir ${entry.name}:`, err);
        }
      }
    });

    res.json(response);
  });

  router.get('/audio-library', limiter, async (_req, res) => {
    try {
      const files = await library.scan();
      return res.json({ files });
    } catch (error) {
      console.error('Could not scan audio library:', error);
      return res.status(500).json({ error: 'Could not scan audio library' });
    }
  });

  router.post('/audio-library/add', limiter, async (req, res) => {
    const rawPaths = Array.isArray(req.body?.paths) ? req.body.paths : [];
    const rawCategories = Array.isArray(req.body?.categories) ? req.body.categories : [];
    if (!rawPaths.length || !rawCategories.length) {
      return res.status(400).json({ error: 'Select at least one track and category' });
    }
    if (rawPaths.length * rawCategories.length > 2000) {
      return res.status(400).json({ error: 'Too many track and category combinations' });
    }

    const sourcePaths = [...new Set(rawPaths.map(normalizeRelativePath))];
    const categories = [...new Set(rawCategories.map(value => String(value || '').trim()))];
    for (const sourcePath of sourcePaths) {
      if (!sourcePath || sourcePath.includes('..') || sourcePath.startsWith('/')) {
        return res.status(400).json({ error: 'Invalid track path' });
      }
    }
    for (const category of categories) {
      if (!category || sanitizeCategory(category) !== category) {
        return res.status(400).json({ error: 'Invalid category' });
      }
      const categoryPath = resolveAudioPath(category);
      if (!categoryPath || !fsImpl.existsSync(categoryPath) || !fsImpl.statSync(categoryPath).isDirectory()) {
        return res.status(404).json({ error: `Category not found: ${category}` });
      }
    }

    try {
      return await library.withLock(async () => {
        const entries = await library.scan();
        const entryMap = new Map(entries.map(entry => [entry.path, entry]));
        const missing = sourcePaths.filter(sourcePath => !entryMap.has(sourcePath));
        if (missing.length) {
          return res.status(404).json({ error: `Track not found: ${missing[0]}` });
        }

        const added = [];
        const skipped = [];
        const operations = [];
        const categoryHashes = new Map(categories.map(category => [
          category,
          new Set(entries
            .filter(entry => entry.path.startsWith(`${category}/`) && !entry.path.slice(category.length + 1).includes('/'))
            .map(entry => entry.hash))
        ]));

        for (const sourcePath of sourcePaths) {
          const sourceEntry = entryMap.get(sourcePath);
          const sourceFullPath = resolveAudioPath(sourcePath);
          let sourceStat;
          try {
            sourceStat = fsImpl.statSync(sourceFullPath);
          } catch {
            return res.status(404).json({ error: `Track not found: ${sourcePath}` });
          }

          for (const category of categories) {
            const targetRelPath = `${category}/${path.basename(sourcePath)}`;
            const targetFullPath = resolveAudioPath(targetRelPath);
            if (sourcePath === targetRelPath) {
              skipped.push({ source: sourcePath, category, reason: 'already-in-category' });
              continue;
            }
            if (fsImpl.existsSync(targetFullPath)) {
              const targetEntry = entryMap.get(targetRelPath);
              try {
                const targetStat = fsImpl.statSync(targetFullPath);
                const sameInode = sourceStat.ino !== 0
                  && targetStat.ino !== 0
                  && sourceStat.dev === targetStat.dev
                  && sourceStat.ino === targetStat.ino;
                if (sameInode) {
                  skipped.push({ source: sourcePath, category, reason: 'already-linked' });
                  continue;
                }
              } catch {
                skipped.push({ source: sourcePath, category, reason: 'name-conflict' });
                continue;
              }
              if (targetEntry && targetEntry.hash === sourceEntry.hash) {
                skipped.push({ source: sourcePath, category, reason: 'duplicate-content' });
              } else {
                skipped.push({ source: sourcePath, category, reason: 'name-conflict' });
              }
              continue;
            }
            if (categoryHashes.get(category)?.has(sourceEntry.hash)) {
              skipped.push({ source: sourcePath, category, reason: 'duplicate-content' });
              continue;
            }
            operations.push({ sourcePath, category, targetRelPath, targetFullPath });
          }
        }

        const created = [];
        try {
          for (const operation of operations) {
            fsImpl.linkSync(resolveAudioPath(operation.sourcePath), operation.targetFullPath);
            created.push(operation);
            added.push({
              source: operation.sourcePath,
              category: operation.category,
              path: operation.targetRelPath
            });
          }
        } catch (error) {
          created.forEach(operation => {
            try {
              fsImpl.unlinkSync(operation.targetFullPath);
            } catch (cleanupError) {
              if (cleanupError.code !== 'ENOENT') {
                console.warn('Could not roll back track reference:', cleanupError.message);
              }
            }
          });
          added.length = 0;
          const reason = error.code === 'EXDEV'
            ? 'Cannot link tracks across filesystems'
            : 'Could not add track reference';
          console.error('Could not add library tracks:', error);
          return res.status(500).json({ ok: false, error: reason });
        }

        return res.json({ ok: true, added, skipped });
      });
    } catch (error) {
      console.error('Could not add library tracks:', error);
      return res.status(500).json({ error: 'Could not add library tracks' });
    }
  });

  /**
   * Handles the `/upload-audio` API endpoint to upload a new audio file.
   *
   * @route POST /upload-audio
   * @query {string} category - Optional category folder name.
   */
  router.post('/upload-audio', limiter, (req, res) => {
    uploadMiddleware.single('file')(req, res, async err => {
      if (err) {
        if (['EACCES', 'EIO', 'ENOSPC', 'EROFS'].includes(err.code)) {
          console.error('Upload failed:', err);
          return res.status(500).json({ error: 'Upload failed' });
        }
        return res.status(400).json({ error: err.message });
      }
      if (!req.file) return res.status(400).json({ error: 'Missing file' });

      const input = String(req.query.category || '').trim();
      const category = sanitizeCategory(input);
      if (input && category !== input) {
        discardStaged(req.file.stagingPath);
        return res.status(400).json({ error: 'Invalid category' });
      }

      try {
        const result = await library.withLock(async () => {
          const entries = await library.scan();
          return finalizeUpload(req.file, category, entries);
        });

        if (result.duplicate) {
          return res.status(409).json({ error: 'Duplicate audio file', duplicate: result.duplicate });
        }
        if (result.error) {
          discardStaged(req.file.stagingPath);
          const status = result.error === 'Upload failed' ? 500 : 400;
          return res.status(status).json({ error: result.error });
        }
        return res.json({ ok: true, file: req.file.filename });
      } catch (error) {
        discardStaged(req.file.stagingPath);
        console.error('Upload failed:', error);
        return res.status(500).json({ error: 'Upload failed' });
      }
    });
  });

  /**
   * Handles the `/upload-audio-batch` API endpoint to upload many files in one request.
   *
   * @route POST /upload-audio-batch
   * @query {string} category - Optional category folder name.
   */
  router.post('/upload-audio-batch', limiter, (req, res) => {
    const input = String(req.query.category || '').trim();
    const category = sanitizeCategory(input);
    if (input && category !== input) return res.status(400).json({ error: 'Invalid category' });

    req.uploadFailures = [];
    req._batchIndex = 0;

    uploadMiddleware.array('files')(req, res, async err => {
      if (err) {
        if (['EACCES', 'EIO', 'ENOSPC', 'EROFS'].includes(err.code)) {
          console.error('Batch upload failed:', err);
          return res.status(500).json({ error: 'Upload failed' });
        }
        return res.status(400).json({ error: err.message });
      }

      const files = (Array.isArray(req.files) ? req.files : []).filter(file => !file.skipped);
      req.uploadFailures = Array.isArray(req.uploadFailures) ? req.uploadFailures : [];

      try {
        const result = await library.withLock(async () => {
          const entries = await library.scan();
          const uploaded = [];
          const duplicates = [];
          const failed = req.uploadFailures.slice();

          for (const file of files) {
            const finalized = finalizeUpload(file, category, entries);
            if (finalized.uploaded) {
              uploaded.push(finalized.uploaded);
              entries.push({ path: finalized.uploaded.path, hash: file.hash });
            } else if (finalized.duplicate) {
              duplicates.push(finalized.duplicate);
            } else {
              discardStaged(file.stagingPath);
              failed.push({
                index: file.index,
                fileName: file.filename,
                error: finalized.error || 'Upload failed'
              });
            }
          }

          return { uploaded, duplicates, failed };
        });

        const failed = result.failed.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        const duplicates = result.duplicates.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        return res.json({
          ok: failed.length === 0 && duplicates.length === 0,
          uploaded: result.uploaded,
          duplicates,
          failed
        });
      } catch (error) {
        files.forEach(file => discardStaged(file.stagingPath));
        console.error('Batch upload failed:', error);
        return res.status(500).json({ error: 'Upload failed' });
      }
    });
  });

  router.post('/upload-audio-resolve', limiter, async (req, res) => {
    const resolutions = Array.isArray(req.body?.resolutions) ? req.body.resolutions : null;
    if (!resolutions || resolutions.length === 0) {
      return res.status(400).json({ error: 'No upload resolutions provided' });
    }
    if (resolutions.length > 2000) {
      return res.status(400).json({ error: 'Too many upload resolutions' });
    }

    const result = { replaced: [], discarded: [], failed: [] };

    try {
      await library.withLock(async () => {
        for (const item of resolutions) {
          const token = String(item?.token || '');
          const action = String(item?.action || '');
          const stagedPath = resolveStagedPath(token);

          if (!stagedPath || !fsImpl.existsSync(stagedPath)) {
            result.failed.push({ token, error: 'Upload is no longer available' });
            continue;
          }

          if (action === 'discard') {
            try {
              fsImpl.unlinkSync(stagedPath);
              result.discarded.push({ token });
            } catch (error) {
              console.error('Could not discard staged upload:', error);
              result.failed.push({ token, error: 'Could not discard upload' });
            }
            continue;
          }

          if (action !== 'replace') {
            result.failed.push({ token, error: 'Invalid resolution action' });
            continue;
          }

          const categoryInput = String(item?.category || '').trim();
          const category = sanitizeCategory(categoryInput);
          const fileName = String(item?.fileName || '');
          const existingPath = normalizeRelativePath(item?.existingPath);
          if (categoryInput && category !== categoryInput) {
            result.failed.push({ token, error: 'Invalid category' });
            continue;
          }
          if (!fileName || path.basename(fileName) !== fileName || !hasPlayableExt(fileName)) {
            result.failed.push({ token, error: 'Invalid file name' });
            continue;
          }
          if (!existingPath || existingPath.includes('..') || existingPath.startsWith('/')) {
            result.failed.push({ token, error: 'Invalid existing path' });
            continue;
          }

          const targetRelPath = category ? `${category}/${fileName}` : fileName;
          const targetPath = resolveAudioPath(targetRelPath);
          const existingFullPath = resolveAudioPath(existingPath);
          if (!targetPath || !existingFullPath) {
            result.failed.push({ token, error: 'Invalid path' });
            continue;
          }
          if (!fsImpl.existsSync(existingFullPath)) {
            result.failed.push({ token, error: 'Existing track not found' });
            continue;
          }
          if (audioService && typeof audioService.isFileInUse === 'function' && audioService.isFileInUse(existingPath)) {
            result.failed.push({ token, error: 'Existing track is currently in use' });
            continue;
          }

          try {
            const [stagedHash, existingHash] = await Promise.all([
              hashAudioFile(stagedPath, fsImpl),
              hashAudioFile(existingFullPath, fsImpl)
            ]);
            if (stagedHash !== existingHash) {
              result.failed.push({ token, error: 'Duplicate match changed; review the upload again' });
              continue;
            }

            replaceStagedUpload(stagedPath, existingFullPath, targetPath);
            result.replaced.push({ token, existingPath, path: targetRelPath });
          } catch (error) {
            if (error.code === 'EEXIST') {
              result.failed.push({ token, error: 'A file with the same name already exists' });
            } else {
              console.error('Could not replace duplicate upload:', error);
              result.failed.push({ token, error: 'Could not replace existing track' });
            }
          }
        }
      });

      return res.json({
        ok: result.failed.length === 0,
        ...result
      });
    } catch (error) {
      console.error('Could not resolve upload duplicates:', error);
      return res.status(500).json({ error: 'Could not resolve uploads' });
    }
  });

  /**
   * Handles the `/audio-file` API endpoint to delete a specific audio file.
   *
   * @route DELETE /audio-file
   * @query {string} path - Relative path like "Folder/File.mp3" or "File.mp3".
   */
  router.delete('/audio-file', limiter, (req, res) => {
    const relPath = (req.query.path || '').toString().replace(/\\/g, '/');
    if (!relPath || relPath.includes('..') || relPath.startsWith('/')) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    if (audioService && typeof audioService.isFileInUse === 'function' && audioService.isFileInUse(relPath)) {
      return res.status(409).json({ error: 'File is currently in use' });
    }
    const fullPath = resolveAudioPath(relPath);
    if (!fullPath) return res.status(400).json({ error: 'Invalid path' });

    try {
      const stat = fsImpl.statSync(fullPath);
      if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
      if (!hasPlayableExt(fullPath)) return res.status(400).json({ error: 'Invalid file type' });
      fsImpl.unlinkSync(fullPath);
      return res.json({ ok: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
      if (err && (err.code === 'EPERM' || err.code === 'EBUSY')) {
        return res.status(409).json({ error: 'File is currently in use' });
      }
      console.error('Delete file failed:', err);
      return res.status(500).json({ error: 'Delete failed' });
    }
  });

  /**
   * Handles the `/audio-file/move` API endpoint to move an audio file
   * to another category (or root folder).
   *
   * @route POST /audio-file/move
   * @body {string} path - Relative source path like "Folder/File.mp3" or "File.mp3".
   * @body {string} [targetCategory] - Target category folder name, empty string for root.
   */
  router.post('/audio-file/move', limiter, (req, res) => {
    const rawPath = (req.body?.path || '').toString();
    const sourceRelPath = rawPath.replace(/\\/g, '/');
    if (!sourceRelPath || sourceRelPath.includes('..') || sourceRelPath.startsWith('/')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    if (!hasPlayableExt(sourceRelPath)) {
      return res.status(400).json({ error: 'Invalid file type' });
    }

    if (audioService && typeof audioService.isFileInUse === 'function' && audioService.isFileInUse(sourceRelPath)) {
      return res.status(409).json({ error: 'File is currently in use' });
    }

    const rawTargetCategory = req.body?.targetCategory;
    const targetCategoryInput = rawTargetCategory == null ? '' : rawTargetCategory.toString();
    const targetCategory = sanitizeCategory(targetCategoryInput);
    const createCategory = Boolean(req.body?.createCategory);
    if (targetCategoryInput.trim() && targetCategory !== targetCategoryInput.trim()) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    const sourceFullPath = resolveAudioPath(sourceRelPath);
    if (!sourceFullPath) return res.status(400).json({ error: 'Invalid path' });

    const targetDirPath = targetCategory ? resolveAudioPath(targetCategory) : audioDir;
    if (!targetDirPath) return res.status(400).json({ error: 'Invalid category' });

    const targetFileName = path.basename(sourceRelPath);
    const targetRelPath = targetCategory ? `${targetCategory}/${targetFileName}` : targetFileName;
    const targetFullPath = resolveAudioPath(targetRelPath);
    if (!targetFullPath) return res.status(400).json({ error: 'Invalid target path' });

    if (sourceFullPath === targetFullPath) {
      if (!fsImpl.existsSync(sourceFullPath)) return res.status(404).json({ error: 'File not found' });
      return res.json({ ok: true, from: sourceRelPath, to: targetRelPath, changed: false });
    }

    try {
      const sourceStat = fsImpl.statSync(sourceFullPath);
      if (!sourceStat.isFile()) return res.status(400).json({ error: 'Not a file' });

      let createdTargetCategory = false;
      if (targetCategory && createCategory && !fsImpl.existsSync(targetDirPath)) {
        fsImpl.mkdirSync(targetDirPath, { recursive: false });
        createdTargetCategory = true;
      }

      const targetDirStat = fsImpl.statSync(targetDirPath);
      if (!targetDirStat.isDirectory()) return res.status(400).json({ error: 'Not a category' });

      if (fsImpl.existsSync(targetFullPath)) {
        return res.status(409).json({ error: 'A file with the same name already exists in target category' });
      }

      try {
        fsImpl.renameSync(sourceFullPath, targetFullPath);
      } catch (error) {
        if (createdTargetCategory) {
          try {
            fsImpl.rmdirSync(targetDirPath);
          } catch (cleanupError) {
            if (cleanupError.code !== 'ENOENT' && cleanupError.code !== 'ENOTEMPTY') {
              console.warn('Could not roll back target category:', cleanupError.message);
            }
          }
        }
        throw error;
      }
      return res.json({ ok: true, from: sourceRelPath, to: targetRelPath, changed: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return res.status(404).json({ error: 'File or category not found' });
      if (err && (err.code === 'EPERM' || err.code === 'EBUSY')) {
        return res.status(409).json({ error: 'File is currently in use' });
      }
      console.error('Move file failed:', err);
      return res.status(500).json({ error: 'Move failed' });
    }
  });

  /**
   * Handles the `/audio-file/rename` API endpoint to rename a file inside
   * its current folder/category.
   *
   * @route POST /audio-file/rename
   * @body {string} path - Relative source path like "Folder/File.mp3" or "File.mp3".
   * @body {string} newName - New base name without extension.
   */
  router.post('/audio-file/rename', limiter, (req, res) => {
    const rawPath = (req.body?.path || '').toString();
    const sourceRelPath = rawPath.replace(/\\/g, '/');
    if (!sourceRelPath || sourceRelPath.includes('..') || sourceRelPath.startsWith('/')) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    if (!hasPlayableExt(sourceRelPath)) {
      return res.status(400).json({ error: 'Invalid file type' });
    }
    if (audioService && typeof audioService.isFileInUse === 'function' && audioService.isFileInUse(sourceRelPath)) {
      return res.status(409).json({ error: 'File is currently in use' });
    }

    const rawNewName = (req.body?.newName || '').toString();
    const trimmedNewName = rawNewName.trim();
    const sanitizedNewName = sanitizeCategory(trimmedNewName);
    if (!trimmedNewName || !sanitizedNewName || sanitizedNewName !== trimmedNewName) {
      return res.status(400).json({ error: 'Invalid file name' });
    }

    const sourceFullPath = resolveAudioPath(sourceRelPath);
    if (!sourceFullPath) return res.status(400).json({ error: 'Invalid path' });

    const sourceDir = path.posix.dirname(sourceRelPath);
    const ext = path.extname(sourceRelPath);
    const targetFileName = `${sanitizedNewName}${ext}`;
    const targetRelPath = sourceDir === '.' ? targetFileName : `${sourceDir}/${targetFileName}`;
    const targetFullPath = resolveAudioPath(targetRelPath);
    if (!targetFullPath) return res.status(400).json({ error: 'Invalid target path' });
    if (sourceFullPath === targetFullPath) {
      if (!fsImpl.existsSync(sourceFullPath)) return res.status(404).json({ error: 'File not found' });
      return res.json({ ok: true, from: sourceRelPath, to: targetRelPath, changed: false });
    }

    try {
      const sourceStat = fsImpl.statSync(sourceFullPath);
      if (!sourceStat.isFile()) return res.status(400).json({ error: 'Not a file' });

      if (fsImpl.existsSync(targetFullPath)) {
        return res.status(409).json({ error: 'A file with the same name already exists' });
      }

      fsImpl.renameSync(sourceFullPath, targetFullPath);
      return res.json({ ok: true, from: sourceRelPath, to: targetRelPath, changed: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
      if (err && (err.code === 'EPERM' || err.code === 'EBUSY')) {
        return res.status(409).json({ error: 'File is currently in use' });
      }
      console.error('Rename file failed:', err);
      return res.status(500).json({ error: 'Rename failed' });
    }
  });

  /**
   * Handles the `/audio-category` API endpoint to create a category folder.
   *
   * @route POST /audio-category
   * @body {string} name - Category folder name.
   */
  router.post('/audio-category', limiter, (req, res) => {
    const rawName = req.body?.name;
    const input = rawName == null ? '' : rawName.toString();
    const name = sanitizeCategory(input);
    if (!name || !input.trim()) return res.status(400).json({ error: 'Invalid category' });
    if (name !== input.trim()) return res.status(400).json({ error: 'Invalid category' });

    const dirPath = resolveAudioPath(name);
    if (!dirPath || dirPath === audioDir) return res.status(400).json({ error: 'Invalid category' });
    if (fsImpl.existsSync(dirPath)) return res.status(409).json({ error: 'Category already exists' });

    try {
      fsImpl.mkdirSync(dirPath, { recursive: false });
      return res.json({ ok: true, name });
    } catch (err) {
      if (err && err.code === 'EEXIST') return res.status(409).json({ error: 'Category already exists' });
      console.error('Create category failed:', err);
      return res.status(500).json({ error: 'Create category failed' });
    }
  });

  /**
   * Handles the `/audio-category` API endpoint to delete an entire category.
   *
   * @route DELETE /audio-category
   * @query {string} name - Category folder name.
   */
  router.delete('/audio-category', limiter, (req, res) => {
    const input = String(req.query.name || '').trim();
    const name = sanitizeCategory(input);
    if (!name || name !== input) return res.status(400).json({ error: 'Invalid category' });
    if (audioService && typeof audioService.isCategoryInUse === 'function' && audioService.isCategoryInUse(name)) {
      return res.status(409).json({ error: 'Category contains file(s) currently in use' });
    }
    const dirPath = resolveAudioPath(name);
    if (!dirPath || dirPath === audioDir) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    try {
      const stat = fsImpl.statSync(dirPath);
      if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a category' });
      fsImpl.rmSync(dirPath, { recursive: true, force: true });
      return res.json({ ok: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return res.status(404).json({ error: 'Category not found' });
      if (err && (err.code === 'EPERM' || err.code === 'EBUSY')) {
        return res.status(409).json({ error: 'Category contains file(s) currently in use' });
      }
      console.error('Delete category failed:', err);
      return res.status(500).json({ error: 'Delete failed' });
    }
  });

  /**
   * Handles the `/audio-category/rename` API endpoint to rename a category folder.
   *
   * @route POST /audio-category/rename
   * @body {string} name - Current category name.
   * @body {string} newName - New category name.
   */
  router.post('/audio-category/rename', limiter, (req, res) => {
    const rawName = (req.body?.name || '').toString();
    const rawNewName = (req.body?.newName || '').toString();
    const sourceName = sanitizeCategory(rawName.trim());
    const targetName = sanitizeCategory(rawNewName.trim());
    if (!sourceName || sourceName !== rawName.trim()) return res.status(400).json({ error: 'Invalid category' });
    if (!targetName || targetName !== rawNewName.trim()) return res.status(400).json({ error: 'Invalid target category' });
    if (sourceName === targetName) {
      const sourcePath = resolveAudioPath(sourceName);
      if (!sourcePath || !fsImpl.existsSync(sourcePath)) return res.status(404).json({ error: 'Category not found' });
      return res.json({ ok: true, from: sourceName, to: targetName, changed: false });
    }

    if (audioService && typeof audioService.isCategoryInUse === 'function' && audioService.isCategoryInUse(sourceName)) {
      return res.status(409).json({ error: 'Category contains file(s) currently in use' });
    }

    const sourceDirPath = resolveAudioPath(sourceName);
    const targetDirPath = resolveAudioPath(targetName);
    if (!sourceDirPath || sourceDirPath === audioDir) return res.status(400).json({ error: 'Invalid category' });
    if (!targetDirPath || targetDirPath === audioDir) return res.status(400).json({ error: 'Invalid target category' });

    try {
      const sourceStat = fsImpl.statSync(sourceDirPath);
      if (!sourceStat.isDirectory()) return res.status(400).json({ error: 'Not a category' });

      if (fsImpl.existsSync(targetDirPath)) {
        return res.status(409).json({ error: 'Category already exists' });
      }

      fsImpl.renameSync(sourceDirPath, targetDirPath);
      return res.json({ ok: true, from: sourceName, to: targetName, changed: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return res.status(404).json({ error: 'Category not found' });
      if (err && (err.code === 'EPERM' || err.code === 'EBUSY')) {
        return res.status(409).json({ error: 'Category contains file(s) currently in use' });
      }
      console.error('Rename category failed:', err);
      return res.status(500).json({ error: 'Rename failed' });
    }
  });

  return router;
}

module.exports = createFileRoutes;
