# DH Trails Local — GPS Lab v0.1

Visor GPS de descenso MTB, con estética negra y azul eléctrico y motivo de bandera de cuadros.

## Características
- Importación local de **GPX** (tracks `trkpt` y rutas `rtept`) y **TCX**.
- Mapa interactivo OpenStreetMap/Leaflet con inicio y final.
- Distancia, tiempo transcurrido, velocidad media y desnivel negativo aproximado.
- Perfil altimétrico con SVG.
- Ruta **demo simulada** para ver la interfaz sin un archivo.
- Diseño adaptable a escritorio y móvil.
- Sin backend ni cuenta: los archivos se leen en el navegador.

## Ejecutar

La aplicación es estática: abre `index.html` directamente en un navegador con conexión para obtener los mapas y librerías externas. Alternativamente, desde la carpeta del repositorio:

```bash
python -m http.server 8000
```

Luego visita http://localhost:8000

## Publicar en GitHub Pages
En **Settings → Pages**, elige **Deploy from a branch**, selecciona la rama que contenga `index.html` y la carpeta **/(root)**. No se crea el despliegue automáticamente con esta PR.

## Limitaciones v0.1
- **FIT no está soportado aún**. Exporta como GPX o TCX desde tu plataforma o dispositivo.
- El perfil usa altitud GPS sin filtrado avanzado. El descenso acumulado puede estar inflado por ruido.
- El tiempo mostrado es el transcurrido entre la primera y última marca temporal de la ruta; no representa aún un segmento DH ni una prueba validada.
- No hay almacenamiento de rutas, usuarios, clasificaciones ni sistema antitrampas.
- Rutas muy grandes o con muchísimos puntos pueden afectar al rendimiento del dispositivo.
- Un GPX con coordenadas sensibles se mantiene local en esta versión; revisa los datos antes de compartir el archivo.

## Próxima iteración
Motor de detección de tramos y comparación espacial, FIT, análisis de calidad del GPS, test automatizados y clasificación de descensos.

© DH Trails Local
