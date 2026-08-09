import { distance } from "@turf/distance";
import type { LngLat } from "@/lib/mapbox/directions";

/**
 * Distancia en línea recta (haversine) — usada solo para preseleccionar candidatos baratos
 * antes de pedir ruta real a Mapbox (`hospitalMasCercano`, `unidadLibreMasCercana`), nunca como
 * criterio final de "más cercano" (ver esas funciones para el motivo). Extraída acá tras
 * aparecer una tercera copia idéntica en el mismo diff (code-review, issue #20/#23).
 */
export function distanciaHaversineMetros(a: LngLat, b: LngLat): number {
  return distance([a.lng, a.lat], [b.lng, b.lat], { units: "meters" });
}
