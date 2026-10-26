// DH Trails — the privacy policy: open to anyone, signed in or not, in the page's language.
import {$, say, startShell} from './app-shell.mjs';

startShell('privacidad').catch(err => {$('status').hidden = false; say($('status'), 'Error: ' + err.message, 'error');});
