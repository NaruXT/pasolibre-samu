import { describe, expect, test } from "bun:test";
import { hospitalMasCercano, type HospitalMasCercanoDeps } from "./hospitalMasCercano";
import type { HospitalFijo } from "./hospitalesSanBorjaYColindantes";
import type { DrivingRoute, LngLat } from "@/lib/mapbox/directions";

const RUTA_FAKE: Omit<DrivingRoute, "durationSeconds"> = {
  geometry: { type: "LineString", coordinates: [] },
  distanceMeters: 1000,
};

function crearDepsFake(duracionPorHospitalId: Record<string, number>): HospitalMasCercanoDeps {
  return {
    obtenerRuta: async (_origen, destino) => ({
      ...RUTA_FAKE,
      durationSeconds: duracionPorHospitalId[claveDestino(destino)] ?? Infinity,
    }),
  };
}

// Las claves de `duracionPorHospitalId` en los tests se indexan por lng,lat del hospital destino.
function claveDestino(destino: LngLat): string {
  return `${destino.lng},${destino.lat}`;
}

const ORIGEN: LngLat = { lng: -77.03, lat: -12.08 };

const CERCANO_EN_LINEA_RECTA: HospitalFijo = {
  hospitalId: "way/cercano",
  nombre: "Cercano en línea recta",
  lng: -77.031,
  lat: -12.081,
  zona: "Test",
  especialidad: null,
};

const LEJOS_EN_LINEA_RECTA_PERO_RUTA_RAPIDA: HospitalFijo = {
  hospitalId: "way/lejos-pero-rapido",
  nombre: "Lejos en línea recta, ruta real más rápida",
  lng: -77.05,
  lat: -12.1,
  zona: "Test",
  especialidad: null,
};

const PEDIATRICO_MAS_CERCANO: HospitalFijo = {
  hospitalId: "way/pediatrico",
  nombre: "Pediátrico más cercano",
  lng: -77.0301,
  lat: -12.0801,
  zona: "Test",
  especialidad: "paediatrics",
};

describe("hospitalMasCercano", () => {
  test("gana el candidato con menor duración de ruta real, aunque otro esté más cerca en línea recta", async () => {
    const deps = crearDepsFake({
      [claveDestino(CERCANO_EN_LINEA_RECTA)]: 600,
      [claveDestino(LEJOS_EN_LINEA_RECTA_PERO_RUTA_RAPIDA)]: 120,
    });

    const resultado = await hospitalMasCercano(
      ORIGEN,
      [CERCANO_EN_LINEA_RECTA, LEJOS_EN_LINEA_RECTA_PERO_RUTA_RAPIDA],
      deps
    );

    expect(resultado.hospitalId).toBe("way/lejos-pero-rapido");
    expect(resultado.ruta.durationSeconds).toBe(120);
  });

  test("no excluye hospitales por especialidad (ej. pediátrico-only) — decisión explícita del issue #12", async () => {
    const deps = crearDepsFake({ [claveDestino(PEDIATRICO_MAS_CERCANO)]: 90 });

    const resultado = await hospitalMasCercano(ORIGEN, [PEDIATRICO_MAS_CERCANO], deps);

    expect(resultado.hospitalId).toBe("way/pediatrico");
  });

  test("descarta candidatos cuya ruta real falla y elige entre los que sí respondieron", async () => {
    const deps: HospitalMasCercanoDeps = {
      obtenerRuta: async (_origen, destino) => {
        if (destino.lng === CERCANO_EN_LINEA_RECTA.lng) {
          throw new Error("Mapbox Directions request failed (500).");
        }
        return { ...RUTA_FAKE, durationSeconds: 300 };
      },
    };

    const resultado = await hospitalMasCercano(
      ORIGEN,
      [CERCANO_EN_LINEA_RECTA, LEJOS_EN_LINEA_RECTA_PERO_RUTA_RAPIDA],
      deps
    );

    expect(resultado.hospitalId).toBe("way/lejos-pero-rapido");
  });

  test("lanza si todos los candidatos preseleccionados fallan", async () => {
    const deps: HospitalMasCercanoDeps = {
      obtenerRuta: async () => {
        throw new Error("Mapbox Directions request failed (500).");
      },
    };

    await expect(hospitalMasCercano(ORIGEN, [CERCANO_EN_LINEA_RECTA], deps)).rejects.toThrow();
  });

  test("preselecciona solo topK candidatos por línea recta antes de pedir ruta real", async () => {
    const dataset: HospitalFijo[] = Array.from({ length: 10 }, (_, i) => ({
      hospitalId: `way/${i}`,
      nombre: `Hospital ${i}`,
      lng: ORIGEN.lng + i * 0.01,
      lat: ORIGEN.lat + i * 0.01,
      zona: "Test",
      especialidad: null,
    }));

    const llamadas: LngLat[] = [];
    const deps: HospitalMasCercanoDeps = {
      obtenerRuta: async (_origen, destino) => {
        llamadas.push(destino);
        return { ...RUTA_FAKE, durationSeconds: 100 };
      },
    };

    await hospitalMasCercano(ORIGEN, dataset, deps, 3);

    expect(llamadas).toHaveLength(3);
  });

  test("lanza si el dataset está vacío", async () => {
    const deps: HospitalMasCercanoDeps = { obtenerRuta: async () => ({ ...RUTA_FAKE, durationSeconds: 1 }) };
    await expect(hospitalMasCercano(ORIGEN, [], deps)).rejects.toThrow();
  });
});
