import { distance } from "@turf/distance";
import type { LngLat } from "@/lib/mapbox/directions";

/**
 * Radio para considerar dos semáforos parte de la misma intersección física. Medido contra el
 * dataset real (ticket #9): un cruce típico de varios accesos separa sus nodos OSM entre sí
 * ~18-46m (verificado con el cruce real Av. Rebagliati / Salaverry, 4 nodos). 50m da margen sin
 * llegar a alcanzar la siguiente cuadra (las cuadras arteriales de Lima rondan 80-150m). El
 * dataset nunca verificó qué calle cruza en cada nodo (fuera de alcance, ver CLAUDE.md) — esto
 * es una aproximación geográfica a "misma intersección", no una verificación real de topología.
 */
export const RADIO_INTERSECCION_METROS = 50;

export interface SemaforoConPosicion extends LngLat {
  semaforoId: string;
}

/**
 * De `semaforos`, los que están a `radioMetros` o menos de `semaforo` (excluyéndolo a él
 * mismo) — candidatos a "misma intersección física" para la salvaguarda de cruce (ver
 * `orquestarTick`): si uno se fuerza a verde para la ambulancia, sus vecinos deben forzarse a
 * rojo para que el tránsito transversal no se cruce en su camino.
 */
export function semaforosVecinos(
  semaforo: SemaforoConPosicion,
  semaforos: readonly SemaforoConPosicion[],
  radioMetros: number = RADIO_INTERSECCION_METROS
): SemaforoConPosicion[] {
  return semaforos.filter((otro) => {
    if (otro.semaforoId === semaforo.semaforoId) return false;
    const metros = distance([semaforo.lng, semaforo.lat], [otro.lng, otro.lat], {
      units: "meters",
    });
    return metros <= radioMetros;
  });
}