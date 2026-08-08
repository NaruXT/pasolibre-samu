import { distance } from "@turf/distance";

export interface LngLat {
  lng: number;
  lat: number;
}

/**
 * ETA en segundos de `origen` a `destino` en línea recta (haversine), a velocidad constante.
 * Función pura — sin llamadas de red — para que el seam de orquestación (ticket #7) la
 * ejecute de verdad en los tests, no como un doble de prueba.
 */
export function calcularETASegundos(
  origen: LngLat,
  destino: LngLat,
  velocidadMetrosPorSegundo: number
): number {
  if (velocidadMetrosPorSegundo <= 0) return Number.POSITIVE_INFINITY;

  const distanciaMetros = distance([origen.lng, origen.lat], [destino.lng, destino.lat], {
    units: "meters",
  });
  return distanciaMetros / velocidadMetrosPorSegundo;
}
