import { describe, expect, test } from "bun:test";
import { orquestarTick, type OrquestarTickDeps } from "./orquestar";
import type { AccionSemaforo, DecisionSemaforo, DecisionSemaforoPublicada } from "./decision";

const DECISION_FAKE: Omit<DecisionSemaforo, "semaforoId"> = {
  accion: "mantener_ciclo",
  explicacion: "Decisión de prueba — doble en memoria, no invoca al LLM real (ticket #8).",
};

const AMBULANCE_ID = "amb-1";
const OTRA_AMBULANCE_ID = "amb-2";

// Claves "semaforoId:tramoId" — imita cómo `serverReader.ts` escopa por ambos campos (issue
// #20/#23: tramoId, no ambulanceId — ver `orquestarTick`).
function crearDepsFake(accionesPreviasPorClave: Record<string, AccionSemaforo[]> = {}) {
  const decisionesPublicadas: DecisionSemaforoPublicada[] = [];
  const deps: OrquestarTickDeps = {
    obtenerAccionesPrevias: async (semaforoId, tramoId) =>
      accionesPreviasPorClave[`${semaforoId}:${tramoId}`] ?? [],
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

// ~33m de SEMAFORO_CERCA (0.0003° de latitud) — dentro del radio de intersección de 50m.
const SEMAFORO_VECINO = { semaforoId: "sem-vecino", lng: -77.0, lat: -12.0 + 0.0009 + 0.0003 };
// ~222m de SEMAFORO_CERCA (0.002°) — fuera del radio de intersección, otra esquina del mapa.
const SEMAFORO_NO_VECINO = { semaforoId: "sem-no-vecino", lng: -77.0, lat: -12.0 + 0.0009 + 0.002 };

// Separación real medida con turf: 594.97m (ETA≈59.5s, dentro de la ventana de decisión) y
// 629.98m (ETA≈63.0s, todavía fuera de SU PROPIA ventana), separados 35.0m entre sí (dentro del
// radio de intersección de 50m) — modela el caso real: el vecino integra el corredor de
// semáforos del trayecto entero (`semaforosEnRuta`, fijo por viaje) desde el principio, pero su
// propio ETA recién entra en ventana un poco más tarde que el del semáforo que abre primero.
const SEMAFORO_INTERSECCION_ABIERTO = {
  semaforoId: "sem-interseccion-abierto",
  lng: -77.0,
  lat: -12.0 + 0.0053507,
};
const SEMAFORO_INTERSECCION_VECINO_LEJOS = {
  semaforoId: "sem-interseccion-vecino-lejos",
  lng: -77.0,
  lat: -12.0 + 0.0056655,
};

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
    expect(decisionesPublicadas).toEqual([
      { ...decisionEsperada, ambulanceId: AMBULANCE_ID, tramoId: AMBULANCE_ID },
    ]);
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
      { semaforoId: "sem-cerca", ...DECISION_FAKE, ambulanceId: OTRA_AMBULANCE_ID, tramoId: OTRA_AMBULANCE_ID },
    ]);
  });

  test("issue #20/#23: mismo ambulanceId, tramoId distinto (unidad de flota en su 2da llamada) — no se suprime la decisión", async () => {
    const { deps, decisionesPublicadas } = crearDepsFake({
      // Decisión ya publicada para este semáforo en un tramo anterior de la MISMA ambulancia.
      "sem-cerca:tramo-1": ["mantener_ciclo"],
    });

    const resultados = await orquestarTick(
      {
        ambulanceId: AMBULANCE_ID,
        tramoId: "tramo-2",
        posicionAmbulancia: AMBULANCIA_CERCA,
        semaforosPendientes: [SEMAFORO_CERCA],
      },
      deps
    );

    expect(resultados[0]?.decision).not.toBeNull();
    expect(decisionesPublicadas).toEqual([
      { semaforoId: "sem-cerca", ...DECISION_FAKE, ambulanceId: AMBULANCE_ID, tramoId: "tramo-2" },
    ]);
  });

  test("issue #20/#23: sin tramoId explícito, default es ambulanceId — comportamiento sin cambios para viajes efímeros/GPS real", async () => {
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

  describe("salvaguarda de intersección (forzar_rojo_cruce)", () => {
    test("forzar verde en un semáforo fuerza rojo en un vecino cercano sin decisión propia", async () => {
      const { deps, decisionesPublicadas } = crearDepsFake();
      deps.decidirAccion = async (contexto) => ({
        semaforoId: contexto.semaforoId,
        accion: "anticipar_verde",
        explicacion: "Ventana de decisión, sin congestión transversal.",
      });

      await orquestarTick(
        {
          ambulanceId: AMBULANCE_ID,
          posicionAmbulancia: AMBULANCIA_CERCA,
          semaforosPendientes: [SEMAFORO_CERCA, SEMAFORO_VECINO],
        },
        deps
      );

      const decisionVecino = decisionesPublicadas.find((d) => d.semaforoId === "sem-vecino");
      expect(decisionVecino?.accion).toBe("forzar_rojo_cruce");
      expect(decisionVecino?.ambulanceId).toBe(AMBULANCE_ID);
    });

    test("un semáforo fuera del radio de intersección no se ve afectado", async () => {
      const { deps, decisionesPublicadas } = crearDepsFake();
      deps.decidirAccion = async (contexto) => ({
        semaforoId: contexto.semaforoId,
        accion: "anticipar_verde",
        explicacion: "Ventana de decisión, sin congestión transversal.",
      });

      await orquestarTick(
        {
          ambulanceId: AMBULANCE_ID,
          posicionAmbulancia: AMBULANCIA_CERCA,
          semaforosPendientes: [SEMAFORO_CERCA, SEMAFORO_NO_VECINO],
        },
        deps
      );

      // sem-no-vecino sí entra en su propia ventana de decisión (está a ~322m de la ambulancia,
      // ETA≈32s), así que también recibe una decisión propia — pero nunca forzar_rojo_cruce,
      // porque no es vecino de sem-cerca.
      const decisionNoVecino = decisionesPublicadas.find((d) => d.semaforoId === "sem-no-vecino");
      expect(decisionNoVecino?.accion).not.toBe("forzar_rojo_cruce");
    });

    test("no pisa a un vecino que ya tiene su propia decisión publicada", async () => {
      const { deps, decisionesPublicadas } = crearDepsFake({
        "sem-vecino:amb-1": ["mantener_ciclo"],
      });
      deps.decidirAccion = async (contexto) => ({
        semaforoId: contexto.semaforoId,
        accion: "anticipar_verde",
        explicacion: "Ventana de decisión, sin congestión transversal.",
      });

      await orquestarTick(
        {
          ambulanceId: AMBULANCE_ID,
          posicionAmbulancia: AMBULANCIA_CERCA,
          semaforosPendientes: [SEMAFORO_CERCA],
        },
        deps
      );

      expect(decisionesPublicadas.find((d) => d.semaforoId === "sem-vecino")).toBeUndefined();
    });

    test("mantener_ciclo no dispara la salvaguarda de cruce en los vecinos", async () => {
      const { deps, decisionesPublicadas } = crearDepsFake();

      await orquestarTick(
        {
          ambulanceId: AMBULANCE_ID,
          posicionAmbulancia: AMBULANCIA_CERCA,
          semaforosPendientes: [SEMAFORO_CERCA, SEMAFORO_VECINO],
        },
        deps
      );

      expect(decisionesPublicadas.every((d) => d.accion !== "forzar_rojo_cruce")).toBe(true);
    });

    // Deliberadamente en dos ticks, no uno: `publicarDecision` es un POST REST y
    // `obtenerAccionesPrevias` lee de un canal WebSocket separado que Portal releva de forma
    // asíncrona (el mismo lag de propagación ya documentado en CLAUDE.md para el caso de ticks
    // solapados) — nada garantiza que una lectura hecha microsegundos después de una publicación
    // ya la refleje. Lo que sí es real: 5s después (el siguiente tick), Portal ya la propagó de
    // sobra. `crearDepsFake` con un fake nuevo sembrado con lo publicado en el tick 1 simula
    // justamente eso — y de paso evita que el vecino, todavía dentro de su PROPIA ventana de
    // decisión en el mismo tick, dispare una segunda llamada al LLM en la fake estática (que no
    // refleja lo recién publicado dentro de la misma llamada a `orquestarTick`).
    test("un tick posterior ve la salvaguarda ya publicada y no reinvoca al LLM para el vecino", async () => {
      const { deps: deps1, decisionesPublicadas: publicadasEnTick1 } = crearDepsFake();
      deps1.decidirAccion = async (contexto) => ({
        semaforoId: contexto.semaforoId,
        accion: "extender_verde",
        explicacion: "Ventana de decisión, sin congestión transversal.",
      });

      await orquestarTick(
        {
          ambulanceId: AMBULANCE_ID,
          posicionAmbulancia: AMBULANCIA_CERCA,
          // sem-interseccion-vecino-lejos integra el corredor del trayecto (como en producción,
          // `semaforosEnRuta` es fijo por viaje) pero su propio ETA (~63s) todavía está fuera de
          // la ventana de 60s — así que su única decisión en este tick es la salvaguarda de
          // cruce, no una propia.
          semaforosPendientes: [SEMAFORO_INTERSECCION_ABIERTO, SEMAFORO_INTERSECCION_VECINO_LEJOS],
        },
        deps1
      );

      const decisionVecinoTick1 = publicadasEnTick1.find(
        (d) => d.semaforoId === "sem-interseccion-vecino-lejos"
      );
      expect(decisionVecinoTick1?.accion).toBe("forzar_rojo_cruce");

      // Tick siguiente: la ambulancia ya está más cerca, el vecino ahora sí entra en su propia
      // ventana de decisión — pero no debe reinvocar al LLM, porque Portal ya propagó la
      // salvaguarda del tick anterior.
      let llamadasLLM = 0;
      const { deps: deps2 } = crearDepsFake({
        "sem-interseccion-vecino-lejos:amb-1": ["forzar_rojo_cruce"],
      });
      deps2.decidirAccion = async (contexto) => {
        llamadasLLM++;
        return { semaforoId: contexto.semaforoId, accion: "mantener_ciclo", explicacion: "" };
      };

      const resultados2 = await orquestarTick(
        {
          ambulanceId: AMBULANCE_ID,
          posicionAmbulancia: AMBULANCIA_CERCA,
          semaforosPendientes: [SEMAFORO_INTERSECCION_VECINO_LEJOS],
        },
        deps2
      );

      expect(llamadasLLM).toBe(0);
      expect(resultados2[0]?.fase).toEqual({ fase: "rojo", segundosRestantes: Infinity });
      // La salvaguarda es mecánica, no una decisión del agente — el vecino no reinvoca al LLM,
      // así que su propio `decision` en el resultado queda null.
      expect(resultados2[0]?.decision).toBeNull();
    });
  });
});
