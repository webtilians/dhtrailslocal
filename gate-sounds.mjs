// The beeps of the gates while the video of a run plays: the same one when it goes through the start and
// through the finish, a softer one at each sector gate. Made with Web Audio: no sound files.

// The gates of a run, as moments of the run (ms from its start): the start, each sector gate, the finish.
export function runGates(sectorMs, elapsedMs) {
  return [{ms: 0, kind: 'line'}, ...sectorMs.map(ms => ({ms, kind: 'sector'})), {ms: elapsedMs, kind: 'line'}];
}

// The gates passed between two moments of the run while it plays forward. A jump (moving the video, a
// loop going back, a long stall) passes none: only playing through a gate beeps.
export function gatesPassed(from, to, gates, maxStep = 3000) {
  if (from === null || from === undefined || !(to > from) || to - from > maxStep) return [];
  return gates.filter(g => g.ms > from && g.ms <= to);
}

let context = null;
const Audio = () => globalThis.AudioContext || globalThis.webkitAudioContext;
// Browsers only let a page make sound after a tap: this is called on one, so the beeps can sound later
// while the video plays. On an iPhone, beeps sound like the video, even with the phone on silent.
export function unlockSound() {
  if (!Audio()) return;
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    context ||= new (Audio())();
    if (context.state === 'suspended') context.resume().catch(() => {});
  } catch {}
}
// A short tone: loud for the start and the finish, soft for a sector gate.
export function beep(kind = 'line') {
  unlockSound();
  if (!context) return;
  if (context.state === 'running') return tone(kind);
  // Just after a tap the sound may still be starting: a beep that would come late is left out.
  const asked = performance.now();
  context.resume().then(() => {if (performance.now() - asked < 300) tone(kind);}).catch(() => {});
}
function tone(kind) {
  const loud = kind === 'line', peak = loud ? 0.2 : 0.05, length = loud ? 0.3 : 0.12, t = context.currentTime;
  const wave = context.createOscillator(), volume = context.createGain();
  wave.type = 'square';
  wave.frequency.value = 1000;
  // In and out in a few milliseconds, so it does not click.
  volume.gain.setValueAtTime(0.0001, t);
  volume.gain.exponentialRampToValueAtTime(peak, t + 0.008);
  volume.gain.setValueAtTime(peak, t + length - 0.03);
  volume.gain.exponentialRampToValueAtTime(0.0001, t + length);
  wave.connect(volume).connect(context.destination);
  wave.start(t);
  wave.stop(t + length + 0.02);
}
