// DH Trails v0.8 — a new password from the link in the mail («¿Has olvidado la contraseña?»).
import {$, say, startShell} from './app-shell.mjs';
import {T} from './i18n.mjs';

// The token travels after # so it never reaches a server log; it leaves the address bar at once.
const token = new URLSearchParams(location.hash.slice(1)).get('t');
history.replaceState(null, '', location.pathname);
const feedback = (message, type = '') => say($('feedback'), message, type);

async function start() {
  const shell = await startShell('contrasena');
  if (!token) {
    $('resetForm').hidden = true;
    return feedback(T('Este enlace no está completo. Pide otro: «Entrar» → «¿Has olvidado la contraseña?».'), 'error');
  }
  $('resetForm').addEventListener('submit', async event => {
    event.preventDefault();
    if ($('password').value !== $('again').value) return feedback(T('Las dos contraseñas no coinciden.'), 'error');
    $('save').disabled = true;
    try {
      const user = await shell.api.resetPassword(token, $('password').value);
      $('resetForm').hidden = true;
      shell.setUser(user);
      feedback(T('Contraseña cambiada. Ya estás dentro: te llevamos a Entrenamiento…'), 'success');
      setTimeout(() => location.assign('./entrenamiento.html'), 1800);
    } catch (err) {
      feedback(err.message, 'error');
      $('save').disabled = false;
    }
  });
}
start().catch(err => feedback('Error: ' + err.message, 'error'));
