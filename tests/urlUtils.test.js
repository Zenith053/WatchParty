/**
 * tests/urlUtils.test.js
 * Unit tests for the extracted normaliseUrl utility (Design Smell #4 fix)
 */
'use strict';

const { normaliseUrl } = require('../server/urlUtils');

describe('urlUtils — normaliseUrl()', () => {
  test('converts YouTube watch URL to nocookie embed', () => {
    const result = normaliseUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(result).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?enablejsapi=1&rel=0'
    );
  });

  test('converts youtube.com (no www) watch URL', () => {
    const result = normaliseUrl('https://youtube.com/watch?v=abc123');
    expect(result).toBe(
      'https://www.youtube-nocookie.com/embed/abc123?enablejsapi=1&rel=0'
    );
  });

  test('converts youtu.be short URL', () => {
    const result = normaliseUrl('https://youtu.be/xyz789');
    expect(result).toBe(
      'https://www.youtube-nocookie.com/embed/xyz789?enablejsapi=1&rel=0'
    );
  });

  test('preserves extra query params in source but strips them in output', () => {
    const result = normaliseUrl('https://www.youtube.com/watch?v=test1&t=120');
    expect(result).toBe(
      'https://www.youtube-nocookie.com/embed/test1?enablejsapi=1&rel=0'
    );
  });

  test('passes through non-YouTube URLs unchanged', () => {
    const result = normaliseUrl('https://vimeo.com/12345');
    expect(result).toBe('https://vimeo.com/12345');
  });

  test('passes through already-embed YouTube URLs unchanged', () => {
    const result = normaliseUrl('https://www.youtube-nocookie.com/embed/abc?enablejsapi=1&rel=0');
    expect(result).toBe('https://www.youtube-nocookie.com/embed/abc?enablejsapi=1&rel=0');
  });

  test('returns null for invalid URL', () => {
    expect(normaliseUrl('not-a-url')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(normaliseUrl('')).toBeNull();
  });

  test('handles YouTube URL with no video ID param', () => {
    const result = normaliseUrl('https://www.youtube.com/channel/UCxyz');
    expect(result).toBe('https://www.youtube.com/channel/UCxyz');
  });
});
