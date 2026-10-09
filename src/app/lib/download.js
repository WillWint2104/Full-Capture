// Browser-side helpers for handing files to the teacher.

/** Save a Blob through the browser's download flow. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  downloadUrl(url, filename);
  // Give the download a moment to start before releasing the memory.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Download an existing object URL (the caller keeps ownership of it). */
export function downloadUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Read a Blob as a data: URL (used for small thumbnails stored in IndexedDB). */
export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Copy text to the clipboard, falling back to a hidden textarea. Resolves true on success. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

/** A small JPEG data URL of the current frame of a video track, or '' if unavailable. */
export async function captureThumbnail(track, maxWidth = 320) {
  try {
    if (!track || track.readyState !== 'live' || typeof ImageCapture === 'undefined') return '';
    const bmp = await new ImageCapture(track).grabFrame();
    const scale = Math.min(1, maxWidth / bmp.width);
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return await blobToDataUrl(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 }));
  } catch {
    return '';
  }
}
