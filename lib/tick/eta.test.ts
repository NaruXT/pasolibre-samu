import { describe, expect, test } from "bun:test";
import { calcularETASegundos } from "./eta";

describe("calcularETASegundos", () => {
  test("origen y destino iguales dan ETA 0", () => {
    const punto = { lng: -77.03, lat: -12.08 };
    expect(calcularETASegundos(punto, punto, 10)).toBe(0);
  });

  // 1 grado de latitud ≈ 111.2 km es un hecho geográfico bien conocido, independiente de
  // turf/@turf/distance — no se deriva llamando al código bajo prueba.
  test("un grado de latitud (~111.2km) a 10 m/s da ~11120s de ETA", () => {
    const origen = { lng: -77.0, lat: -12.0 };
    const destino = { lng: -77.0, lat: -11.0 };
    expect(calcularETASegundos(origen, destino, 10)).toBeCloseTo(11120, -2);
  });

  test("velocidad cero o negativa da ETA infinita en vez de dividir por cero", () => {
    const origen = { lng: -77.0, lat: -12.0 };
    const destino = { lng: -77.01, lat: -12.01 };
    expect(calcularETASegundos(origen, destino, 0)).toBe(Infinity);
    expect(calcularETASegundos(origen, destino, -5)).toBe(Infinity);
  });
});
