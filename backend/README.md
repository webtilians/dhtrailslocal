# DH Trails Local — FastAPI + PostgreSQL local

**Esta es la arquitectura recomendada. No requiere Supabase ni servicios externos.**

El backend es un servidor Python FastAPI tradicional. Se ejecuta en Windows, Linux o macOS. PostgreSQL puede instalarse nativamente o levantarse en Docker; después puedes migrarlo al servidor donde ya alojas otras aplicaciones.

## Arrancar en Windows (desarrollo)

Desde el repositorio, abre PowerShell o CMD:

1. Instala PostgreSQL 16 o usa Docker Desktop. Si usas Docker para **solo la base**, ejecuta desde la carpeta backend:
   ```powershell
   docker compose -f compose.yaml up -d postgres
   ```
   Si tienes PostgreSQL nativo, crea base y usuario equivalentes a los datos de conexión del archivo .env; no necesitas Docker.
2. Prepara Python:
   ```powershell
   cd backend
   py -3 -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   Copy-Item .env.example .env
   ```
3. Genera una clave segura para el JWT:
   ```powershell
   .\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(48))"
   ```
   Copia el resultado en `SECRET_KEY=` de `backend/.env` sustituyendo `CHANGE_ME...`. **No publiques .env**.
4. Comprueba que `DATABASE_URL` de `backend/.env` apunta a PostgreSQL local.
5. Arranca el servidor:
   ```powershell
   .\.venv\Scripts\python.exe run.py
   ```

**¡Ya está!** El comando `python run.py` aplica automáticamente las migraciones de Alembic y arranca FastAPI en **http://127.0.0.1:8000**.

- Editor: http://127.0.0.1:8000/editor.html
- API: http://127.0.0.1:8000/docs
- Estado: http://127.0.0.1:8000/api/health
- Visor: http://127.0.0.1:8000/

La web y la API se sirven desde el **mismo puerto**, sin configurar CORS ni servicios externos para trabajar en local. El panel «05 Servidor FastAPI» se conecta automáticamente a la API local si abres el editor en el puerto 8000. Crea una cuenta y comienza a guardar circuitos.

## En Linux/macOS

Desde backend, después de poner en marcha PostgreSQL y crear .env:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python run.py
```

Para crear SECRET_KEY: `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`.

## Qué se guarda

| Entidad | Ubicación |
|---|---|
| Pilotos y hash Argon2 de contraseñas | Tabla `pilots` |
| Circuitos y puntos oficiales | Tabla `circuits` |
| Puertas/sectores manuales | Tabla `circuit_sectors` |
| Intervalos GPS de mala cobertura | Tabla `circuit_weak_zones` |
| Resúmenes de intentos (no verificados) | `training_attempts`, `attempt_splits` |
| Índice de actividades GPX/TCX | `gps_activities` |
| Archivos GPS privados | `backend/data/activities/<pilot-id>/` |

Las rutas completas **solo se suben al servidor cuando eliges guardarlas** en el panel de actividades. Los parciales son estimaciones GPS, no tiempos certificados para clasificaciones.

## ¿Y mi Santa Cruz ya guardado?

En el editor local, en «02 Mis circuitos», selecciona Santa Cruz y pulsa «Guardar circuito seleccionado en servidor». Para moverlo desde GitHub Pages a localhost, exporta el JSON con «Exportar JSON» en tu navegador anterior e impórtalo en el editor local. La misma cuenta lo podrá recuperar desde otro navegador conectado a este servidor.

## Competición mensual (v0.6)

Variables de `backend/.env`:

| Variable | Uso |
|---|---|
| `ORGANIZER_EMAILS` | Correos (separados por comas) que pueden publicar circuitos y aprobar bajadas. En tu PC con `LOCAL_SINGLE_USER=true` el perfil local ya es organizador. |
| `INVITE_CODE` | Si tiene valor, crear cuenta exige este código. Imprescindible en un servidor público. |
| `COMPETITION_TIMEZONE` | Zona horaria de los meses de la clasificación (por defecto `Europe/Madrid`). |
| `ENTRY_MAX_AGE_DAYS` | Antigüedad máxima de una bajada al enviarla (por defecto 7 días). |
| `API_HOST`, `API_PORT` | Dirección y puerto de `python run.py`. |

Endpoints nuevos (documentados en `/docs`):

- Públicos: `GET /api/public/circuits`, `GET /api/public/circuits/{id}/leaderboard?month=AAAA-MM`.
- Pilotos: `PUT /api/me/profile` (nombre en la clasificación), `POST /api/competition/entries` (multipart `circuit_id` + `file`), `GET /api/competition/entries`.
- Organización: `POST /api/circuits/{id}/publish`, `GET /api/competition/review?status=pending`, `POST /api/competition/entries/{id}/review`, `GET /api/competition/entries/{id}/file`.

El servidor cronometra cada envío con `app/timing.py` y lo guarda como `timed_by='server'` y `review_status='pending'`. La clasificación solo usa bajadas aprobadas cronometradas por el servidor. Los intentos de entrenamiento del editor siguen siendo privados y no entran en la clasificación.

`run.py` aplica la migración `0002` al arrancar.

## Servidor público junto a LAIN (`deploy/vps`)

La competición se publica en el mismo servidor que LAIN, con su propia dirección HTTPS (`https://dh.<ip-con-guiones>.sslip.io`). Caddy, que ya sirve LAIN, añade el sitio desde `/etc/caddy/sites.d/dhtrails.caddy`.

| Pieza | Dónde |
|---|---|
| Código | `/opt/dhtrails` (rama en `/etc/dhtrails/branch`, por defecto `master`) |
| Python | `/opt/dhtrails-venv` |
| Configuración y secretos | `/etc/dhtrails/dhtrails.env` (solo root; se crea una vez) |
| API | `dhtrails.service`, uvicorn en `127.0.0.1:8100`, máximo 400 MB de memoria |
| Base de datos | PostgreSQL local, base `dhtrails`, sin contraseña: se entra con el usuario del sistema `dhtrails` |
| Archivos GPS | `/var/lib/dhtrails/activities` |
| Copias | `/var/backups/dhtrails`, diarias y antes de cada actualización, 14 días |

Comandos en el servidor, como root:

- Primera instalación: `git clone https://github.com/webtilians/dhtrailslocal.git /opt/dhtrails && DH_ORGANIZERS=tu@correo bash /opt/dhtrails/deploy/vps/setup.sh`
- Actualizar desde GitHub: `dhtrails-update` (otra rama: `DH_BRANCH=nombre dhtrails-update`).
- Código de invitación para los pilotos: `dhtrails-invite`; cambiarlo: `dhtrails-invite nuevo`.
- Copia inmediata: `dhtrails-backup`. Estado y registro: `systemctl status dhtrails`, `journalctl -u dhtrails -n 50`.

## Pasar a un servidor de producción

1. Haz un **pg_dump** de la base local y restáuralo con **pg_restore** en PostgreSQL del servidor.
2. Copia `backend/data/activities` si conservas GPX/TCX originales.
3. Configura `DATABASE_URL`, un `SECRET_KEY` permanente y `GPS_STORAGE_DIR` en el servidor, fuera del repositorio.
4. Ejecuta `alembic upgrade head` con las nuevas credenciales.
5. Ejecuta Uvicorn detrás de un reverse proxy HTTPS: p. ej. `uvicorn app.main:app --host 127.0.0.1 --port 8000`. Solo expón el proxy 443, nunca PostgreSQL directamente.
6. Si mantienes el frontend en GitHub Pages, configura «05 Servidor FastAPI» con la URL HTTPS pública de tu backend. Añade el origen exacto `https://webtilians.github.io` a `CORS_ORIGINS` (en la .env de producción).
7. Protege el servidor con copias de seguridad, límites de peticiones, verificación de correo/recuperación de contraseña y monitorización antes de admitir registros públicos.

**Para producción abierta a terceros queda pendiente** endurecer autenticación (recuperación de contraseña, revocación/refresh tokens, rate limiting y verificación de correo), auditoría de cargas, control de cuotas y antifraude. El servidor v0.4 es un MVP para desarrollo/uso controlado. No lo publiques sin estas medidas.

## Pruebas

- Pruebas sin base de datos, desde `backend`: `python -m pytest tests/test_validation.py tests/test_timing.py tests/test_frontend_assets.py`.
- Integración real: con un PostgreSQL **de pruebas** migrado, `python -m pytest -q`. No la ejecutes contra tu base de datos real: crea pilotos y circuitos de prueba.
- GitHub Actions arranca un PostgreSQL 16 temporal, aplica Alembic y prueba creación/login, aislamiento de usuarios, circuitos, sectores, intentos, subida/descarga privada de GPX, y que las rutas secretas no estén servidas.
- Documentación OpenAPI interactiva: /docs.

## Infraestructura

El archivo `backend/compose.yaml` solo arranca PostgreSQL (no FastAPI). La base usa un volumen persistente. Está limitada al loopback **127.0.0.1** con contraseña de desarrollo; no utilices ese usuario ni contraseña en producción.

## Nota sobre Supabase

El código experimental de v0.3 puede permanecer en la historia del repositorio, pero **FastAPI + PostgreSQL local reemplaza esa integración en el frontend**. No hace falta crear proyecto Supabase ni conectarlo a ChatGPT.
