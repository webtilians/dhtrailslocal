# DH Trails Local — GPS Lab v0.4

Plataforma de entrenamiento de descenso MTB con editor de circuitos, sectores manuales y cronometraje GPS estimado.

## Arquitectura actual
**Frontend HTML / JavaScript + FastAPI en Python + PostgreSQL.** El backend se puede ejecutar completamente en tu PC y migrar posteriormente a un servidor propio.

**[Guía rápida para arrancar FastAPI y PostgreSQL en local](backend/README.md)**

Web pública (versión estática): https://webtilians.github.io/dhtrailslocal/  
Editor: https://webtilians.github.io/dhtrailslocal/editor.html  
Editor con backend local: **http://127.0.0.1:8000/editor.html**

## Funcionalidades

- Importación de actividades GPX y TCX.
- Mapa GPS, perfil, distancia y tiempo transcurrido.
- Editor: seleccionar manualmente salida, meta y límites de sectores; renombrarlos.
- Marcar tramos de cobertura GPS débil.
- Guardar circuitos en el navegador y exportar/importar JSON como respaldo.
- Detectar intentos dentro de una actividad completa y calcular tiempos totales y parciales aproximados.
- **Nuevo v0.4:** API FastAPI con autenticación de pilotos, base PostgreSQL, Alembic y almacenamiento privado de GPX/TCX.
- Guardar circuitos y sectores en PostgreSQL; recuperar desde otra sesión o navegador conectado al mismo servidor.
- Guardar resúmenes de entrenamientos y ficheros originales (solo cuando se solicita).
- API OpenAPI en **/docs** al ejecutar el servidor local.

## Iniciar servidor local

Dentro de `backend/`:

1. Arranca PostgreSQL en tu PC (instalación nativa o `docker compose up -d postgres`).
2. Instala las dependencias: `python -m pip install -r requirements.txt`.
3. Copia `.env.example` a `.env` y sustituye `SECRET_KEY` por un secreto largo generado aleatoriamente.
4. Ejecuta `python run.py`.
5. Abre **http://127.0.0.1:8000/editor.html** y crea tu cuenta.

El comando aplica la migración inicial automáticamente y sirve el frontend y la API bajo el mismo origen. Consulta **[backend/README.md](backend/README.md)** para instrucciones detalladas de Windows, Docker opcional, pruebas y despliegue posterior.

## Datos PostgreSQL

| Tabla | Contenido |
|---|---|
| `pilots` | Pilotos y credenciales cifradas con Argon2 |
| `circuits` | Nombre y trazado GPS de referencia |
| `circuit_sectors` | Puertas manuales de sector, en orden |
| `circuit_weak_zones` | Intervalos con señal deficiente conocidos |
| `training_attempts` | Tiempos y calidad GPS estimados |
| `attempt_splits` | Parciales de cada sector |
| `gps_activities` | Metadatos de archivos GPX/TCX privados |

Los archivos GPS originales se guardan en una carpeta privada del backend, no en GitHub Pages ni dentro de PostgreSQL.

## Despliegue

El frontend sigue publicándose en GitHub Pages. Cuando el servidor FastAPI sea público mediante HTTPS, el editor permitirá indicar su URL y conectarse desde la web. Configura correctamente `CORS_ORIGINS` antes de hacerlo.

La integración experimental Supabase de la antigua v0.3 ha quedado reemplazada por el cliente FastAPI en el frontend; **Supabase no es necesario**.

## Limitaciones

- Cronometraje **estimado** según precisión y frecuencia GPS, sin garantía oficial ni antifraude.
- No se admiten archivos FIT todavía.
- Las pruebas de API se ejecutan con PostgreSQL real en GitHub Actions, pero antes de producción abierta faltan verificación de correo, recuperación de cuenta, rate limiting, control de cuotas, auditoría y mecanismos antitrampas.
- PostgreSQL local y el servidor Python son tuyos: ni GitHub Pages ni ChatGPT los ejecutan permanentemente.
