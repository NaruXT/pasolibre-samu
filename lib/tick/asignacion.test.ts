import { describe, expect, test } from "bun:test";
import { unidadLibreMasCercana, type CandidatoUnidadLibre, type UnidadLibreMasCercanaDeps } from "./asignacion";
import type { DrivingRoute, LngLat } from "@/lib/mapbox/directions";

const RUTA_FAKE: Omit<DrivingRoute, "durationSeconds"> = {
  geometry: { type: "LineString", coordinates: [] },
  distanceMeters: 1000,
};

function crearDepsFake(duracionPorAmbulanceId: Record<string, number>): UnidadLibreMasCercanaDeps {
  return {
    obtenerRuta: async (origen) => ({
      ...RUTA_FAKE,
      durationSeconds: duracionPorAmbulanceId[claveOrigen(origen)] ?? Infinity,
    }),
  };
}

// Las claves de `duracionPorAmbulanceId` en los tests se indexan por lng,lat de la unidad
// origen (única forma de identificar qué candidato generó la llamada, ya que `obtenerRuta`
// no recibe el ambulanceId directamente — igual que `hospitalMasCercano.test.ts`).
function claveOrigen(origen: LngLat): string {
  return `${origen.lng},${origen.lat}`;
}

const PUNTO_LLAMADA: LngLat = { lng: -77.03, lat: -12.08 };

const CERCANA_EN_LINEA_RECTA: CandidatoUnidadLibre = {
  ambulanceId: "amb-cercana",
  posicionActual: { lng: -77.031, lat: -12.081 },
};

const LEJOS_EN_LINEA_RECTA_PERO_RUTA_RAPIDA: CandidatoUnidadLibre = {
  ambulanceId: "amb-lejos-pero-rapida",
  posicionActual: { lng: -77.05, lat: -12.1 },
};

describe("unidadLibreMasCercana", () => {
  test("gana el candidato con menor duración de ruta real, aunque otro esté más cerca en línea recta", async () => {
    const deps = crearDepsFake({
      [claveOrigen(CERCANA_EN_LINEA_RECTA.posicionActual)]: 600,
      [claveOrigen(LEJOS_EN_LINEA_RECTA_PERO_RUTA_RAPIDA.posicionActual)]: 120,
    });

    const resultado = await unidadLibreMasCercana(
      PUNTO_LLAMADA,
      [CERCANA_EN_LINEA_RECTA, LEJOS_EN_LINEA_RECTA_PERO_RUTA_RAPIDA],
      deps
    );

    expect(resultado.ambulanceId).toBe("amb-lejos-pero-rapida");
    expect(resultado.ruta.durationSeconds).toBe(120);
  });

  test("descarta candidatos cuya ruta real falla y elige entre los que sí respondieron", async () => {
    const deps: UnidadLibreMasCercanaDeps = {
      obtenerRuta: async (origen) => {
        if (origen.lng === CERCANA_EN_LINEA_RECTA.posicionActual.lng) {
          throw new Error("Mapbox Directions request failed (500).");
        }
        return { ...RUTA_FAKE, durationSeconds: 300 };
      },
    };

    const resultado = await unidadLibreMasCercana(
      PUNTO_LLAMADA,
      [CERCANA_EN_LINEA_RECTA, LEJOS_EN_LINEA_RECTA_PERO_RUTA_RAPIDA],
      deps
    );

    expect(resultado.ambulanceId).toBe("amb-lejos-pero-rapida");
  });

  test("lanza si todos los candidatos preseleccionados fallan", async () => {
    const deps: UnidadLibreMasCercanaDeps = {
      obtenerRuta: async () => {
        throw new Error("Mapbox Directions request failed (500).");
      },
    };

    await expect(unidadLibreMasCercana(PUNTO_LLAMADA, [CERCANA_EN_LINEA_RECTA], deps)).rejects.toThrow();
  });

  test("preselecciona solo topK candidatos por línea recta antes de pedir ruta real", async () => {
    const candidatos: CandidatoUnidadLibre[] = Array.from({ length: 10 }, (_, i) => ({
      ambulanceId: `amb-${i}`,
      posicionActual: { lng: PUNTO_LLAMADA.lng + i * 0.01, lat: PUNTO_LLAMADA.lat + i * 0.01 },
    }));

    const llamadas: LngLat[] = [];
    const deps: UnidadLibreMasCercanaDeps = {
      obtenerRuta: async (origen) => {
        llamadas.push(origen);
        return { ...RUTA_FAKE, durationSeconds: 100 };
      },
    };

    await unidadLibreMasCercana(PUNTO_LLAMADA, candidatos, deps, 3);

    expect(llamadas).toHaveLength(3);
  });

  test("lanza si no hay candidatos", async () => {
    const deps: UnidadLibreMasCercanaDeps = { obtenerRuta: async () => ({ ...RUTA_FAKE, durationSeconds: 1 }) };
    await expect(unidadLibreMasCercana(PUNTO_LLAMADA, [], deps)).rejects.toThrow();
  });
});
