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
const path = require('path');

const AUDIO_DIR = path.join(__dirname, '..', 'audio-files');
const ALLOWED_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a']);
const PLAYABLE_EXT = new Set([
  ...ALLOWED_EXT,
  '.aac', '.ac3', '.aif', '.aifc', '.aiff', '.alac', '.amr', '.ape', '.au',
  '.caf', '.dff', '.dsf', '.dts', '.flac', '.m4b', '.m4p', '.m4r', '.mka',
  '.mp2', '.mp4', '.mpa', '.mpga', '.oga', '.ogg', '.ogx', '.opus', '.spx',
  '.tta', '.voc', '.wav', '.webm', '.wma', '.wv'
]);
const STAGING_DIR_NAME = '.bardboard-staging';

module.exports = {
  AUDIO_DIR,
  ALLOWED_EXT,
  PLAYABLE_EXT,
  STAGING_DIR_NAME
};
