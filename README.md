# DH Trails Local — GPS Lab v0.6

Plataforma de entrenamiento de descenso MTB con editor de circuitos, sectores manuales y cronometraje GPS estimado.

## Arquitectura actual
**Frontend HTML / JavaScript + FastAPI en Python + PostgreSQL.** El backend se puede ejecutar completamente en tu PC y migrar posteriormente a un servidor propio.

**[Guía rápida para arrancar FastAPI y PostgreSQL en local](backend/README.md)**

Web pública (versión estática): https://webtilians.github.io/dhtrailslocal/  
Editor: https://webtilians.github.io/dhtrailslocal/editor.html  
Editor con backend local: **http://127.0.0.1:8000/editor.html**

## Novedad v0.6 — Competición mensual

Página **Competición** (`competicion.html`): tú publicas circuitos, los pilotos se inscriben y suben el GPX de su bajada, y cada mes gana el mejor tiempo.

- **El tiempo lo calcula el servidor** a partir del GPX/TCX subido (`backend/app/timing.py`, el mismo motor que `gps-engine.mjs` portado a Python). El navegador nunca envía el tiempo que entra en la clasificación.
- **La organización revisa cada bajada**: aparece como *pendiente*, con la traza GPS, los avisos del detector y el archivo descargable. Solo las aprobadas cuentan.
- **Clasificación pública por mes**: el mejor tiempo aprobado de cada piloto, diferencia con el líder, parciales con el mejor de cada sector marcado y el *tiempo ideal* (suma de los mejores parciales). Pulsa un piloto para ver en el mapa en qué sectores gana o pierde frente al líder.
- **Circuitos congelados al publicarse**: su trazado y sus puertas ya no se pueden cambiar ni borrar, para que todos los tiempos sean comparables.
- **Reglas antitrampas básicas**: el mismo archivo GPS no se puede presentar dos veces (ni por otro piloto), solo se aceptan bajadas de los últimos 7 días y sin fechas futuras, nombre de piloto único y límite de intentos de acceso.
- **Registro con código de invitación** (`INVITE_CODE`) para que solo se inscriban los pilotos de tu grupo.

Cada bajada cuenta en el mes en que se hizo (zona horaria `Europe/Madrid`). Como se aceptan envíos hasta 7 días después, cierra la clasificación de un mes a partir del día 8 del siguiente.

**Quién es organizador:** en tu PC con `LOCAL_SINGLE_USER=true`, el perfil local. En un servidor, las cuentas cuyo correo esté en `ORGANIZER_EMAILS`.

**Para probar en local:** crea y guarda un circuito en PostgreSQL desde el editor, abre http://127.0.0.1:8000/competicion.html, publícalo en «Organización», elige tu nombre de piloto y sube un GPX reciente de ese circuito.

## v0.5 — Comparar bajadas por sectores

Desde **04 Detectar y cronometrar → Comparar entrenamientos** puedes elegir dos intentos de un mismo circuito que estén guardados en **PostgreSQL**. La interfaz muestra, por cada sector:

- Tiempo del intento **A** (referencia) y del intento **B**.
- Diferencia **B − A** (negativa = B más rápido; positiva = B más lento).
- Diferencia acumulada, mientras no falten parciales.
- El recorrido coloreado en **verde** si B mejora, **rojo** si B pierde, **azul** si empata y **gris** si no hay tiempos comparables.

Pulsa una fila para acercarte a ese sector en el mapa. Una marca **Revisión GPS** o un parcial ausente no se considera prueba de recorrido válido. Los tiempos proceden de GPX/TCX y son **estimaciones**, no cronometrajes homologados.

**Para probar:** abre la app con FastAPI en local, selecciona Santa Cruz, guarda al menos dos intentos desde «Detectar y cronometrar», pulsa **Cargar mis intentos guardados**, elige A y B y pulsa **Comparar sectores en el mapa**. Si el circuito existe solo en el navegador, guárdalo primero en PostgreSQL.

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
| *(v0.6)* | `pilots.display_name`, `circuits.published_at`, `training_attempts.timed_by` / `review_status`, `gps_activities.sha256` |
| `gps_activities` | Metadatos de archivos GPX/TCX privados |

Los archivos GPS originales se guardan en una carpeta privada del backend, no en GitHub Pages ni dentro de PostgreSQL.

## Despliegue

El frontend sigue publicándose en GitHub Pages. Cuando el servidor FastAPI sea público mediante HTTPS, el editor permitirá indicar su URL y conectarse desde la web. Configura correctamente `CORS_ORIGINS` antes de hacerlo.

La integración experimental Supabase de la antigua v0.3 ha quedado reemplazada por el cliente FastAPI en el frontend; **Supabase no es necesario**.

## Limitaciones

- Cronometraje **estimado** según precisión y frecuencia GPS. La revisión de la organización y las reglas de la v0.6 dificultan las trampas, pero un GPX se puede manipular: no es un cronometraje homologado.
- No se admiten archivos FIT todavía.
- Las pruebas de API se ejecutan con PostgreSQL real en GitHub Actions, pero antes de producción abierta faltan verificación de correo, recuperación de cuenta, rate limiting, control de cuotas, auditoría y mecanismos antitrampas.
- PostgreSQL local y el servidor Python son tuyos: ni GitHub Pages ni ChatGPT los ejecutan permanentemente.

## Sincronizar PC, GitHub y Pages

En la instalación de Windows, haz doble clic en **Sincronizar.cmd** cuando quieras publicar tus cambios. El programa guarda los cambios de archivos ya versionados en un commit, incorpora `origin/master` y sube el resultado. No se ejecuta periódicamente ni publica cada pulsación del editor.

- Los nuevos archivos requieren revisión y añadirlos explícitamente a Git antes de sincronizar.
- Si hay conflictos, cancela la mezcla y conserva los commits locales y remotos para resolverlos sin sobrescribirlos.
- `.env`, el entorno Python, PostgreSQL, los archivos GPS y los lanzadores específicos del PC se excluyen de Git.
- GitHub Actions publica automáticamente el frontend de `master` en https://webtilians.github.io/dhtrailslocal/ . Comprueba que el despliegue finaliza en verde en Actions.
- Recarga el navegador tras actualizar el frontend. Los cambios del backend necesitan reiniciar el servidor local y, si cambian, instalar las dependencias; `run.py` aplica las migraciones pendientes al arrancar.

Pages aloja HTML, CSS y JavaScript: no ejecuta Python ni PostgreSQL, ni comparte automáticamente los datos del PC con Internet.

### Uso local sin registro

En `backend/.env`, `LOCAL_SINGLE_USER=true` activa un perfil local persistente y la conexión automática sin correo ni contraseña. El acceso automático solo admite peticiones locales de la propia aplicación. El valor por defecto es `false` para mantener la autenticación en despliegues compartidos. No se sincroniza el archivo `.env`.
