// Formatting helpers for clocks, sizes and timestamps.

const pad = n => String(n).padStart(2, '0');

/** Recording clock: "04:07" under an hour, "1:04:07" from one hour. */
export function formatClock(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * YouTube-style chapter timestamp: "0:00", "12:05", or "1:02:03".
 * Pass forceHours when the video is an hour or longer so every line has the
 * same shape ("0:00:00").
 */
export function formatTimestamp(ms, forceHours = false) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  return h > 0 || forceHours ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Human duration: "45 s", "12 min 5 s", "1 h 2 min". Rounds down, like the clock and video players. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  if (h > 0) return m ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return s ? `${m} min ${s} s` : `${m} min`;
  return `${s} s`;
}

/** "812 KB", "12.4 MB", "1.82 GB". */
export function formatBytes(bytes) {
  const n = Math.max(0, bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
