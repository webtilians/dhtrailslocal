# Google Play: la ficha y los formularios

Todo lo que pide Play Console para publicar DH Trails (`es.dhtrails.app`), listo para copiar. Las imágenes están en esta carpeta:

| Archivo | Dónde va |
| --- | --- |
| `icono-512.png` | Icono de la aplicación (512 × 512) |
| `destacada.png` | Gráfico de funciones (1024 × 500) |
| `1-grabar.png` … `6-records.png` | Capturas de pantalla del teléfono (1080 × 1920), en ese orden |

Las capturas salen del servidor local con datos de prueba (piloto «Organizador»), sin nombres de pilotos de verdad. Para rehacerlas: un Chrome sin ventana manejado por su protocolo de depuración, a 360 × 640 con densidad 3, y un marco con el titular encima.

El paquete es `movil/salida/DHTrails-<versión>.aab` (`cd movil/android && gradlew.bat bundleRelease`), firmado con la clave de subida de `DHTrails-claves`. Google guarda la clave de firma de la app (Play App Signing).

## Ficha de Play Store (español, idioma principal)

**Nombre** (máx. 30): `DH Trails`

**Descripción breve** (máx. 80):

> Cronometra tus bajadas de MTB con el GPS del móvil, sector a sector.

**Descripción completa:**

> DH Trails cronometra tus bajadas de bici de montaña con el GPS del móvil, sin reloj ni sensores.
>
> GRABA TU BAJADA
> Pulsa «Empezar a grabar» y tira. La app reconoce la salida del circuito, pita en cada sector y en la meta y te dice en voz alta cómo vas frente a tu mejor tiempo. Sigue grabando con la pantalla apagada y el móvil en la mochila. En el mapa ves por dónde vas y los circuitos que tienes cerca, y te avisa al llegar a la salida de uno.
>
> COMPARA TUS BAJADAS
> Superpón hasta cuatro en el mapa y repítelas a la vez, como una carrera. La gráfica de diferencia te dice en qué tramo pierdes tiempo y en cuál lo ganas, y la tabla te da los tiempos de cada sector y tu bajada ideal juntando los mejores.
>
> CREA TUS CIRCUITOS
> Marca sobre el mapa o el satélite la salida, los límites de los sectores y la meta. La app te dice si el GPS tiene buena cobertura en la salida y en la meta.
>
> SUBE RUTAS DE OTROS DISPOSITIVOS
> Archivos GPX de tu reloj o de otras apps: la app encuentra en ellos las bajadas de cada circuito. Con el vídeo de tu GoPro lee su GPS en tu propio móvil (el vídeo no se sube) y lo sincroniza con la bajada.
>
> SALTOS, GOLPES Y FRENADAS
> Con los sensores del móvil: cuántos saltos y golpes, y lo rota que está cada tramo. Y dónde frenas en cada curva.
>
> RÉCORDS Y TORNEOS
> El hot seat de cada circuito es del más rápido hasta que alguien le baje el tiempo. Tu club puede organizar time trials con clasificación.
>
> TUS DATOS
> Tus rutas son privadas. En los récords y los torneos solo se ven tu nombre y tus tiempos. Sin anuncios.

**Categoría:** Deportes. **Correo de contacto:** enrikelr@hotmail.com. **Sitio web:** https://dh.178-105-103-4.sslip.io/app.html

## Ficha en inglés (en-US, traducción)

**Short description:**

> Time your MTB downhill runs with your phone's GPS, sector by sector.

**Full description:**

> DH Trails times your mountain bike downhill runs with your phone's GPS. No watch, no sensors.
>
> RECORD YOUR RUN
> Tap "Start recording" and ride. The app spots the start of the trail, beeps at every sector and at the finish, and tells you out loud how you're doing against your best time. It keeps recording with the screen off and the phone in your backpack. The map shows where you are and the trails nearby, and warns you when you reach a start.
>
> COMPARE YOUR RUNS
> Lay up to four runs on the map and replay them together, like a race. The gap chart shows where you lose time and where you gain it, and the table gives every sector time and your ideal run made of your best sectors.
>
> CREATE YOUR TRAILS
> Mark the start, the sector limits and the finish on the map or the satellite view. The app tells you whether the GPS gets good coverage at the start and the finish.
>
> UPLOAD ROUTES FROM OTHER DEVICES
> GPX files from your watch or other apps: the app finds the runs of every trail in them. With your GoPro video it reads the camera's GPS on your own phone (the video is never uploaded) and syncs it to the run.
>
> JUMPS, IMPACTS AND BRAKING
> From the phone's sensors: how many jumps and impacts, and how rough every stretch is. And where you brake in every corner.
>
> RECORDS AND TOURNAMENTS
> The hot seat of every trail belongs to the fastest rider until someone beats the time. Your club can run time trials with a leaderboard.
>
> YOUR DATA
> Your routes are private. Records and tournaments only show your name and your times. No ads.

## Contenido de la app (Política → Contenido de la aplicación)

- **Política de privacidad:** https://dh.178-105-103-4.sslip.io/privacidad.html
- **Anuncios:** no tiene anuncios.
- **Acceso a la aplicación:** casi todo pide cuenta. Hay que dar a Google una cuenta de prueba (correo y contraseña) creada en la web, con alguna ruta subida para que vea Entrenamiento. Instrucciones para el revisor: «Inicia sesión con esta cuenta. En Entrenamiento hay bajadas de ejemplo para comparar; Grabar necesita estar en un circuito, así que con la ubicación de la prueba no cronometra».
- **Clasificación de contenido:** categoría «Todas las demás apps». No hay violencia, sexo, lenguaje malsonante, drogas ni apuestas. Los usuarios no hablan entre sí (no hay chat); se ven nombres y tiempos en las clasificaciones. No comparte la ubicación del usuario con otros. No vende productos digitales. Saldrá PEGI 3 / Para todos.
- **Público objetivo:** 16-17 y 18 o más (la política dice que no es para menores de 14, y así no entra en el programa de familias).
- **Aplicaciones de salud:** solo «Actividad física y forma física» (cronometra salidas en bici; no usa Health Connect).
- **Funciones financieras, gobierno, noticias:** ninguna.
- **Permisos de servicio en primer plano:** tipo **Ubicación**. Para qué: «Grabar la ruta con el GPS mientras el usuario baja con la bici, también con la pantalla apagada. El usuario lo empieza con "Empezar a grabar" y lo para con "Terminar y guardar"; mientras graba hay una notificación fija». Pide un **enlace a un vídeo** (YouTube oculto vale) en que se vea: abrir Grabar → Empezar a grabar → apagar la pantalla → la notificación → Terminar y guardar.
- **Ubicación en segundo plano:** no hace falta declararla: la app no pide `ACCESS_BACKGROUND_LOCATION`, graba con el servicio en primer plano.

## Seguridad de los datos

- ¿Recoge o comparte datos de usuario? **Sí**, los recoge. **No los comparte** con terceros (Hetzner y Gmail son proveedores que trabajan para nosotros, y lo que ven otros pilotos lo decide el usuario).
- ¿Cifrados en tránsito? **Sí** (HTTPS).
- ¿Los usuarios pueden pedir que se borren? **Sí**. Enlace para borrar la cuenta: https://dh.178-105-103-4.sslip.io/privacidad.html#borrar

| Tipo de dato (Play) | Qué es en DH Trails | Obligatorio | Para qué |
| --- | --- | --- | --- |
| Ubicación → Ubicación precisa | Las rutas grabadas o subidas | Opcional (el usuario decide grabar o subir) | Funciones de la app |
| Información personal → Dirección de correo | La cuenta | Obligatorio | Gestión de la cuenta, funciones de la app |
| Información personal → Nombre | El nombre de las clasificaciones | Opcional | Funciones de la app |
| Salud y actividad física → Actividad física | Bajadas, tiempos y los sensores del móvil | Opcional | Funciones de la app |
| Archivos y documentos | Los GPX subidos | Opcional | Funciones de la app |
| Actividad en apps → Otro contenido generado por el usuario | Circuitos, notas y amigos | Opcional | Funciones de la app |

Ningún dato se usa para publicidad ni para analítica, y nada se trata «solo de forma efímera».

## Prueba cerrada (obligatoria en cuentas personales nuevas)

Antes de pedir la producción, Google exige una **prueba cerrada con al menos 12 testers apuntados durante 14 días seguidos**:

1. Pruebas → Prueba cerrada → crear el canal (Alpha) y subir el AAB.
2. Testers: una lista de correo con las cuentas de Google (Gmail) de los pilotos con Android.
3. Cada uno abre el enlace de la prueba, pulsa «Convertirse en tester» e instala desde Play. Tienen que seguir apuntados los 14 días.
4. Pasados los 14 días, Panel → «Solicitar acceso a producción».

**Notas de la versión (0.10.0):**

> Primera versión en Google Play: graba tus bajadas con el GPS del móvil, con voz en cada sector, mapa en directo y aviso al llegar a un circuito.
