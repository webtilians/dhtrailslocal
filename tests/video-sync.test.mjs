import test from 'node:test';
import assert from 'node:assert/strict';
import {distanceSeries} from '../gps-engine.mjs';
import {videoTrack, timeAt} from '../telemetry.mjs';

// A straight 600 m circuit going south, a point every 20 m.
const points = Array.from({length: 31}, (_, i) => [36.74 - i * 20 / 111195, -4.45, 400 - i]);
const distances = distanceSeries(points);
// The watch's run: 60 s at 10 m/s, a fix a second.
const watch = Array.from({length: 61}, (_, i) => [i * 10, i * 1000, points[0][0] - i * 10 / 111195, -4.45]);
// The camera: ten fixes a second; the run starts at second 30 of the video, but the watch's clock says 26.
const camera = (shift, {wobble = 0, dop = 1.5, from = -5, to = 65, gap = null} = {}) => {
  const out = [];
  for (let k = from * 10; k <= to * 10; k++) {
    const second = k / 10, metres = Math.max(0, Math.min(600, second * 10)) + wobble * Math.sin(k);
    if (gap && second > gap[0] && second < gap[1]) continue;
    out.push({t: 26 + shift + second, lat: points[0][0] - metres / 111195, lon: -4.45 + (second < 0 || second > 60 ? 0.0002 : 0), dop, fix: 3});
  }
  return out;
};

test('the camera says where the frames are: the run moves to its clock', () => {
  const sync = videoTrack(camera(4), 26, watch, points, distances);
  assert.ok(Math.abs(sync.shift - 4) < 0.05, String(sync.shift));
  assert.ok(sync.share > 0.9);
  // On the video's clock the run starts at 0 and reaches 300 m 30 s later, as the camera saw.
  assert.equal(sync.profile[0][1], 0);
  assert.ok(Math.abs(timeAt(sync.profile, 300) - 30000) < 60);
  assert.ok(Math.abs(sync.profile.at(-1)[1] - 60000) < 120);
});

test('where the camera saw nothing, the run moved by the camera\'s usual difference', () => {
  const sync = videoTrack(camera(4, {wobble: 1.5, gap: [20, 35]}), 26, watch, points, distances);
  assert.ok(Math.abs(sync.shift - 4) < 0.2);
  assert.ok(Math.abs(timeAt(sync.profile, 270) - 27000) < 250, String(timeAt(sync.profile, 270)));
  // Never back in time.
  assert.ok(sync.profile.every((p, i) => !i || p[1] > sync.profile[i - 1][1]));
});

test('a camera whose GPS cannot be trusted tells nothing', () => {
  assert.equal(videoTrack(camera(4, {dop: 9}), 26, watch, points, distances), null);
  assert.equal(videoTrack(camera(4, {from: 50, to: 65}), 26, watch, points, distances), null);
  assert.equal(videoTrack([], 26, watch, points, distances), null);
});
