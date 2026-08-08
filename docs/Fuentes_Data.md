# Datos geográficos reales para tu prototipo SAMU + Portal (Lima): ¿Real o Simular?

## TL;DR
- **Puedes usar datos REALES y descargables en tres de las cinco capas:** (1) coordenadas de semáforos vía OpenStreetMap/Overpass API, (2) ubicación de hospitales/postas vía RENIPRESS/SUSALUD (CSV mensual georreferenciado en datosabiertos.gob.pe) o vía OSM, y (3) red de calles/ruteo vía OSRM self-hosted (extract de Perú de Geofabrik) o Mapbox Directions API (100.000 requests/mes gratis).
- **Debes SIMULAR dos capas:** el estado rojo/verde en tiempo real de cada semáforo (no existe API pública; Protránsito no expone telemetría) y las bases exactas del SAMU (solo hay conteos y distritos en prensa/MINSA, sin coordenadas oficiales exportables).
- **El "tráfico transversal" sí puede ser REAL:** TomTom Traffic API (50.000 tiles + 2.500 requests no-tile por día gratis, sin tarjeta) o HERE dan velocidad de flujo/congestión por segmento en Lima, aunque ninguno da el estado exacto de cada semáforo.

## Key Findings
1. **Semáforos (coordenadas): REAL.** OSM tiene el tag `highway=traffic_signals` como nodos con lat/long, consultables por Overpass API con un bounding box de Lima. Cobertura parcial pero utilizable en avenidas principales.
2. **Hospitales/postas: REAL.** RENIPRESS (SUSALUD) publica un CSV mensual georreferenciado en datosabiertos.gob.pe con columnas de coordenadas (última versión `RENIPRESS_31-07-2026.csv`). Alternativa aún más limpia para coordenadas: OSM `amenity=hospital`.
3. **Bases SAMU: SIMULAR.** Solo hay conteos y distritos en prensa/MINSA (22 bases en mayo 2024 → 27 → 29 en abril 2026), sin coordenadas oficiales.
4. **Ruteo calle por calle: REAL.** Mejor opción para hackathon: OSRM self-hosted (gratis, sin límites) o Mapbox Directions (100k requests/mes gratis). Google Routes y GraphHopper también son viables.
5. **Estado tiempo real de semáforos: NO existe API pública** (Protránsito no publica telemetría). Congestión/flujo sí: TomTom, HERE.

---

## Details

### 1. Coordenadas de intersecciones/semáforos en Lima → **REAL**
- **Fuente:** OpenStreetMap, tag `highway=traffic_signals`, mapeado como **nodo con coordenadas** (lat/long). Consultable vía Overpass API.
- **API/Exportable:** Sí. Overpass API (overpass-turbo.eu). Query de ejemplo:
```
[out:json][timeout:25];
node["highway"="traffic_signals"]({{bbox}});
out geom;
```
El orden del bbox en Overpass es **(lat_min, lon_min, lat_max, lon_max)** — error clásico es invertirlo y obtener resultados vacíos. Para Lima Metropolitana un bbox aproximado es `(-12.25, -77.15, -11.95, -76.90)`. Desde overpass-turbo puedes exportar a **GeoJSON o CSV** (Export → "raw data"). Alternativa: descargar el extract completo `peru-latest.osm.pbf` (~228 MB) de Geofabrik (`https://download.geofabrik.de/south-america/peru.html`, actualizado a diario) y filtrar el tag localmente; también existe un extract solo de Lima vía bbbike (`https://download.bbbike.org/osm/bbbike/Lima/Lima.osm.pbf`, ~29 MB).
- **Tiempo real:** No. Datos estáticos (solo ubicación, no rojo/verde).
- **Limitaciones de cobertura Lima:** OSM es colaborativo y desigual. Las avenidas principales (Javier Prado, Arequipa, Brasil, La Marina, Panamericana) suelen tener buena densidad de nodos `traffic_signals`, pero cruces secundarios pueden faltar o estar mapeados solo como nodo de intersección sin el tag. **Verifica visualmente en overpass-turbo tu avenida objetivo antes de la demo.**
- **Contexto oficial (para la narrativa, NO descargable):** La Municipalidad de Lima, vía Protránsito, gestiona una red semafórica grande pero cerrada. Según El Comercio, "solo 415 intersecciones semaforizadas de Lima, de un total de 1.394, están conectadas al Centro de Control y Gestión de Tránsito (CCGT)". La página oficial de Protránsito (Estructura Funcional, munlima.gob.pe) reporta cifras de infraestructura más amplias: **748 intersecciones centralizadas, 10.367 equipos semafóricos, 680 controladores, 201 cámaras tipo DOMO, 1.531 cámaras de tráfico y 220 km de fibra óptica en 28 distritos.** Además hay un plan de modernización con el Banco Mundial: ITS Perú describe la "ampliación y modernización de la red semafórica para integrar y gestionar **426 intersecciones**" desde el CCGT en un plan de acción 2023-2027 (plazo máximo cinco años); notas de prensa de marzo 2026 (El Comercio) citan una cifra mayor de "500 intersecciones" con inversión estimada de US$150 millones del Banco Mundial. **Hay discrepancia entre fuentes (426 vs 500); usa la cifra oficial de Protránsito/ITS Perú (426) como la más sólida.** Nada de esto es un dataset con coordenadas públicas.
- **Recomendación:** **REAL** — usa OSM/Overpass para las coordenadas de los semáforos.

### 2. Ubicación de hospitales/postas en Lima → **REAL**
- **Fuente principal:** RENIPRESS (Registro Nacional de Instituciones Prestadoras de Servicios de Salud), administrado por **SUSALUD**, publicado en la Plataforma Nacional de Datos Abiertos. Se define oficialmente como el "Registro donde se muestra información de todas las IPRESS públicas, privadas y mixtas a nivel nacional, autorizadas para brindar servicios de salud", con licencia Open Data Commons Attribution y **actualización mensual**.
- **API/Exportable:** Sí. CSV mensual descargable. La versión más reciente es **`RENIPRESS_31-07-2026.csv`** (31-jul-2026, ~18,7 MB). Los metadatos también están disponibles como JSON vía la API CKAN de datosabiertos.gob.pe (endpoint `package_show`).
  - Descarga directa: `https://www.datosabiertos.gob.pe/sites/default/files/RENIPRESS_31-07-2026.csv`
  - Página del dataset: `https://www.datosabiertos.gob.pe/dataset/registro-nacional-de-entidades-prestadoras-de-servicios-de-salud-renipress`
  - Diccionario de datos (PDF): `https://www.datosabiertos.gob.pe/sites/default/files/Diccionario%20de%20datos%20RENIPRESS.pdf`
- **Coordenadas:** Sí. El diccionario oficial define dos columnas: **`LONGITUD_NORTE`** y **`LONGITUD_ESTE`** (mostradas en la web como "Longitud" y "Latitud"). ⚠️ **ADVERTENCIA CRÍTICA:** el etiquetado oficial es inconsistente/cruzado — la columna llamada `LONGITUD_NORTE` está descrita como "Longitud" y `LONGITUD_ESTE` como "Latitud". Verifica empíricamente cuál columna trae la latitud (~-12.0 en Lima) y cuál la longitud (~-77.0 en Lima) antes de usar. Son de tipo alfanumérico, por lo que puede haber **celdas vacías** en establecimientos sin georreferenciar.
- **Alternativas (recomendadas para velocidad):**
  - **OSM `amenity=hospital` / `amenity=clinic` vía Overpass** — coordenadas lat/long directas, sin ambigüedad de columnas ni celdas vacías; menos exhaustivo que RENIPRESS pero más que suficiente para una demo. Query: `node["amenity"="hospital"]({{bbox}}); out geom;`
  - **Visor SUSALUDmap** (`http://mapa.susalud.gob.pe/`) — host activo pero bloquea acceso automatizado; útil para verificación manual en navegador.
  - **Dataset "Establecimientos de Salud" del MINSA** en datosabiertos.gob.pe (a nivel nacional; el conteo exacto de registros conviene confirmarlo abriendo el CSV — las notas del MINSA citan del orden de 24.000 IPRESS inscritas a nivel nacional).
- **Tiempo real:** No aplica (estático, actualización mensual).
- **Recomendación:** **REAL.** Para la demo, lo más rápido y limpio es filtrar hospitales de Lima con `amenity=hospital` vía Overpass (coordenadas garantizadas) y usar RENIPRESS como respaldo oficial con categorías (hospital, centro de salud, posta, clínica).

### 3. Bases de ambulancias SAMU en Lima → **SIMULAR (con anclaje realista)**
- **Fuente:** Prensa (La República, Infobae, El Peruano) y notas del MINSA en gob.pe. La evolución del conteo:
  - Mayo 2024: **22 bases operativas** (una por distrito en 22 de 43 distritos de Lima) — La República / Infobae.
  - A inicios de 2026 el MINSA reporta **27 bases** tras inaugurar la sede de San Bartolo (según la nota oficial de gob.pe, la sede está "ubicada en la Mz. M Lt. 3 en la tercera etapa del asentamiento humano San José").
  - Abril 2026: El Peruano reporta que el Minsa "garantiza la operatividad del SAMU con sus **29 bases** en Lima Metropolitana".
- **Distritos con bases mencionados en prensa:** Jesús María, Breña, Pueblo Libre, Comas, San Martín de Porres, Villa El Salvador, La Victoria (C.S. El Porvenir), Santa Anita, Surco, Rímac, El Agustino, San Luis, San Juan de Miraflores, San Bartolo, Punta Hermosa y Barranco (base en el Estadio Luis Gálvez Chipoco, ambulancia donada por Japón).
- **API/Exportable:** No. No hay dataset con coordenadas.
- **Geolocalización exacta:** No, salvo casos puntuales citados en prensa que puedes geocodificar a mano (Estadio Luis Gálvez Chipoco en Barranco; C.S. El Porvenir en La Victoria; AH San José en San Bartolo).
- **Recomendación:** **SIMULAR.** Genera coordenadas de bases ancladas a los distritos reales listados por MINSA/prensa; para 2-3 bases usa los puntos exactos citados para dar credibilidad. Dado que el origen de tu demo es "el punto de emergencia", esta capa es la menos crítica del proyecto.

### 4. API de ruteo (calle por calle) para Lima → **REAL**
Comparación para un evento de 39 horas:

| Opción | Tier gratuito | Cobertura Lima | Integración rápida | Tráfico en vivo |
|---|---|---|---|---|
| **OSRM self-hosted** | **Gratis, sin límites de requests** | Buena (hereda OSM) | Media (requiere Docker) | No (perfiles estáticos) |
| **Mapbox Directions** | **100.000 requests/mes** | Buena | Alta (SDK JS/Python) | Sí (`driving-traffic`) |
| **Google Routes** | 10.000 eventos/mes por SKU (Essentials, desde mar-2025) | Excelente (la más pulida) | Alta | Sí |
| **GraphHopper** | Plan gratuito no comercial, límite de créditos/min (bajo) | Buena (hereda OSM) | Alta | Limitado |

- **OSRM self-hosted:** descargas `peru-latest.osm.pbf` (~228 MB), corres `osrm-extract` → `osrm-partition` → `osrm-customize` → `osrm-routed` (imagen Docker oficial `ghcr.io/project-osrm/osrm-backend`). Devuelve geometría (polyline), distancia (m), duración (s) y pasos turn-by-turn. RAM ≈ 5× el tamaño del archivo (≈1–1.5 GB para Perú, muy manejable en un laptop). No hay límite de requests ni de waypoints. Sin tráfico en vivo, pero puedes inyectar velocidades por segmento con `--segment-speed-file` (modo MLD).
- **Mapbox Directions:** free tier confirmado de **100.000 requests/mes** ("the free tier of 100,000 monthly requests, requests 100,001 through 500,000 bill at $2.00/1K"), sin tarjeta para empezar; SDK JS y librerías Python. ⚠️ Sus términos prohíben cachear/almacenar resultados y exigen que las queries respondan a interacción humana — para una demo es aceptable, pero tenlo presente.
- **Google Routes:** tras la restructuración de marzo 2025, cada SKU tiene su propio cap gratuito (10.000 eventos/mes Essentials); requiere tarjeta. Excelente calidad de calles en Lima, pero se encarece al escalar.
- **GraphHopper:** plan gratuito solo para uso no comercial, con límite de créditos por minuto y volumen diario bajo; basado en OSM. Sirve para pruebas, no para demos intensivas.
- **Recomendación:** **REAL.** Decide en la primera hora: **OSRM self-hosted** si alguien del equipo maneja Docker (control total, cero costo, sin límites), o **Mapbox Directions** si quieres cero setup de infraestructura y máxima velocidad de integración.

### 5. Estado en tiempo real de semáforos / tránsito en Lima → **SIMULAR (semáforos) / REAL opcional (congestión)**
- **Estado rojo/verde por semáforo: NO existe API pública.** Protránsito opera el CCGT que monitorea las intersecciones centralizadas (415–748 según fuente), pero no expone telemetría pública ni API. **Debes SIMULAR el estado de cada semáforo.**
- **Tráfico/congestión (flujo): SÍ hay opciones reales:**
  - **TomTom Traffic API:** free tier confirmado de **50.000 tiles + 2.500 requests no-tile por día, sin tarjeta y con uso comercial permitido**; el endpoint Traffic Flow devuelve velocidad actual, velocidad de flujo libre y travel time por segmento. TomTom publica un Traffic Index de Lima, lo que confirma cobertura de la ciudad. ⚠️ Su pricing se revisa a partir de julio 2026 — reconfirma límites al registrarte.
  - **HERE Traffic API:** el tráfico está incluido en el Base Plan; nota importante: HERE **eliminó el plan sin tarjeta (Limited) el 31-ago-2025**, ahora requiere datos de facturación aunque no cobra bajo los límites gratuitos.
  - **Waze for Cities (ex Connected Citizens Program):** intercambio de datos gratuito pero **solo para gobiernos/municipios partner** — no es una API abierta para un hackathon. Perú figura como partner (a nivel del MTC), pero no es accesible para ti.
- **Recomendación:** **SIMULAR** el rojo/verde de cada semáforo; opcionalmente alimenta el "tráfico transversal" con **TomTom Traffic Flow** (real) para que la lógica del agente reaccione a congestión real por segmento y la demo se sienta más creíble.

---

## Recommendations
1. **Semáforos (hazlo primero):** ejecuta la query Overpass con el bbox de Lima, exporta a GeoJSON/CSV y publica esas coordenadas en tus canales de Portal. Verifica en overpass-turbo que tu avenida objetivo (ej. Javier Prado o Arequipa) tenga densidad suficiente de nodos antes del sábado.
2. **Hospitales:** usa `amenity=hospital` de OSM vía Overpass para coordenadas limpias e inmediatas; ten `RENIPRESS_31-07-2026.csv` como respaldo oficial con categorías. Si usas RENIPRESS, valida primero cuál columna es lat y cuál long con 2-3 registros conocidos de Lima.
3. **Bases SAMU:** simula bases ancladas a los distritos reales listados por MINSA/prensa; usa los puntos exactos donde existan (Estadio Luis Gálvez Chipoco en Barranco; C.S. El Porvenir en La Victoria).
4. **Ruteo:** decide en la primera hora — OSRM si hay competencia Docker, Mapbox si no. Prueba temprano una ruta real end-to-end (ej. emergencia en San Isidro → hospital más cercano) para descartar sorpresas.
5. **Estado de semáforos:** implementa un simulador de ciclos rojo/verde por nodo; el agente de IA decide cuándo "preparar" cada uno. Si sobra tiempo, integra TomTom Flow para modular los tiempos de ciclo según congestión real.

**Umbrales que cambian estas decisiones:**
- Si la cobertura OSM de `traffic_signals` en tu avenida objetivo es insuficiente (compruébalo en overpass-turbo), cambia de avenida o coloca nodos manuales sobre coordenadas reales de la vía.
- Si el setup de OSRM excede ~2-3 horas de tu presupuesto de 39, abandónalo y pásate a Mapbox Directions.
- Si necesitas superar los límites gratuitos de TomTom (2.500 req/día) durante la demo, reduce la frecuencia de polling o cachea el último snapshot de flujo.

## Caveats
- La cobertura OSM de `traffic_signals` en Lima es colaborativa y **no exhaustiva**; no representa el inventario oficial de Protránsito (415–748 intersecciones centralizadas de ~1.394 semaforizadas).
- Las columnas de coordenadas de RENIPRESS tienen **etiquetado cruzado/ambiguo** (`LONGITUD_NORTE`/`LONGITUD_ESTE`) y son alfanuméricas (posibles celdas vacías); verifica empíricamente lat vs long. No se pudo confirmar celda por celda la cobertura exacta de Lima porque el CSV se sirve como binario grande.
- Los conteos de bases SAMU **varían por fuente y fecha** (22 en mayo 2024, 27 y luego 29 en 2026) y son referencias por distrito, no coordenadas.
- Hay **discrepancia** en el proyecto de semáforos inteligentes: ITS Perú/Protránsito hablan de 426 intersecciones (plan 2023-2027); prensa de marzo 2026 menciona 500 intersecciones y US$150M. No se pudo confirmar la cifra de US$150M en fuente oficial.
- Los **free tiers de las APIs cambian con frecuencia**; los límites citados corresponden a 2025-2026 (TomTom revisa precios en julio 2026; HERE retiró su plan sin tarjeta en agosto 2025; Google reestructuró en marzo 2025). Reconfirma al registrarte.
- Mapbox y Google **prohíben ciertos usos** (cacheo/almacenamiento de resultados, consultas no originadas por interacción humana); para una demo de hackathon son aceptables, pero revisa los términos si el prototipo evoluciona a producción.