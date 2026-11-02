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
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatTime } from './utils';

export default function NowPlayingProgress({ np, npRef, npPollRef, onSeek }) {
  const [elapsed, setElapsed] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const seekRef = useRef(null);

  useEffect(() => {
    setElapsed(Number(npRef.current.elapsed) || 0);
  }, [np, npRef]);

  useEffect(() => {
    const tick = window.setInterval(() => {
      const cur = npRef.current;
      if (!cur.song) {
        setElapsed(0);
        return;
      }
      if (cur.paused || !cur.playing) {
        setElapsed(Number(cur.elapsed) || 0);
        return;
      }
      setElapsed(Math.min(
        Number(cur.elapsed) + ((performance.now() - npPollRef.current) / 1000),
        Number(cur.duration) || 0
      ));
    }, 250);
    return () => window.clearInterval(tick);
  }, [npRef, npPollRef]);

  const seekFromClientX = useCallback(async clientX => {
    const cur = npRef.current;
    if (!cur.song || !seekRef.current) return;
    const rect = seekRef.current.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const target = ratio * (Number(cur.duration) || 0);
    setElapsed(target);
    npRef.current = { ...cur, elapsed: target };
    npPollRef.current = performance.now();
    await onSeek(target);
  }, [npRef, npPollRef, onSeek]);

  useEffect(() => {
    if (!seeking) return;
    const onMouseMove = event => { void seekFromClientX(event.clientX); };
    const onMouseUp = () => setSeeking(false);
    const onTouchMove = event => {
      if (event.touches?.[0]) void seekFromClientX(event.touches[0].clientX);
      event.preventDefault();
    };
    const onTouchEnd = () => setSeeking(false);

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, [seeking, seekFromClientX]);

  const duration = Number(np.duration) || 0;
  const progress = duration > 0 ? (elapsed / duration) * 100 : 0;

  return (
    <div className={`np-progress-row${np.song ? ' visible' : ''}`} id="npProgressRow">
      <span className="np-time" id="npElapsed">{formatTime(elapsed)}</span>
      <div
        className={`np-bar-track${seeking ? ' dragging' : ''}`}
        id="npBarTrack"
        ref={seekRef}
        onMouseDown={event => {
          if (!np.song) return;
          setSeeking(true);
          void seekFromClientX(event.clientX);
        }}
        onTouchStart={event => {
          if (!np.song || !event.touches?.[0]) return;
          setSeeking(true);
          void seekFromClientX(event.touches[0].clientX);
          event.preventDefault();
        }}
      >
        <div className="np-bar-fill" id="npBarFill" style={{ transform: `scaleX(${progress / 100})` }} />
        <div className="np-bar-thumb-track" style={{ transform: `translateX(${progress}%)` }}>
          <div className="np-bar-thumb" id="npBarThumb" />
        </div>
      </div>
      <span className="np-time" id="npDuration">{formatTime(duration)}</span>
    </div>
  );
}
