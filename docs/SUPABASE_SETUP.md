# Activar PostgreSQL + Supabase para DHTrailsLocal

La aplicación se publica en GitHub Pages, que es un servidor de archivos estáticos. **GitHub Pages no aloja PostgreSQL**. La migración SQL y la integración web están implementadas en el repositorio, pero el almacenamiento remoto no funcionará hasta conectar un proyecto Supabase.

## 1. Crear proyecto

1. Abre https://supabase.com/dashboard e inicia sesión.
2. Crea un proyecto nuevo (por ejemplo DH Trails Local), selecciona una región europea y utiliza una contraseña fuerte para la base.
3. En **SQL Editor**, ejecuta todo el contenido del archivo **supabase/schema.sql** del repositorio.
4. Comprueba en **Table Editor** las tablas: pilot_profiles, circuits, circuit_sectors, circuit_weak_zones, training_attempts, gps_activities. En **Storage**, comprueba además que existe el bucket **dhtrails-activities** y que es **privado**.
5. En **Authentication → Providers → Email**, deja habilitado el proveedor Email. Para producción, conserva la confirmación de correo.
6. En **Authentication → URL Configuration**, establece https://webtilians.github.io/dhtrailslocal/ como Site URL. Incluye https://webtilians.github.io/dhtrailslocal/editor.html en las URL permitidas si el flujo de confirmación o recuperación usa redirección.

## 2. Conectar la web

En **Project Settings → API** (o **Connect**), copia únicamente:
- Project URL: la dirección HTTPS del proyecto con dominio supabase.co
- La clave **publishable** (sb_publishable_...) o una clave **anon/public** heredada

**NUNCA** copies una clave service_role, sb_secret, contraseña de Postgres ni token de administración a la web o GitHub.

Durante pruebas, abre https://webtilians.github.io/dhtrailslocal/editor.html y en **05 Base de datos**, introduce la URL y clave pública y pulsa **Conectar proyecto**. Esa configuración pública se recuerda solo en ese navegador.

Para que todos los visitantes utilicen el mismo proyecto, edita **cloud-config.mjs** en GitHub con esos dos valores públicos, crea una PR y fusiónala a master. No se necesitan claves privadas. La seguridad se aplica mediante **RLS** en la base de datos.

## 3. Guardar y recuperar circuitos

1. Crea una cuenta con correo y contraseña, verifica el correo si corresponde e inicia sesión.
2. Importa el GPX y define salida, meta, sectores y zonas GPS débiles.
3. Pulsa **Guardar circuito + descargar copia JSON**. Se crea una copia local, una descarga de respaldo y, con sesión activa, una copia remota.
4. Si el circuito ya estaba guardado, selecciónalo en **Mis circuitos** y usa **Guardar circuito seleccionado en nube**.
5. En otro dispositivo, inicia sesión y pulsa **Recuperar mis circuitos de nube**.
6. Tras detectar intentos, pulsa **Guardar intento privado en nube** para almacenar el tiempo estimado y sus parciales.
7. Si quieres guardar además el archivo original, pulsa **Guardar actividad completa en nube**. El GPX/TCX se conserva en un bucket **privado**. Puedes actualizar, recuperar o eliminar ese archivo desde **Mis actividades GPS**.

Los circuitos son privados inicialmente. Aunque hay un campo de visibilidad para futuro uso, todavía no existe una política de lectura pública.

## 4. Protección y limitaciones

- RLS está habilitada en todas las tablas. Cada piloto puede consultar y modificar únicamente sus circuitos y resultados personales.
- La función SQL save_circuit guarda circuito, sectores y zonas débiles en **una sola transacción**: no pueden quedar sectores incompletos tras fallos.
- Los tiempos se guardan como **estimaciones GPS**, no como cronometrajes oficialmente validados.
- Los archivos GPX/TCX originales solo se suben cuando el piloto pulsa **Guardar actividad completa en nube**. El bucket es privado y restringido por propietario con RLS. Las rutas completas pueden incluir datos de ubicación privados: revisa qué subes.
- No existe todavía una clasificación compartida, autenticación de moderadores ni validación antitrampas para competición.
- La mera existencia del SQL en GitHub **no** significa que la base de datos ya esté creada.
- Conserva los JSON de respaldo mientras no confirmemos la recuperación desde otro dispositivo.

## 5. Pruebas y desarrollo

Con un servidor local: **python -m http.server 8000** y abre http://localhost:8000/editor.html.

Con Node.js 22 o superior: **node --test tests/*.test.mjs**.

La CI comprueba el mapeo y la validación de configuración, pero no prueba un servidor Supabase remoto. Para verificar seguridad real, crea dos cuentas de prueba y comprueba que la cuenta B no pueda descargar los circuitos privados ni los archivos GPX/TCX de A.
