/**
 * urlUtils.js — Shared YouTube URL normalisation utility
 *
 * Extracted from syncService.js and LoadCommand.js to eliminate
 * duplicated normaliseUrl() logic (Design Smell #4 — Type-1 Clone).
 *
 * Converts YouTube watch/short URLs to privacy-enhanced embed URLs.
 */
'use strict';

/**
 * Normalise a raw URL to a YouTube nocookie embed URL.
 *
 * Supported input formats:
 *   - https://youtube.com/watch?v=VIDEO_ID
 *   - https://www.youtube.com/watch?v=VIDEO_ID
 *   - https://youtu.be/VIDEO_ID
 *
 * @param {string} raw  The raw video URL
 * @returns {string|null}  Normalised embed URL, or the original URL if not
 *                          a recognised YouTube format, or null if invalid
 */
function normaliseUrl(raw) {
  try {
    const url = new URL(raw);
    let videoId = url.searchParams.get('v');
    if (!videoId && url.hostname === 'youtu.be') {
      videoId = url.pathname.slice(1);
    }
    if (videoId) {
      return `https://www.youtube-nocookie.com/embed/${videoId}?enablejsapi=1&rel=0`;
    }
    return raw;
  } catch {
    return null;
  }
}

module.exports = { normaliseUrl };
