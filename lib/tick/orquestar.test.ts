import { describe, expect, test } from "bun:test";
import { orquestarTick, type OrquestarTickDeps } from "./orquestar";
import type { AccionSemaforo, DecisionSemaforo, DecisionSemaforoPublicada } from "./decision";

const DECISION_FAKE: Omit<DecisionSemaforo, "semaforoId"> = {
  accion: "mantener_ciclo",
  explicacion: "Decisión de prueba — doble en memoria, no invoca al LLM real (ticket #8).",
};

const AMBULANCE_ID = "amb-1";
const OTRA_AMBULANCE_ID = "amb-2";

// Claves "semaforoId:ambulanceId" — imita cómo `serverReader.ts` escopa por ambos campos.
function crearDepsFake(accionesPreviasPorClave: Record<string, AccionSemaforo[]> = {}) {
  const decisionesPublicadas: DecisionSemaforoPublicada[] = [];
  const deps: OrquestarTickDeps = {
    obtenerAccionesPrevias: async (semaforoId, ambulanceId) =>
      accionesPreviasPorClave[`${semaforoId}:${ambulanceId}`] ?? [],
    publicarDecision: async (decision) => {
      decisionesPublicadas.push(decision);
    },
    decidirAccion: async (contexto) => ({ semaforoId: contexto.semaforoId, ...DECISION_FAKE }),
    obtenerCongestionTransversal: async () => null,
    ahoraSegundos: () => 45, // fijo, para que la fase física sea determinística en los tests
  };
  return { deps, decisionesPublicadas };
}

const AMBULANCIA_LEJOS = { lng: -77.0, lat: -12.0, velocidadMetrosPorSegundo: 10 };
const SEMAFORO_LEJOS = { semaforoId: "sem-lejos", lng: -77.0, lat: -11.0 }; // ~111km, ETA >> 60s

// 0.0009° de latitud ≈ 100m (1° ≈ 111.2km) → a 10 m/s, ETA ≈ 10s, dentro de la ventana de 60s.
const AMBULANCIA_CERCA = { lng: -77.0, lat: -12.0, velocidadMetrosPorSegundo: 10 };
const SEMAFORO_CERCA = { semaforoId: "sem-cerca", lng: -77.0, lat: -12.0 + 0.0009 };

describe("orquestarTick", () => {
  test("semáforo fuera de la ventana de decisión: no invoca ni publica", async () => {
    const { deps, decisionesPublicadas } = crearDepsFake();

    const resultados = await orquestarTick(
      {
        ambulanceId: AMBULANCE_ID,
        posicionAmbulancia: AMBULANCIA_LEJOS,
        semaforosPendientes: [SEMAFORO_LEJOS],
      },
      deps
    );

    expect(resultados[0]?.decision).toBeNull();
    expect(decisionesPublicadas).toHaveLength(0);
  });

  test("semáforo dentro de la ventana sin decisión previa: invoca y publica una vez", async () => {
    const { deps, decisionesPublicadas } = crearDepsFake();

    const resultados = await orquestarTick(
      {
        ambulanceId: AMBULANCE_ID,
        posicionAmbulancia: AMBULANCIA_CERCA,
        semaforosPendientes: [SEMAFORO_CERCA],
      },
      deps
    );

    const decisionEsperada: DecisionSemaforo = { semaforoId: "sem-cerca", ...DECISION_FAKE };
    expect(resultados[0]?.decision).toEqual(decisionEsperada);
    expect(decisionesPublicadas).toEqual([{ ...decisionEsperada, ambulanceId: AMBULANCE_ID }]);
  });

  test("semáforo dentro de la ventana con decisión ya publicada: no reinvoca", async () => {
    const { deps, decisionesPublicadas } = crearDepsFake({
      "sem-cerca:amb-1": ["mantener_ciclo"],
    });

    const resultados = await orquestarTick(
      {
        ambulanceId: AMBULANCE_ID,
        posicionAmbulancia: AMBULANCIA_CERCA,
        semaforosPendientes: [SEMAFORO_CERCA],
      },
      deps
    );

    expect(resultados[0]?.decision).toBeNull();
    expect(decisionesPublicadas).toHaveLength(0);
  });

  test("issue #12/#14: una decisión previa de OTRA ambulancia para el mismo semáforo no suprime la decisión de esta", async () => {
    const { deps, decisionesPublicadas } = crearDepsFake({
      "sem-cerca:amb-1": ["mantener_ciclo"],
    });

    const resultados = await orquestarTick(
      {
        ambulanceId: OTRA_AMBULANCE_ID,
        posicionAmbulancia: AMBULANCIA_CERCA,
        semaforosPendientes: [SEMAFORO_CERCA],
      },
      deps
    );

    expect(resultados[0]?.decision).not.toBeNull();
    expect(decisionesPublicadas).toEqual([
      { semaforoId: "sem-cerca", ...DECISION_FAKE, ambulanceId: OTRA_AMBULANCE_ID },
    ]);
  });

  test("reconstruye la fase efectiva a partir de una decisión previa de anticipar_verde", async () => {
    const { deps } = crearDepsFake({ "sem-cerca:amb-1": ["anticipar_verde"] });

    const resultados = await orquestarTick(
      {
        ambulanceId: AMBULANCE_ID,
        posicionAmbulancia: AMBULANCIA_CERCA,
        semaforosPendientes: [SEMAFORO_CERCA],
      },
      deps
    );

    // ahoraSegundos() está fijo en 45 en el fake — verde/rojo físico depende del offset del id,
    // pero la intervención previa debe forzar verde sin importar qué diga el ciclo físico.
    expect(resultados[0]?.fase).toEqual({ fase: "verde", segundosRestantes: Infinity });
  });

  test("reconstruye la fase efectiva a partir de una decisión previa de extender_verde", async () => {
    const { deps } = crearDepsFake({ "sem-cerca:amb-1": ["extender_verde"] });

    const resultados = await orquestarTick(
      {
        ambulanceId: AMBULANCE_ID,
        posicionAmbulancia: AMBULANCIA_CERCA,
        semaforosPendientes: [SEMAFORO_CERCA],
      },
      deps
    );

    expect(resultados[0]?.fase).toEqual({ fase: "verde", segundosRestantes: Infinity });
  });

  test("el agente recibe semaforoId, ETA y la fase (con segundosRestantes) del semáforo", async () => {
    const { deps, decisionesPublicadas } = crearDepsFake();
    const contextosRecibidos: unknown[] = [];
    deps.decidirAccion = async (contexto) => {
      contextosRecibidos.push(contexto);
      return { semaforoId: contexto.semaforoId, ...DECISION_FAKE };
    };

    await orquestarTick(
      {
        ambulanceId: AMBULANCE_ID,
        posicionAmbulancia: AMBULANCIA_CERCA,
        semaforosPendientes: [SEMAFORO_CERCA],
      },
      deps
    );

    expect(contextosRecibidos).toHaveLength(1);
    const contexto = contextosRecibidos[0] as {
      semaforoId: string;
      etaSegundos: number;
      fase: { fase: "rojo" | "verde"; segundosRestantes: number };
    };
    expect(contexto.semaforoId).toBe("sem-cerca");
    expect(contexto.etaSegundos).toBeGreaterThan(0);
    expect(contexto.etaSegundos).toBeLessThanOrEqual(60);
    expect(["rojo", "verde"]).toContain(contexto.fase.fase);
    expect(typeof contexto.fase.segundosRestantes).toBe("number");
    expect(decisionesPublicadas).toHaveLength(1);
  });

  test("el agente recibe la congestión transversal de TomTom en el contexto (ticket #10)", async () => {
    const { deps } = crearDepsFake();
    deps.obtenerCongestionTransversal = async () => ({
      currentSpeedKmph: 15,
      freeFlowSpeedKmph: 50,
      nivel: "congestionado",
    });
    let contextoRecibido: { congestionTransversal?: unknown } | undefined;
    deps.decidirAccion = async (contexto) => {
      contextoRecibido = contexto;
      return { semaforoId: contexto.semaforoId, ...DECISION_FAKE };
    };

    await orquestarTick(
      {
        ambulanceId: AMBULANCE_ID,
        posicionAmbulancia: AMBULANCIA_CERCA,
        semaforosPendientes: [SEMAFORO_CERCA],
      },
      deps
    );

    expect(contextoRecibido?.congestionTransversal).toEqual({
      currentSpeedKmph: 15,
      freeFlowSpeedKmph: 50,
      nivel: "congestionado",
    });
  });

  test("TomTom solo se consulta cuando el semáforo entra en ventana de decisión (ticket #10)", async () => {
    const { deps } = crearDepsFake();
    let llamadas = 0;
    deps.obtenerCongestionTransversal = async () => {
      llamadas++;
      return null;
    };

    await orquestarTick(
      {
        ambulanceId: AMBULANCE_ID,
        posicionAmbulancia: AMBULANCIA_LEJOS,
        semaforosPendientes: [SEMAFORO_LEJOS],
      },
      deps
    );
    expect(llamadas).toBe(0);

    await orquestarTick(
      {
        ambulanceId: AMBULANCE_ID,
        posicionAmbulancia: AMBULANCIA_CERCA,
        semaforosPendientes: [SEMAFORO_CERCA],
      },
      deps
    );
    expect(llamadas).toBe(1);
  });

  test("TomTom no se re-consulta si el semáforo ya tiene decisión publicada (ticket #10)", async () => {
    const { deps } = crearDepsFake({ "sem-cerca:amb-1": ["mantener_ciclo"] });
    let llamadas = 0;
    deps.obtenerCongestionTransversal = async () => {
      llamadas++;
      return null;
    };

    await orquestarTick(
      {
        ambulanceId: AMBULANCE_ID,
        posicionAmbulancia: AMBULANCIA_CERCA,
        semaforosPendientes: [SEMAFORO_CERCA],
      },
      deps
    );

    expect(llamadas).toBe(0);
  });
});
