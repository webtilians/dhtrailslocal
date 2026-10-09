# DH Trails Local — GPS Lab v0.3

Laboratorio web de descenso MTB: visor GPS y **editor manual de circuitos, sectores y zonas de GPS débil**. Estética oscura, azul eléctrico y bandera de cuadros.

**Novedad v0.3:** persistencia opcional en **PostgreSQL/Supabase**, cuentas de usuario, sincronización de circuitos y resúmenes de intentos, y almacenamiento privado voluntario de archivos GPX/TCX completos. La web sigue funcionando sin nube para uso local. La base de datos se activa creando un proyecto Supabase y ejecutando el esquema SQL.

**[Instrucciones para activar la base de datos](docs/SUPABASE_SETUP.md)** · [Esquema SQL](supabase/schema.sql)

**Web:** https://webtilians.github.io/dhtrailslocal/  
**Editor:** https://webtilians.github.io/dhtrailslocal/editor.html

## Funcionalidades
- Visor GPS de v0.1 en index.html con mapa, perfil, distancia, tiempos y altitud.
- Editor v0.2 en editor.html: importar una actividad GPX/TCX, marcar sobre el mapa la **salida**, la **meta** y tantos **límites de sector** como quieras.
- Marcar manualmente el inicio y final de **zonas conocidas de mala cobertura GPS**. Se muestran en naranja discontinuo.
- Arrastrar los marcadores de salida, meta y sectores para afinarlos; deshacer/eliminar límites.
- Dar nombres a sectores y zonas de cobertura débil.
- Guardar el trazado *recortado entre salida y meta* como circuito local en el navegador. Exportar o importar su definición JSON.
- Cargar otra actividad completa GPX/TCX, detectar uno o varios pasos por el circuito y estimar tiempo total y por sector a partir de las marcas temporales.
- Botón para mostrar **solo el intento detectado** sobre el trazado oficial.

## Crear Santa Cruz (ejemplo)
1. Entra al editor y carga tu GPX completo de Strava en **Ruta GPS de referencia**.
2. Escribe "Santa Cruz".
3. Activa **Marcar salida** y haz clic cerca del punto de partida del segmento. El marcador se ajustará al punto GPS más cercano.
4. Activa **Añadir límite sector** y coloca cada separación **manualmente** (por ejemplo, inicio del rock garden, salida de las curvas, etc.). Puedes ponerlos antes o después de la meta, siempre dentro del circuito.
5. Activa **Marcar meta** y coloca el final del recorrido.
6. Para zonas donde sabes que el GPS se pierde, activa **Zona GPS débil** y señala su **inicio y final** con dos clics. Asígnale un nombre.
7. Ajusta los marcadores arrastrándolos, revisa todo y pulsa **Guardar circuito en este navegador**.
8. Exporta el JSON para compartirlo o conservarlo. Todavía no se sincroniza con otros usuarios.
9. En **Detectar y cronometrar** importa otro GPX completo y pulsa **Detectar intentos y calcular tiempos**.
10. Cada intento muestra sus parciales y se puede ver **recortado**, sin pintar toda la actividad.

El botón **Crear circuito / sectores** de la portada abre el editor.

## Cómo se calculan los tiempos

El circuito de referencia guarda los puntos GPS entre salida y meta, los límites ordenados de sectores y los intervalos de baja cobertura. Las posiciones son puntos geográficos del recorrido, no índices reutilizados de actividades ajenas.

Para cada actividad, el motor busca acercamientos a la salida y a la meta en orden, comprueba el recorrido aproximado y trata de localizar las puertas de los sectores sobre su propia traza. Interpola la hora de paso a partir de los dos puntos GPS adyacentes. Los resultados son **estimaciones** condicionadas a la frecuencia y precisión de registro.

La tolerancia para reconocer una puerta es inicialmente de **18 m**, no 2–3 m: con árboles o barrancos un GPS puede tener errores mayores. La coincidencia geométrica se compara con un corredor de aproximadamente 30 m y se indica si el recorrido se aparta de él. Estos valores son provisionales para probar con rutas reales.

Las zonas de GPS débil **no hacen que una traza con huecos sea automáticamente válida**: se señalan como incidencias de revisión. Si falta la marca GPS de una puerta de sector, no inventamos ese tiempo parcial; aparecerá "Sin tiempo". Si faltan marcas temporales no calculamos un tiempo total. No se puede garantizar la ausencia de trampas con archivos GPS aportados por usuarios.

**No usar todavía estas marcas para premios, récords oficiales ni competiciones con consecuencias.** Este sistema no certifica que el piloto haya pasado por el sendero real.

## Ejecutar localmente

Necesita conexión para cargar Leaflet/OpenStreetMap. Usa un servidor estático para que los módulos ES funcionen:

```bash
python -m http.server 8000
```

Abre http://localhost:8000/editor.html

## Probar el motor GPS

Requiere Node.js 22 o posterior:

```bash
node --test tests/gps-engine.test.mjs
```

Las pruebas cubren sectores, orden de límites, detección de varios intentos, trazas distantes, ausencia de tiempos y fallos de señal. GitHub Actions ejecuta las pruebas en las PR.

## Publicar (GitHub Pages)

En **Settings → Pages → Source** selecciona **GitHub Actions**. El workflow .github/workflows/pages.yml publica automáticamente los cambios fusionados en master.

A partir de v0.3 el workflow también publica cloud-client.mjs y cloud-config.mjs. La contraseña de base de datos y claves secretas nunca deben estar en estos archivos.

## Limitaciones / próximas versiones
- No se admiten archivos FIT todavía.
- No hay servidor propio ni sistema de competiciones mensuales. La base de datos Supabase y las cuentas son opcionales y requieren un proyecto configurado; tampoco existe aún un motor antitrampas certificado.
- Sin una cuenta Supabase configurada, los circuitos quedan solo en localStorage. Con Supabase, puedes sincronizar y recuperarlos desde otros dispositivos. Conserva los JSON como respaldo.
- El descenso acumulado no tiene filtrado avanzado. Las curvas próximas o senderos cruzados pueden generar ambigüedad GPS.
- Los límites de sectores deben ser realmente medibles por GPS; en zonas sin señal es preferible colocar la puerta antes o después.
- Los cambios posteriores a un circuito guardado requieren crear una versión nueva a partir del GPX de referencia. Edición persistente, roles y sincronización son tareas futuras.

© DH Trails Local
