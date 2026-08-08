import { nearestPointOnLine } from "@turf/nearest-point-on-line";
import type { LineString } from "geojson";
import type { LngLat } from "@/lib/mapbox/directions";
import type { SemaforoFijo } from "./semaforosSanBorjaYColindantes";

/** Rango pedido por el ticket #9 (~50-80m); 70m es el punto medio. */
const BUFFER_METROS_DEFAULT = 70;

export interface SemaforoEnRuta extends LngLat {
  semaforoId: string;
}

/**
 * Filtra `dataset` (el corredor fijo de semáforos) a los que caen dentro de `bufferMetros` de
 * `ruta`, ordenados por progreso a lo largo de la ruta (distancia acumulada desde el origen) —
 * no por el orden del dataset. Función pura: la distancia perpendicular a la ruta y el progreso
 * se calculan con `nearestPointOnLine` (turf), sin I/O.
 */
export function semaforosEnRuta(
  dataset: readonly SemaforoFijo[],
  ruta: LineString,
  bufferMetros: number = BUFFER_METROS_DEFAULT
): SemaforoEnRuta[] {
  return dataset
    .map((semaforo) => {
      const puntoMasCercano = nearestPointOnLine(ruta, [semaforo.lng, semaforo.lat], {
        units: "meters",
      });
      return {
        semaforo,
        distanciaALaRuta: puntoMasCercano.properties.pointDistance,
        progreso: puntoMasCercano.properties.totalDistance,
      };
    })
    .filter(({ distanciaALaRuta }) => distanciaALaRuta <= bufferMetros)
    .sort((a, b) => a.progreso - b.progreso)
    .map(({ semaforo }) => ({
      semaforoId: semaforo.semaforoId,
      lng: semaforo.lng,
      lat: semaforo.lat,
    }));
}
