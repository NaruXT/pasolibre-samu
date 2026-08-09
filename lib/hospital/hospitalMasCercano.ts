import { distance } from "@turf/distance";
import type { DrivingRoute, LngLat } from "@/lib/mapbox/directions";
import type { HospitalFijo } from "./hospitalesSanBorjaYColindantes";

/** Cuántos candidatos por línea recta se llevan a ruta real — evita pedirle a Mapbox los 20. */
const PRESELECCION_TOP_K = 5;

export interface HospitalMasCercanoResultado {
  hospitalId: string;
  nombre: string;
  lng: number;
  lat: number;
  ruta: DrivingRoute;
}

export interface HospitalMasCercanoDeps {
  /** Frontera de I/O real (Mapbox Directions) — inyectada para no gastar cuota en tests. */
  obtenerRuta: (origen: LngLat, destino: LngLat) => Promise<DrivingRoute>;
}

/**
 * Hospital más cercano a `origen` por duración de **ruta real** (Mapbox Directions), no línea
 * recta — decisión explícita del issue #12. Preselecciona los `topK` candidatos más cercanos
 * por haversine (barato, local) antes de pedir ruta real a cada uno, para no gastar una llamada
 * a Mapbox por cada hospital del dataset. No excluye ningún hospital por `especialidad` — a
 * pedido explícito del usuario, a diferencia de lo que sugería el issue original sobre excluir
 * pediátricos-only.
 *
 * Si algún candidato falla al pedir ruta (red, Mapbox no-200), se descarta y se compara contra
 * los que sí respondieron — solo lanza si **todos** los candidatos preseleccionados fallan.
 */
export async function hospitalMasCercano(
  origen: LngLat,
  dataset: readonly HospitalFijo[],
  deps: HospitalMasCercanoDeps,
  topK: number = PRESELECCION_TOP_K
): Promise<HospitalMasCercanoResultado> {
  if (dataset.length === 0) {
    throw new Error("hospitalMasCercano: el dataset de hospitales está vacío.");
  }

  const candidatos = [...dataset]
    .sort((a, b) => distanciaHaversineMetros(origen, a) - distanciaHaversineMetros(origen, b))
    .slice(0, topK);

  const intentos = await Promise.allSettled(
    candidatos.map(async (hospital) => ({
      hospital,
      ruta: await deps.obtenerRuta(origen, { lng: hospital.lng, lat: hospital.lat }),
    }))
  );

  const exitosos = intentos.flatMap((intento) => (intento.status === "fulfilled" ? [intento.value] : []));

  if (exitosos.length === 0) {
    throw new Error(
      `hospitalMasCercano: no se pudo obtener ruta real a ninguno de los ${candidatos.length} candidatos preseleccionados.`
    );
  }

  const mejor = exitosos.reduce((min, actual) =>
    actual.ruta.durationSeconds < min.ruta.durationSeconds ? actual : min
  );

  return {
    hospitalId: mejor.hospital.hospitalId,
    nombre: mejor.hospital.nombre,
    lng: mejor.hospital.lng,
    lat: mejor.hospital.lat,
    ruta: mejor.ruta,
  };
}

function distanciaHaversineMetros(a: LngLat, b: LngLat): number {
  return distance([a.lng, a.lat], [b.lng, b.lat], { units: "meters" });
}
