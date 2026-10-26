// DH Trails — your account: your details, a link by mail to choose a new password, and deleting the account
// with all its data (backend: POST /api/auth/delete-account, app/accounts.py).
import {$, say, startShell} from './app-shell.mjs';
import {T} from './i18n.mjs';

let shell = null;
const status = (message, type = '') => say($('status'), message, type);

function show() {
  const me = shell?.me;
  $('signedIn').hidden = !me;
  $('signedOut').hidden = !!me;
  if (!me) return;
  $('email').textContent = me.email;
  $('name').textContent = me.display_name || T('sin nombre');
  // The organization's account (and a PC's own, offline) is not deleted from here.
  const kept = !!me.organizer || !!me.local;
  $('deleteBox').hidden = kept;
  $('organizerNote').hidden = !kept;
}

$('sendLink').addEventListener('click', async () => {
  try {
    await shell.api.forgotPassword(shell.me.email);
    status(T('Te hemos enviado el enlace a {email}. Mira también en spam.', {email: shell.me.email}), 'success');
  } catch (err) {status(err.message, 'error');}
});

$('deleteAccount').addEventListener('click', async () => {
  const password = $('deletePassword').value;
  if (!password) return status(T('Escribe tu contraseña para borrar la cuenta.'), 'error');
  if (!window.confirm(T('¿Borrar tu cuenta y todos tus datos? No se puede deshacer.'))) return;
  $('deleteAccount').disabled = true;
  try {
    await shell.api.deleteAccount(password);
    await shell.api.signOut();
    shell.setUser(null);
    status(T('Tu cuenta y tus datos se han borrado.'), 'success');
  } catch (err) {status(err.message, 'error');}
  finally {$('deleteAccount').disabled = false;}
});

async function start() {
  shell = await startShell('cuenta');
  shell.onUser(show);
  show();
  if (!shell.me && shell.api) shell.askLogin(T('Entra con tu cuenta para verla.'));
}
start().catch(err => status('Error: ' + err.message, 'error'));
