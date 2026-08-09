import { describe, expect, test } from "bun:test";
import type { ChannelHandle } from "@portalsdk/core";
import { InterpoladaPosicionSource, RealPosicionSource } from "./posicionSource";
import type { AmbulancePosition } from "./ambulance";
import type { DrivingRoute } from "./directions";
import type { AmbulancePositionPayload } from "@/lib/portal/messages";

const RUTA_CORTA: DrivingRoute = {
  geometry: {
    type: "LineString",
    coordinates: [
      [-77.03, -12.08],
      [-77.02, -12.07],
    ],
  },
  distanceMeters: 1000,
  durationSeconds: 20,
};

// tickMs=10 avanza elapsedSeconds en pasos de 0.01s simulados por tick real — con
// durationSeconds=0.025, "arrived" llega al tercer tick (30ms reales), rápido para un test.
const RUTA_MUY_CORTA: DrivingRoute = { ...RUTA_CORTA, durationSeconds: 0.025 };

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("InterpoladaPosicionSource", () => {
  test("emite la posición inicial de forma síncrona, sin esperar el primer tick", () => {
    const fuente = new InterpoladaPosicionSource(RUTA_CORTA, { tickMs: 10_000 });
    const posiciones: AmbulancePosition[] = [];

    const detener = fuente.suscribir((posicion) => posiciones.push(posicion));

    expect(posiciones).toHaveLength(1);
    expect(posiciones[0]?.arrived).toBe(false);
    detener();
  });

  test("emite posiciones sucesivas por tick y deja de emitir tras llegar", async () => {
    const fuente = new InterpoladaPosicionSource(RUTA_MUY_CORTA, { tickMs: 10 });
    const posiciones: AmbulancePosition[] = [];

    const detener = fuente.suscribir((posicion) => posiciones.push(posicion));
    await esperar(80); // suficiente para pasar los 3 ticks de 10ms que llegan a "arrived"

    detener();
    expect(posiciones.length).toBeGreaterThan(1);
    expect(posiciones[posiciones.length - 1]?.arrived).toBe(true);

    const cantidadAlDetener = posiciones.length;
    await esperar(30);
    expect(posiciones).toHaveLength(cantidadAlDetener); // no siguen llegando ticks tras "arrived"
  });

  test("detener() antes de llegar corta los ticks futuros", async () => {
    const fuente = new InterpoladaPosicionSource(RUTA_CORTA, { tickMs: 10 });
    const posiciones: AmbulancePosition[] = [];

    const detener = fuente.suscribir((posicion) => posiciones.push(posicion));
    detener();
    const cantidadAlDetener = posiciones.length;

    await esperar(50);
    expect(posiciones).toHaveLength(cantidadAlDetener);
  });

  // Issue #20/#21: patrullaje de una unidad de flota libre — recorre la misma ruta ida y
  // vuelta indefinidamente en vez de terminar al llegar al extremo.
  test("con loop:true, sigue emitiendo después de pasar el extremo de la ruta, sin reportar arrived", async () => {
    const fuente = new InterpoladaPosicionSource(RUTA_MUY_CORTA, { tickMs: 10, loop: true });
    const posiciones: AmbulancePosition[] = [];

    const detener = fuente.suscribir((posicion) => posiciones.push(posicion));
    await esperar(80); // de sobra para pasar los ~3 ticks que agotarían una ruta no-loop

    detener();
    expect(posiciones.length).toBeGreaterThan(3);
    expect(posiciones.every((p) => p.arrived === false)).toBe(true);
  });

  test("con loop:true, rebota: avanza hasta el extremo y vuelve por la misma ruta", async () => {
    const fuente = new InterpoladaPosicionSource(RUTA_MUY_CORTA, { tickMs: 10, loop: true });
    const lngs: number[] = [];

    const detener = fuente.suscribir((posicion) => lngs.push(posicion.lng));
    await esperar(80);
    detener();

    const maxLng = Math.max(...lngs);
    const indiceMax = lngs.indexOf(maxLng);
    expect(indiceMax).toBeGreaterThan(0); // no arrancó ya en el extremo
    expect(indiceMax).toBeLessThan(lngs.length - 1); // hay puntos después del extremo (volviendo)
    expect(lngs[lngs.length - 1]).toBeLessThan(maxLng); // el último punto ya viene de vuelta
  });
});

describe("RealPosicionSource", () => {
  function crearCanalFake() {
    const listeners: ((msg: { content: AmbulancePositionPayload }) => void)[] = [];
    const canal = {
      on: (_event: "message", fn: (msg: { content: AmbulancePositionPayload }) => void) => {
        listeners.push(fn);
        return () => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      emitir: (content: AmbulancePositionPayload) => {
        for (const fn of listeners) fn({ content });
      },
    };
    return canal as unknown as ChannelHandle<AmbulancePositionPayload> & { emitir: typeof canal.emitir };
  }

  test("reenvía cada mensaje del canal tal cual, sin timer propio", () => {
    const canal = crearCanalFake();
    const fuente = new RealPosicionSource(canal);
    const posiciones: AmbulancePositionPayload[] = [];

    fuente.suscribir((posicion) => posiciones.push(posicion as AmbulancePositionPayload));
    canal.emitir({ ambulanceId: "amb-real-1", lat: -12.08, lng: -77.03, arrived: false });
    canal.emitir({ ambulanceId: "amb-real-1", lat: -12.079, lng: -77.029, arrived: false });

    expect(posiciones).toEqual([
      { lat: -12.08, lng: -77.03, arrived: false, ambulanceId: "amb-real-1" },
      { lat: -12.079, lng: -77.029, arrived: false, ambulanceId: "amb-real-1" },
    ]);
  });

  test("detener() deja de reenviar mensajes nuevos", () => {
    const canal = crearCanalFake();
    const fuente = new RealPosicionSource(canal);
    const posiciones: AmbulancePosition[] = [];

    const detener = fuente.suscribir((posicion) => posiciones.push(posicion));
    canal.emitir({ ambulanceId: "amb-real-1", lat: -12.08, lng: -77.03, arrived: false });
    detener();
    canal.emitir({ ambulanceId: "amb-real-1", lat: -12.079, lng: -77.029, arrived: false });

    expect(posiciones).toHaveLength(1);
  });
});
