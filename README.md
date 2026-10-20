# DH Trails Local — v0.8

Time trials de descenso MTB en circuitos locales: la organización crea los torneos, los pilotos suben el GPX de sus bajadas y el mejor tiempo gana. Los circuitos los dibuja la organización y también cualquier piloto, los de su zona. Además, cualquier piloto puede subir sus rutas para entrenar y comparar sus bajadas.

**Frontend HTML / JavaScript + FastAPI en Python + PostgreSQL.** Funciona en tu PC y en el servidor público (https://dh.178-105-103-4.sslip.io). **[Guía del servidor local y del despliegue](backend/README.md)**.

## Estructura: cinco pestañas

| Pestaña | Para quién | Qué hace |
|---|---|---|
| **Time trial** (`index.html`) | Todos | Eliges un torneo y ves su clasificación y cuánto falta para que cierre. Con tu cuenta subes el GPX de tu bajada: si sigue el circuito y la velocidad es creíble, entra al momento. Al terminar, el podio (provisional hasta que no se pueda subir más y no quede nada por revisar) y una imagen para compartir. |
| **Entrenamiento** (`entrenamiento.html`) | Cualquier piloto con cuenta | La comparación ocupa todo el ancho; subir una ruta, los amigos y tus rutas van al final (y «↥ Subir ruta», arriba, la analiza al momento). Subes cualquier ruta; se buscan en ella todos los circuitos guardados y cada bajada encontrada se guarda en privado. Cuenta como bajada igual que en un torneo: de la salida a la meta, por todas las puertas y siguiendo al menos el 85 % del trazado; pasar por la salida y la meta de un circuito camino de otros no cuenta. Superpones hasta 4 bajadas de un circuito: mapa, velocidad y diferencia de tiempo a lo largo del recorrido, tiempos por segmento y las frenadas de una o dos bajadas solapadas en el mapa, curva a curva. Con ▶ las bajadas elegidas corren a la vez en el mapa, con la diferencia en directo, y para cada una se ve en qué tramos pierde o gana tiempo frente a la referencia (la más rápida o la que elijas). Con el vídeo de una GoPro, el vídeo marca el reloj y su bajada pasa a ser la referencia; además lista sus paradas, frenadas fuertes, golpes y saltos. Con un segundo vídeo de otra bajada del mismo circuito (tuya de otro día o de un amigo que te pase el suyo), cada uno va a su ritmo con su propia información (tiempo, velocidad, metro). Debajo de cada vídeo, sus propios botones (−1 s, −0,1 s, ▶/❚❚, +0,1 s, +1 s) lo mueven o lo reproducen solo a él: para parar uno en un fotograma (un árbol, una piedra) y buscar ese instante en el otro. También se llevan los dos a la vez a un sector, una frenada o una nota (cada uno donde pasó su bajada). «▶ Reproducir» los arranca juntos y debajo se ve cuánto le saca uno al otro desde ese punto, contando los mismos metros desde donde empezó cada uno, sin volver a alinearlos mientras corren; mientras los colocas, dice en qué metro está cada uno. El vídeo que va delante lleva un marco verde con lo que le saca. Cada vídeo pita al pasar por la salida y por la meta, y más flojo en cada sector (`gate-sounds.mjs`; «🔊 Pitidos» los quita). Cualquier vídeo vale, aunque no tenga GPS o no coincida con una bajada: entonces solo se ven juntos. Para mirar con calma: cámara lenta (×¼, ×½) y repetir en bucle un sector, una frenada o un tramo donde pierdes. Bajo el vídeo, una barra con los sectores, las frenadas y tus notas de esa bajada para saltar a ellos de un toque. **Notas**: lo que quieres recordar en un punto del circuito («aquí freno tarde»), privadas, en el mapa y en la barra del vídeo de todas tus bajadas. **Tu evolución** (`insights.mjs`): tu bajada ideal (tu mejor sector de cada bajada sumado, y de qué día es cada uno), tu progreso por días (total y cuánto le falta a cada sector para tu mejor) y un resumen de la última bajada: frente a tu mejor y a la anterior, en qué sector ganas o pierdes y los 100 m donde más pierdes frente a tu mejor bajada. Ese resumen sale también nada más subir una ruta. |
| **Récords** (`records.html`) | Cualquier piloto con cuenta | La clasificación de cada circuito con el mejor tiempo de cada piloto: cada ruta subida en Entrenamiento se busca en todos los circuitos y su mejor bajada entra sola, igual que las bajadas aceptadas de los torneos. El primero ocupa el 🔥 **hot seat** (desde qué día y cuánto le saca al segundo); también se ve quién tiene el mejor tiempo de cada sector, tu puesto y, con «Mis amigos», solo tus amigos y tú. Al subir una ruta, Entrenamiento dice en qué puesto quedas. Las bajadas de entrenamiento pasan las mismas comprobaciones que las de un torneo (`app/integrity.py`): si el archivo parece editado o copiado, no cuenta, y solo la organización ve por qué (las bajadas anteriores se comprueban la primera vez que podrían salir). Cada piloto puede elegir no salir. |
| **Circuitos** (`circuitos.html`) | Cualquier piloto con cuenta | Lista de todos los circuitos, quién los dibujó y si están aprobados. Importar archivo → salida, meta y segmentos sobre el mapa → **Guardar ruta**. Las paradas de la bajada de referencia se quitan solas del trazado. También acepta un circuito exportado (`.json`). Antes de guardar avisa (`circuit-checks.mjs`) de lo que haría fallar el cronometraje: salida y meta al revés o casi juntas, un circuito muy corto, el trazado que vuelve a pasar junto a la salida, la meta o un límite de segmento (una horquilla), segmentos de menos de 30 m, huecos y saltos del GPS de la ruta; y, como nota, si es el mismo que otro circuito, si comparte trazado con otro o si su salida o su meta caen sobre otro. Son avisos: se puede guardar igualmente. **Circuitos de los pilotos**: el de un piloto cuenta enseguida para los entrenamientos de todos (se busca también en las rutas ya subidas) y queda «Pendiente» hasta que la organización pulsa «Aprobar»; solo entonces se puede usar en un torneo. Un piloto no puede guardar un circuito que ya exista (`backend/app/circuit_rules.py`: salida y meta a menos de 30 m de las de otro, o el 85 % de cada trazado a menos de 15 m del otro), tiene como mucho 20 y solo cambia o borra los suyos; si cambia uno aprobado, vuelve a revisión. |
| **Torneos** (`torneos.html`) | Organización | Eliges un circuito aprobado, las fechas y el porcentaje mínimo de coincidencia y creas el torneo. Ves todas sus bajadas, las que están en revisión y por qué, y puedes aceptar o rechazar cualquiera a mano. «Preparar el siguiente» deja listo el del mes siguiente. |

Al crear la cuenta se pide el nombre de piloto, que es el que sale en la clasificación. La inscripción es abierta (opcionalmente con código: `INVITE_CODE`). Son organizadores las cuentas de `ORGANIZER_EMAILS`, y en tu PC con `LOCAL_SINGLE_USER=true` el perfil local.

## En el móvil: instalar la app y compartirle un GPX

La web se instala como una app (`manifest.json`, iconos `icon-*.png`): en Android, con Chrome o Edge, el botón **Instalar app** de la barra o «Instalar aplicación» en el menú; en iPhone, Safari → Compartir → «Añadir a pantalla de inicio». Instalada en Android, aparece entre las apps a las que compartir un archivo: desde Strava, la app del reloj o el gestor de archivos, compartes el GPX o TCX con **DH Trails** y se abre Entrenamiento con el archivo listo para pulsar «Buscar circuitos», o para enviarlo al time trial abierto. Lo recibe `sw.js`, que no hace nada más: no guarda la web para usarla sin conexión, porque la app necesita su servidor. iPhone no deja compartir archivos con apps web: allí se guarda el GPX en Archivos y se elige con «Importar GPX / TCX» (en iOS el selector deja elegir cualquier archivo, porque a veces no reconoce los .gpx); el botón **Instalar app** explica cómo añadirla a la pantalla de inicio.

## Time trial: cuándo entra una bajada

El servidor busca la bajada en el GPX y la cronometra con las mismas puertas para todos (`backend/app/timing.py`). Entra en la clasificación sola si:

- se hizo entre las fechas del torneo (días de `Europe/Madrid`; se puede subir hasta 2 días después del último);
- coincide con el circuito al menos el porcentaje del torneo (por defecto 85 %: parte de la bajada a menos de 30 m del trazado);
- no tiene ningún tramo sin GPS con una velocidad imposible (lo que delataría un atajo).

Si no, se guarda como **rechazada** con el motivo, que el piloto ve al momento. La organización puede aceptarla o rechazarla después desde Torneos.

Aunque pase esos filtros, queda **en revisión** (fuera de la clasificación hasta que la organización decida) si el archivo parece editado o copiado (`backend/app/integrity.py`):

- el mismo archivo lo subió otro piloto;
- la misma ruta, punto por punto (a menos de medio metro en el 80 % de los puntos), que una bajada de otro piloto, o que otra tuya con otro tiempo;
- más del 20 % de los intervalos entre puntos no son segundos enteros (pasa al retocar las horas);
- la velocidad casi no cambia en toda la bajada (variación por debajo del 6 %, típica de una ruta generada);
- el archivo dice que lo hizo un programa para editar rutas (gpx.studio, GPS Visualizer, GOTOES…), o la bajada tiene fecha futura.

Los umbrales salen de 30 bajadas reales en 9 circuitos: todas tenían intervalos de segundos enteros y una variación de velocidad de al menos el 13 %. El piloto solo ve «En revisión»; la organización ve los motivos. En la clasificación, ✓ **verificado** es una bajada sin ninguna de esas señales o aceptada a mano después de revisarla. El resultado es **final** cuando ya no se pueden subir bajadas y no queda ninguna en revisión. Cuenta el mejor tiempo de cada piloto; el mismo archivo no se puede presentar dos veces. Un circuito que usa algún torneo queda fijo: no se puede modificar ni borrar.

## Cronometraje con GPS que falla (v0.7)

Los senderos son de un metro: un punto GPS lejos del trazado es un fallo del GPS o una pérdida de cobertura, no otra línea.

- Cada bajada se sigue por su posición a lo largo del trazado. Las puertas, la salida y la meta se cronometran solo con puntos **fiables** (a menos de 30 m del trazado).
- Si se pierden puntos o se desvían, el paso por las puertas de ese tramo se calcula con la **velocidad media** del tramo, entre el último punto fiable y el siguiente.
- Un tramo sin GPS fiable de más de 5 s **no invalida la bajada** si su velocidad media es creíble: como mucho 1,6 veces tu ritmo justo antes y justo después, más 1 m/s, más el margen de error de los dos puntos de los extremos, y nunca más de 80 km/h. Queda anotado en gris.
- Solo se marca para revisar si en ese tramo habrías ido más rápido de lo posible, si no hay marcas de tiempo o si más de la mitad de la bajada está fuera del trazado.
- Esperar en la salida o cruzarla varias veces no cuenta: el tiempo empieza en el último cruce antes de bajar.

El motor del navegador (`gps-engine.mjs`) y el del servidor dan exactamente los mismos tiempos. Cada bajada guarda además su **perfil** (posición en el circuito y hora de cada punto fiable), que usa Entrenamiento para comparar velocidades (`telemetry.mjs`, `charts.mjs`).

La **velocidad** de Entrenamiento no hace caso de los saltos del GPS, que antes daban picos de 50 a 98 km/h donde todos iban a 30:
- Se quitan los puntos que están más de 15 m más lejos del sendero de lo que suele ir esa bajada (el GPS se ha ido de lado) y aquellos a los que no se llega a 1,6 veces el ritmo del piloto más 1 m/s, con 8 m de margen por el error del GPS (ha saltado). Es la misma regla que usa el cronometraje para los tramos sin GPS.
- En cada punto la velocidad es la mediana de las velocidades entre todos los pares de puntos de ±3 s (pendiente de Theil–Sen): un punto fuera de sitio cambia unos pocos pares, no la mediana.
- Donde se han quitado puntos o hay más de 3 s sin GPS, la gráfica muestra en discontinua la velocidad media entre los puntos buenos. Los tiempos y las diferencias no cambian: siguen saliendo del perfil completo.

El **vídeo de una GoPro** se ve en Entrenamiento junto a las bajadas (`gopro.mjs`). La cámara guarda dentro del MP4 su telemetría (GPMF): GPS a 10 u 18 puntos por segundo con la hora UTC, acelerómetro y giroscopio. El navegador lee solo esa parte del archivo, sin subir el vídeo, y con la hora encuentra la bajada que el vídeo graba: la de tu reloj, si la has subido, o la del GPS de la propia GoPro, que se puede subir como una ruta más. Después, el punto en el mapa y el cursor de las gráficas siguen al vídeo, y pulsar la gráfica, un sector o una frenada lleva el vídeo a ese momento. Las GoPro graban en H.265: lo muestran Safari, y Chrome o Edge al día con un equipo que lo admita. Si el GPS de la cámara no es fiable en la bajada (precisión DOP de 5 o más, o a más de 20 m de la ruta del reloj en los mismos instantes, como pasa con la cámara en el pecho bajo los árboles), la velocidad y las frenadas salen de la ruta y las paradas, de lo que se mueve la cámara (casi quieta más de 2 s); la hora del vídeo sigue siendo exacta.

Las **frenadas** salen de esa velocidad: van de un pico al punto más lento que le sigue, si se pierden al menos 5 km/h a 0,2 m/s² o más de media. Con un punto por segundo marcan dónde y cuánto se frena, no la fuerza de la frenada. Junto a un tramo sin GPS fiable no se marca ninguna. Con dos bajadas, las frenadas que acaban a menos de 35 m son la misma curva: para cada una se dice cuál pasa más rápido (de 20 m antes a 20 m después) y si frena más tarde o sale más rápido. Si una de las dos no frena claro, se dice qué hace (si baja poco a poco y cuánto, o si su GPS no es fiable ahí) en vez de «no frena».

## Iniciar servidor local

Dentro de `backend/`:

1. Arranca PostgreSQL en tu PC (instalación nativa o `docker compose up -d postgres`).
2. Instala las dependencias: `python -m pip install -r requirements.txt`.
3. Copia `.env.example` a `.env` y sustituye `SECRET_KEY` por un secreto largo generado aleatoriamente.
4. Ejecuta `python run.py`: aplica las migraciones y sirve la web y la API en **http://127.0.0.1:8000**.

## Datos PostgreSQL

| Tabla | Contenido |
|---|---|
| `pilots` | Pilotos, nombre en la clasificación, si salen en los récords y contraseñas cifradas con Argon2 |
| `circuits`, `circuit_sectors` | Trazado de referencia, límites de los segmentos, quién lo dibujó y cuándo se aprobó para torneos |
| `tournaments` | Torneos: circuito, fechas y coincidencia mínima |
| `training_attempts`, `attempt_splits` | Bajadas cronometradas: de un torneo (`tournament_id`) o de entrenamiento, con parciales y perfil |
| `gps_activities` | Archivos GPX/TCX subidos (el archivo vive en una carpeta privada del servidor) |

## Limitaciones

- Cronometraje **estimado** a partir del GPS. Las reglas dificultan las trampas, pero un GPX se puede manipular: no es un cronometraje homologado.
- No se admiten archivos FIT todavía.
- Faltan verificación de correo y recuperación de contraseña.

## Sincronizar PC y GitHub

En la instalación de Windows, haz doble clic en **Sincronizar.cmd** cuando quieras publicar tus cambios. El programa guarda los cambios de archivos ya versionados en un commit, incorpora `origin/master` y sube el resultado. No se ejecuta periódicamente ni publica cada pulsación del editor.

- Los nuevos archivos requieren revisión y añadirlos explícitamente a Git antes de sincronizar.
- Si hay conflictos, cancela la mezcla y conserva los commits locales y remotos para resolverlos sin sobrescribirlos.
- `.env`, el entorno Python, PostgreSQL, los archivos GPS y los lanzadores específicos del PC se excluyen de Git.
- La web pública es la del servidor (https://dh.178-105-103-4.sslip.io): se actualiza con `dhtrails-update` después de fusionar en `master`. GitHub Actions solo pasa las pruebas.
- Recarga el navegador tras actualizar el frontend. Los cambios del backend necesitan reiniciar el servidor local y, si cambian, instalar las dependencias; `run.py` aplica las migraciones pendientes al arrancar.


### Uso local sin registro

En `backend/.env`, `LOCAL_SINGLE_USER=true` activa un perfil local persistente y la conexión automática sin correo ni contraseña. El acceso automático solo admite peticiones locales de la propia aplicación. El valor por defecto es `false` para mantener la autenticación en despliegues compartidos. No se sincroniza el archivo `.env`.
