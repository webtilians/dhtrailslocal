import test from 'node:test';
import assert from 'node:assert/strict';
import {youtubeLink} from '../youtube.mjs';

test('a YouTube link as copied from the app or the browser gives the video', () => {
  const id = 'dQw4w9WgXcQ';
  for (const link of [`https://www.youtube.com/watch?v=${id}`, `https://youtu.be/${id}`, `youtu.be/${id}?si=abc123`,
    `https://m.youtube.com/watch?feature=share&v=${id}`, `www.youtube.com/embed/${id}`, `https://youtube.com/live/${id}`,
    `  https://www.youtube-nocookie.com/embed/${id}  `])
    assert.equal(youtubeLink(link)?.id, id, link);
  assert.deepEqual(youtubeLink(`https://youtube.com/shorts/${id}`), {id, start: 0, vertical: true});
});

test('the second it starts at comes from t= or start=', () => {
  const id = 'dQw4w9WgXcQ';
  assert.equal(youtubeLink(`https://youtu.be/${id}?t=95`).start, 95);
  assert.equal(youtubeLink(`https://www.youtube.com/watch?v=${id}&t=1m30s`).start, 90);
  assert.equal(youtubeLink(`https://www.youtube.com/watch?v=${id}&t=1h2m3s`).start, 3723);
  assert.equal(youtubeLink(`https://www.youtube.com/embed/${id}?start=42`).start, 42);
  assert.equal(youtubeLink(`https://youtu.be/${id}?t=raro`).start, 0);
});

test('anything else is not a YouTube video', () => {
  for (const text of ['', 'hola', 'https://vimeo.com/123456789', 'https://www.youtube.com/channel/UC1234567890',
    'https://www.youtube.com/watch?v=corto', 'https://evil.example/watch?v=dQw4w9WgXcQ', null])
    assert.equal(youtubeLink(text), null, String(text));
});
