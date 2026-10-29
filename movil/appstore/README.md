# App Store: la ficha y los formularios

Lo que pide App Store Connect para publicar DH Trails (`es.dhtrails.app`, app 6826412099), como está rellenado. La ficha de Google Play está en [movil/play](../play/README.md); los textos son los mismos.

| Carpeta | Dónde va |
| --- | --- |
| `iphone/1-grabar.jpg` … `6-records.jpg` | Capturas del iPhone con Dynamic Island, pantalla mediana (1206 × 2622), en ese orden |
| `ipad/1-grabar.jpg` … `6-records.jpg` | Capturas del iPad de 13" (2064 × 2752), en ese orden |

Las capturas salen del servidor local con datos de prueba (piloto «Organizador»), igual que las de Play, pero a 402 × 874 con densidad 3 (iPhone) y 1032 × 1376 con densidad 2 (iPad). La app declara iPhone y iPad (`TARGETED_DEVICE_FAMILY = "1,2"`), por eso Apple pide las dos.

## Versión (Distribución → App para iOS)

- **Texto promocional:** Cronometra tus bajadas de MTB con el GPS del móvil, sector a sector. Compáralas en el mapa, crea tus circuitos y pelea por el hot seat.
- **Descripción:** la descripción completa de Play, con «pantalla bloqueada» en vez de «pantalla apagada».
- **Palabras clave** (máx. 100): `mtb,downhill,descenso,bicicleta,montaña,enduro,cronometro,gps,tiempos,sectores,bikepark,bajadas`
- **URL de soporte:** https://dh.178-105-103-4.sslip.io/privacidad.html (tiene el correo de contacto). **URL de marketing:** https://dh.178-105-103-4.sslip.io/app.html
- **Copyright:** 2026 Enrique López Ramos
- **Publicación:** manual. Cuando Apple la apruebe no sale sola: hay que pulsar «Publicar esta versión».

**Información para la revisión:** hace falta iniciar sesión. Usuario: el correo de la cuenta de revisión (la app entra con el correo, no con el nombre); la contraseña la escribe el dueño de la cuenta. Las notas, en inglés, explican que Grabar solo cronometra en un circuito, los modos en segundo plano (ubicación y audio) y dónde se borra la cuenta.

## Privacidad de la app

- **Política de privacidad:** https://dh.178-105-103-4.sslip.io/privacidad.html
- **Datos que se recogen**, todos para la funcionalidad de la app, vinculados a la identidad del usuario y sin seguimiento:

| Tipo (Apple) | Qué es en DH Trails |
| --- | --- |
| Datos de contacto → Nombre | El nombre de las clasificaciones |
| Datos de contacto → Correo electrónico | La cuenta |
| Salud y forma física → Forma física | Bajadas, tiempos y los sensores del móvil |
| Ubicación → Ubicación exacta | Las rutas grabadas o subidas |
| Contenido del usuario → Otro contenido | Circuitos, notas, amigos, los GPX subidos, y los 🔥 y comentarios del tablón |
| Identificadores → ID de usuario | El identificador de la cuenta |

## Información de la app

Categoría Deportes, derechos de contenido: usa contenido de terceros (los mapas). Precio: gratis. Clasificación por edad: todas las preguntas en «No» / «Ninguno» salvo, desde el tablón (0.10.2), **contenido generado por usuarios: Sí** (comentarios entre pilotos); la 1.0 salió 4+. Lo que pide Apple para ese contenido (guía 1.2) está en la app: filtro de insultos, denunciar un comentario, bloquear a un piloto, normas en la política de privacidad (`privacidad.html#normas`, que se aceptan al crear la cuenta) y un correo de contacto; la organización revisa las denuncias desde el tablón.
