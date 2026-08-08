import { describe, expect, test } from "bun:test";
import type { LineString } from "geojson";
import { semaforosEnRuta } from "./semaforosEnRuta";
import type { SemaforoFijo } from "./semaforosSanBorjaYColindantes";

// Ruta recta este-oeste a latitud constante -12.1 — a esta latitud, un punto con la misma
// latitud cae exactamente sobre la ruta (distancia perpendicular ≈ 0), lo que simplifica los
// fixtures. Valores de distancia/progreso verificados aparte con turf, no a mano.
const RUTA_RECTA: LineString = {
  type: "LineString",
  coordinates: [
    [-77.05, -12.1],
    [-77.0, -12.1],
  ],
};

describe("semaforosEnRuta", () => {
  test("descarta los semáforos fuera del buffer y ordena los que quedan por progreso, no por el orden del dataset", () => {
    const dataset: SemaforoFijo[] = [
      { semaforoId: "cerca-al-final", lng: -77.01, lat: -12.1, zona: "" }, // progreso ~4349m
      { semaforoId: "lejos-de-la-ruta", lng: -77.03, lat: -12.2, zona: "" }, // ~11.1km de la ruta
      { semaforoId: "cerca-al-inicio", lng: -77.04, lat: -12.1, zona: "" }, // progreso ~1087m
    ];

    const resultado = semaforosEnRuta(dataset, RUTA_RECTA, 70);

    expect(resultado.map((s) => s.semaforoId)).toEqual(["cerca-al-inicio", "cerca-al-final"]);
  });

  test("un buffer más chico descarta un semáforo que sí pasaba con uno más grande", () => {
    const dataset: SemaforoFijo[] = [
      { semaforoId: "a-39m-de-la-ruta", lng: -77.025, lat: -12.10035, zona: "" },
    ];

    expect(semaforosEnRuta(dataset, RUTA_RECTA, 70).map((s) => s.semaforoId)).toEqual([
      "a-39m-de-la-ruta",
    ]);
    expect(semaforosEnRuta(dataset, RUTA_RECTA, 30)).toEqual([]);
  });

  test("preserva semaforoId/lng/lat, sin la zona", () => {
    const dataset: SemaforoFijo[] = [
      { semaforoId: "cerca-al-final", lng: -77.01, lat: -12.1, zona: "zona de prueba" },
    ];

    expect(semaforosEnRuta(dataset, RUTA_RECTA)).toEqual([
      { semaforoId: "cerca-al-final", lng: -77.01, lat: -12.1 },
    ]);
  });

  test("dataset vacío da lista vacía", () => {
    expect(semaforosEnRuta([], RUTA_RECTA)).toEqual([]);
  });
});
