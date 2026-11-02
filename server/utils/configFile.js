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
const YAML = require('yaml');
const TOML = require('@iarna/toml');
const { writeFileAtomically } = require('./atomicFile');

const DEFAULT_CONFIG_FILENAMES = [
  'bardboard.config.yaml',
  'bardboard.config.yml',
  'bardboard.config.json',
  'bardboard.config.toml'
];

function getExplicitConfigPath() {
  const explicitPath = String(process.env.BARDBOARD_CONFIG_PATH || '').trim();
  return explicitPath ? path.resolve(explicitPath) : '';
}

function findDefaultConfigPath(cwd = process.cwd()) {
  for (const directory of [cwd, path.join(cwd, 'config')]) {
    for (const fileName of DEFAULT_CONFIG_FILENAMES) {
      const candidate = path.join(directory, fileName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return '';
}

function getConfigFilePath(options = {}) {
  if (options.explicitOnly) return getExplicitConfigPath();
  return getExplicitConfigPath() || findDefaultConfigPath(options.cwd);
}

function detectConfigFormat(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.yaml' || extension === '.yml') return 'yaml';
  if (extension === '.json') return 'json';
  if (extension === '.toml') return 'toml';
  throw new Error(`Unsupported configuration format for ${filePath}. Use .yaml, .yml, .json, or .toml.`);
}

function normalizeConfigValue(key, value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    if (key === 'CORS_ORIGINS') return value.map(item => String(item)).join(',');
    throw new Error(`Configuration value for ${key} must be a scalar.`);
  }
  if (typeof value === 'object') {
    throw new Error(`Configuration value for ${key} must be a scalar.`);
  }
  return String(value);
}

function normalizeConfigValues(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('Configuration file must contain a top-level object.');
  }
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, normalizeConfigValue(key, value)])
  );
}

function parseConfig(text, format) {
  if (format === 'yaml') return YAML.parse(text);
  if (format === 'json') return JSON.parse(text);
  if (format === 'toml') return TOML.parse(text);
  throw new Error(`Unsupported configuration format: ${format}`);
}

function serializeConfig(values, format) {
  if (format === 'yaml') return YAML.stringify(values);
  if (format === 'json') return `${JSON.stringify(values, null, 2)}\n`;
  if (format === 'toml') return TOML.stringify(values);
  throw new Error(`Unsupported configuration format: ${format}`);
}

function readConfigFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  const format = detectConfigFormat(filePath);
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text.trim()) return {};
  return normalizeConfigValues(parseConfig(text, format));
}

function writeConfigFile(filePath, updatedValues, options = {}) {
  const fsImpl = options.fs || fs;
  const format = detectConfigFormat(filePath);
  let existing = {};
  if (fsImpl.existsSync(filePath)) {
    const text = fsImpl.readFileSync(filePath, 'utf8');
    if (text.trim()) existing = normalizeConfigValues(parseConfig(text, format));
  }
  const next = { ...existing, ...normalizeConfigValues(updatedValues) };
  writeFileAtomically(filePath, serializeConfig(next, format), fsImpl);
}

module.exports = {
  DEFAULT_CONFIG_FILENAMES,
  detectConfigFormat,
  findDefaultConfigPath,
  getConfigFilePath,
  normalizeConfigValues,
  parseConfig,
  readConfigFile,
  serializeConfig,
  writeConfigFile
};
