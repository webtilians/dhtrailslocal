# DH Trails Local — v0.8

Time trials de descenso MTB en circuitos locales: la organización crea los circuitos y los torneos, los pilotos suben el GPX de sus bajadas y el mejor tiempo gana. Además, cualquier piloto puede subir sus rutas para entrenar y comparar sus bajadas.

**Frontend HTML / JavaScript + FastAPI en Python + PostgreSQL.** Funciona en tu PC y en el servidor público (https://dh.178-105-103-4.sslip.io). **[Guía del servidor local y del despliegue](backend/README.md)**.

## Estructura: cuatro pestañas

| Pestaña | Para quién | Qué hace |
|---|---|---|
| **Time trial** (`index.html`) | Todos | Eliges un torneo y ves su clasificación. Con tu cuenta subes el GPX de tu bajada: si sigue el circuito y la velocidad es creíble, entra al momento. |
| **Entrenamiento** (`entrenamiento.html`) | Cualquier piloto con cuenta | Subes cualquier ruta; se buscan en ella todos los circuitos guardados y cada bajada encontrada se guarda en privado. Superpones hasta 4 bajadas de un circuito: mapa, velocidad y diferencia de tiempo a lo largo del recorrido y tiempos por segmento. |
| **Circuitos** (`circuitos.html`) | Organización | Importar archivo → salida, meta y segmentos sobre el mapa → **Guardar ruta**. Las paradas de la bajada de referencia se quitan solas del trazado. También acepta un circuito exportado (`.json`). |
| **Torneos** (`torneos.html`) | Organización | Eliges un circuito guardado, las fechas y el porcentaje mínimo de coincidencia y creas el torneo. Ves todas sus bajadas y puedes aceptar o rechazar cualquiera a mano. |

Al crear la cuenta se pide el nombre de piloto, que es el que sale en la clasificación. La inscripción es abierta (opcionalmente con código: `INVITE_CODE`). Son organizadores las cuentas de `ORGANIZER_EMAILS`, y en tu PC con `LOCAL_SINGLE_USER=true` el perfil local.

## Time trial: cuándo entra una bajada

El servidor busca la bajada en el GPX y la cronometra con las mismas puertas para todos (`backend/app/timing.py`). Entra en la clasificación sola si:

- se hizo entre las fechas del torneo (días de `Europe/Madrid`; se puede subir hasta 2 días después del último);
- coincide con el circuito al menos el porcentaje del torneo (por defecto 85 %: parte de la bajada a menos de 30 m del trazado);
- no tiene ningún tramo sin GPS con una velocidad imposible (lo que delataría un atajo).

Si no, se guarda como **rechazada** con el motivo, que el piloto ve al momento. La organización puede aceptarla o rechazarla después desde Torneos. Cuenta el mejor tiempo de cada piloto; el mismo archivo no se puede presentar dos veces. Un circuito que usa algún torneo queda fijo: no se puede modificar ni borrar.

## Cronometraje con GPS que falla (v0.7)

Los senderos son de un metro: un punto GPS lejos del trazado es un fallo del GPS o una pérdida de cobertura, no otra línea.

- Cada bajada se sigue por su posición a lo largo del trazado. Las puertas, la salida y la meta se cronometran solo con puntos **fiables** (a menos de 30 m del trazado).
- Si se pierden puntos o se desvían, el paso por las puertas de ese tramo se calcula con la **velocidad media** del tramo, entre el último punto fiable y el siguiente.
- Un tramo sin GPS fiable de más de 5 s **no invalida la bajada** si su velocidad media es creíble: como mucho 1,6 veces tu ritmo justo antes y justo después, más 1 m/s, más el margen de error de los dos puntos de los extremos, y nunca más de 80 km/h. Queda anotado en gris.
- Solo se marca para revisar si en ese tramo habrías ido más rápido de lo posible, si no hay marcas de tiempo o si más de la mitad de la bajada está fuera del trazado.
- Esperar en la salida o cruzarla varias veces no cuenta: el tiempo empieza en el último cruce antes de bajar.

El motor del navegador (`gps-engine.mjs`) y el del servidor dan exactamente los mismos tiempos. Cada bajada guarda además su **perfil** (posición en el circuito y hora de cada punto fiable), que usa Entrenamiento para comparar velocidades (`telemetry.mjs`, `charts.mjs`).

## Iniciar servidor local

Dentro de `backend/`:

1. Arranca PostgreSQL en tu PC (instalación nativa o `docker compose up -d postgres`).
2. Instala las dependencias: `python -m pip install -r requirements.txt`.
3. Copia `.env.example` a `.env` y sustituye `SECRET_KEY` por un secreto largo generado aleatoriamente.
4. Ejecuta `python run.py`: aplica las migraciones y sirve la web y la API en **http://127.0.0.1:8000**.

## Datos PostgreSQL

| Tabla | Contenido |
|---|---|
| `pilots` | Pilotos, nombre en la clasificación y contraseñas cifradas con Argon2 |
| `circuits`, `circuit_sectors` | Trazado de referencia y límites de los segmentos |
| `tournaments` | Torneos: circuito, fechas y coincidencia mínima |
| `training_attempts`, `attempt_splits` | Bajadas cronometradas: de un torneo (`tournament_id`) o de entrenamiento, con parciales y perfil |
| `gps_activities` | Archivos GPX/TCX subidos (el archivo vive en una carpeta privada del servidor) |

## Limitaciones

- Cronometraje **estimado** a partir del GPS. Las reglas dificultan las trampas, pero un GPX se puede manipular: no es un cronometraje homologado.
- No se admiten archivos FIT todavía.
- Faltan verificación de correo y recuperación de contraseña.

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
