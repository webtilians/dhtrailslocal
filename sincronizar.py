"""Explicit, two-way source sync. Run only when ready to publish tracked edits."""
from datetime import datetime
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent

def git(*args, check=True):
    result = subprocess.run(['git', *args], cwd=ROOT, text=True,
                            encoding='utf-8', errors='replace', capture_output=True)
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result

def main():
    if git('branch', '--show-current').stdout.strip() != 'master':
        raise RuntimeError('Cambia a master antes de sincronizar.')
    remote = git('remote', 'get-url', 'origin').stdout.strip()
    if remote not in ('https://github.com/webtilians/dhtrailslocal.git',
                      'git@github.com:webtilians/dhtrailslocal.git'):
        raise RuntimeError('El remoto origin no es webtilians/dhtrailslocal.')
    gitdir = Path(git('rev-parse', '--absolute-git-dir').stdout.strip())
    if any((gitdir/name).exists() for name in ('MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD')):
        raise RuntimeError('Hay una operación Git pendiente. Resuélvela antes de sincronizar.')
    # Never silently publish newly created files: they may be GPS data or secrets.
    new = git('ls-files', '--others', '--exclude-standard').stdout.strip()
    if new:
        raise RuntimeError('Hay archivos nuevos que requieren revisión antes de publicarse:\n'+new+
                           '\nAñade al control de versiones solo los archivos de código que quieras publicar.')
    for path in git('ls-files').stdout.splitlines():
        parts=Path(path).parts
        name=Path(path).name.lower()
        if (path.startswith('backend/data/') or '.venv' in parts or
            (name.startswith('.env') and name!='.env.example') or
            Path(path).suffix.lower() in {'.gpx','.tcx','.fit','.dump','.backup'}):
            raise RuntimeError('Archivo privado bajo control de versiones: '+path)
    print('Consultando cambios en GitHub...', flush=True)
    git('fetch', 'origin', 'master')
    git('add', '-u')
    if git('diff', '--cached', '--quiet', check=False).returncode == 1:
        git('commit', '-m', 'sync: cambios locales '+datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
    merged=git('merge', '--no-edit', 'origin/master', check=False)
    if merged.returncode:
        if (gitdir/'MERGE_HEAD').exists():
            git('merge','--abort')
        raise RuntimeError('No se han sobrescrito cambios. Tus cambios están guardados en un commit local.\n'
                           'Hay que resolver la integración con GitHub:\n'+merged.stdout+merged.stderr)
    git('push', 'origin', 'master')
    print('Sincronización completada. Local y GitHub comparten los cambios.')
    print('Pages se actualizará cuando termine el despliegue:')
    print('https://github.com/webtilians/dhtrailslocal/actions')
    print('Web: https://webtilians.github.io/dhtrailslocal/editor.html')
    print('Si cambió el servidor Python, reinícialo para cargar esa versión; recarga el navegador para cambios web.')

if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError) as exc:
        print('No se ha completado la sincronización:\n'+str(exc), file=sys.stderr)
        sys.exit(1)
