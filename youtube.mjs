// A YouTube video as the second video, through YouTube's own embedded player (its privacy mode), with the
// few things the training page uses of a <video>: its time, play and pause, its speed and its events.
// YouTube drops a camera's GPS when the video is uploaded, so it is lined up by hand.
import {T} from './i18n.mjs';

// The video and the second it starts at, from a YouTube link as copied from the app or the browser
// (youtu.be/…, watch?v=…, shorts/…, embed/…, live/…, with or without https and &t=1m30s), or null.
export function youtubeLink(text) {
  let url;
  const raw = String(text ?? '').trim();
  try {url = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);} catch {return null;}
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  let id = null;
  if (host === 'youtu.be') id = parts[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com')
    id = parts[0] === 'watch' ? url.searchParams.get('v') : ['shorts', 'embed', 'live', 'v'].includes(parts[0]) ? parts[1] : null;
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  const t = (url.searchParams.get('t') || url.searchParams.get('start') || '').toLowerCase();
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t);
  return {id, start: m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0, vertical: parts[0] === 'shorts'};
}

const WHY = {
  2: T('El enlace no es de un vídeo de YouTube válido.'),
  5: T('YouTube no puede reproducir ese vídeo aquí.'),
  100: T('Ese vídeo no existe, es privado o lo han quitado.'),
  101: T('Su autor no deja verlo dentro de otras webs: solo se puede ver en YouTube.'),
  150: T('Su autor no deja verlo dentro de otras webs: solo se puede ver en YouTube.')};

let api = null;
function loadApi() {
  api ||= new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const before = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {before?.(); resolve(window.YT);};
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => {api = null; reject(new Error(T('No se puede cargar el reproductor de YouTube. ¿Hay conexión?')));};
    document.head.append(script);
  });
  return api;
}

export class YouTubeVideo extends EventTarget {
  // The player inside `holder` (already in the page), muted (the sound is the first video's).
  static async create(link, holder) {
    const YT = await loadApi();
    const video = new YouTubeVideo(link, holder);
    await video.start(YT);
    return video;
  }
  constructor(link, holder) {
    super();
    this.link = link;
    this.node = holder;
    this.paused = true;
    this.ready = false;
    this.error = '';
    this.seeking = false;
    // Moved before it was ever played, YouTube starts it: it stops right away at the second asked for.
    this.started = false;
    this.hold = null;
    // A Short is vertical; any other video is taken as 16:9 (the player does not say).
    this.videoWidth = link.vertical ? 9 : 16;
    this.videoHeight = link.vertical ? 16 : 9;
    holder.classList.toggle('vertical', link.vertical);
  }
  start(YT) {
    return new Promise((resolve, reject) => {
      const target = document.createElement('div');
      this.node.replaceChildren(target);
      this.player = new YT.Player(target, {
        host: 'https://www.youtube-nocookie.com', videoId: this.link.id, width: '100%', height: '100%',
        playerVars: {playsinline: 1, rel: 0, start: this.link.start},
        events: {
          onReady: () => {
            this.ready = true;
            this.player.mute();
            this.last = this.link.start;
            try {this.title = this.player.getVideoData().title || '';} catch {this.title = '';}
            this.emit('loadedmetadata');
            this.watch();
            resolve();
          },
          onStateChange: event => this.changed(event.data),
          onError: event => {
            this.error = WHY[event.data] || WHY[5];
            if (this.ready) this.emit('error');
            else reject(new Error(this.error));
          },
        },
      });
    });
  }
  emit(type) {this.dispatchEvent(new Event(type));}
  // Buffering does not change whether it is playing or paused.
  changed(state) {
    if (state === 1 && this.hold !== null) {
      const at = this.hold;
      this.hold = null;
      this.player.pauseVideo();
      this.player.seekTo(at, true);
      return;
    }
    if (state === 1 || state === 2) this.started = true;
    if (state === 1 && this.paused) {this.paused = false; this.emit('play');}
    else if ([-1, 0, 2, 5].includes(state) && !this.paused) {this.paused = true; this.emit('pause');}
  }
  // The player has no time events: its time is read four times a second. A jump that the page did not
  // make (YouTube's own bar) counts as moving it.
  watch() {
    let at = performance.now();
    this.timer = setInterval(() => {
      const t = this.currentTime, now = performance.now();
      const expected = this.last + (this.paused ? 0 : (now - at) / 1000 * this.playbackRate);
      if (Math.abs(t - expected) > (this.paused ? 0.05 : 1)) this.emit('seeking');
      if (t !== this.last) this.emit('timeupdate');
      this.last = t;
      at = now;
    }, 250);
  }
  get readyState() {return this.ready ? 4 : 0;}
  get duration() {return this.ready ? this.player.getDuration() || NaN : NaN;}
  get currentTime() {return this.ready ? this.player.getCurrentTime() || 0 : 0;}
  set currentTime(seconds) {
    if (!this.ready) return;
    if (!this.started) this.hold = Math.max(0, seconds);
    this.player.seekTo(Math.max(0, seconds), true);
    // The new time shows once YouTube has it (the next reading), not as a jump of its own.
    this.last = NaN;
    this.emit('seeking');
  }
  get playbackRate() {return this.ready ? this.player.getPlaybackRate() : 1;}
  // YouTube has a few speeds only (up to ×2): the nearest one not above the one asked for.
  set playbackRate(rate) {
    if (!this.ready) return;
    const rates = this.player.getAvailablePlaybackRates();
    this.player.setPlaybackRate(rates.filter(r => r <= rate).pop() ?? rates[0]);
  }
  get hidden() {return this.node.hidden;}
  set hidden(value) {this.node.hidden = value;}
  get parentElement() {return this.node.parentElement;}
  // Resolves once it really plays (YouTube takes a moment to start), or after 5 s.
  play() {
    return new Promise(done => {
      if (!this.ready) return done();
      if (!this.paused) return done();
      this.hold = null;
      const late = setTimeout(done, 5000);
      this.addEventListener('play', () => {clearTimeout(late); done();}, {once: true});
      this.player.playVideo();
    });
  }
  pause() {if (this.ready) this.player.pauseVideo();}
  destroy() {
    clearInterval(this.timer);
    try {this.player?.destroy();} catch {}
    this.node.remove();
  }
}
