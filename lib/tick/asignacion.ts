import type { DrivingRoute, LngLat } from "@/lib/mapbox/directions";
import { distanciaHaversineMetros } from "@/lib/geo/haversine";

/** Cuántos candidatos por línea recta se llevan a ruta real — evita pedirle a Mapbox todas las unidades libres. */
const PRESELECCION_TOP_K = 3;

export interface CandidatoUnidadLibre {
  ambulanceId: string;
  posicionActual: LngLat;
}

export interface UnidadLibreMasCercanaResultado {
  ambulanceId: string;
  ruta: DrivingRoute;
}

export interface UnidadLibreMasCercanaDeps {
  /** Frontera de I/O real (Mapbox Directions) — inyectada para no gastar cuota en tests. */
  obtenerRuta: (origen: LngLat, destino: LngLat) => Promise<DrivingRoute>;
}

/**
 * Unidad de flota libre más cercana a `puntoLlamada` por duración de **ruta real** (Mapbox
 * Directions), no línea recta (issue #20/#23, AC de #23) — mismo algoritmo que
 * `lib/hospital/hospitalMasCercano.ts` (preselección por haversine antes de gastar llamadas a
 * Mapbox, gana menor duración real, descarta fallos individuales) pero con forma de dominio
 * distinta (unidades de flota, no hospitales). Deliberadamente no fusionada con esa función:
 * dominios distintos, y tocar código ya shippeado por un segundo caso de uso no cumple la
 * regla de tres — si aparece un tercer "más cercano por ruta real", vale la pena generalizar.
 *
 * Esta función es puramente de SELECCIÓN — no reserva ni libera nada en `__flotaActiva`. La
 * reserva síncrona (issue #20/#23, R2) es responsabilidad de quien la llama
 * (`asignarLlamadaEmergencia` en `lib/tick/flota.ts`), antes de invocar esta función.
 *
 * Si algún candidato falla al pedir ruta (red, Mapbox no-200), se descarta y se compara contra
 * los que sí respondieron — solo lanza si **todos** los candidatos preseleccionados fallan.
 */
export async function unidadLibreMasCercana(
  puntoLlamada: LngLat,
  candidatos: readonly CandidatoUnidadLibre[],
  deps: UnidadLibreMasCercanaDeps,
  topK: number = PRESELECCION_TOP_K
): Promise<UnidadLibreMasCercanaResultado> {
  if (candidatos.length === 0) {
    throw new Error("unidadLibreMasCercana: no hay ninguna unidad candidata.");
  }

  const preseleccionados = [...candidatos]
    .sort(
      (a, b) =>
        distanciaHaversineMetros(puntoLlamada, a.posicionActual) -
        distanciaHaversineMetros(puntoLlamada, b.posicionActual)
    )
    .slice(0, topK);

  const intentos = await Promise.allSettled(
    preseleccionados.map(async (candidato) => ({
      ambulanceId: candidato.ambulanceId,
      ruta: await deps.obtenerRuta(candidato.posicionActual, puntoLlamada),
    }))
  );

  const exitosos = intentos.flatMap((intento) => (intento.status === "fulfilled" ? [intento.value] : []));

  if (exitosos.length === 0) {
    throw new Error(
      `unidadLibreMasCercana: no se pudo obtener ruta real a ninguna de las ${preseleccionados.length} unidades candidatas preseleccionadas.`
    );
  }

  return exitosos.reduce((min, actual) => (actual.ruta.durationSeconds < min.ruta.durationSeconds ? actual : min));
}
