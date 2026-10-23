// DH Trails v0.8 — the app for Android, installed without the Play Store, and DH Trails on an iPhone meanwhile.
import {$, say, startShell} from './app-shell.mjs';

const page = location.origin + location.pathname;
// A QR code of this page, to pass it on from one phone to another at the trail.
if (window.qrcode) {
  const qr = window.qrcode(0, 'M');
  qr.addData(page);
  qr.make();
  $('qr').innerHTML = qr.createSvgTag({cellSize: 6, margin: 2, scalable: true});
}
$('pageUrl').textContent = page.replace(/^https?:\/\//, '');
// An iPhone sees its own instructions first; inside the app there is nothing to install.
if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
  $('iphone').after($('android'));
if (window.Capacitor?.isNativePlatform?.()) $('inApp').hidden = false;
startShell('app').catch(err => say($('status'), 'Error: ' + err.message, 'error'));
