import { calcularETASegundos, type LngLat } from "./eta";
import type { AccionSemaforo, DecisionSemaforo, DecisionSemaforoPublicada } from "./decision";
import type { ContextoDecisionSemaforo } from "./agent";
import { faseEfectiva } from "@/lib/semaforo/faseEfectiva";
import type { FaseSemaforo } from "@/lib/semaforo/fase";
import { semaforosVecinos } from "@/lib/semaforo/semaforosVecinos";
import type { CongestionTransversal } from "@/lib/tomtom/trafficFlow";

/** Ventana de decisión propuesta por el ticket #7: ~60s antes de que la ambulancia llegue. */
const VENTANA_DECISION_SEGUNDOS = 60;

export interface SemaforoPendiente extends LngLat {
  semaforoId: string;
}

export interface PosicionAmbulancia extends LngLat {
  velocidadMetrosPorSegundo: number;
}

export interface OrquestarTickInput {
  /** Identidad de trayecto (issue #12/#14) — scopea "ya decidido" por ambulancia, no solo por semáforo. */
  ambulanceId: string;
  /**
   * Issue #20/#23: scopea "ya decidido" por LLAMADA atendida, no por la vida entera de la
   * ambulancia — default `ambulanceId` si se omite (comportamiento sin cambios para viajes
   * efímeros y GPS real, donde `ambulanceId` ya es fresco por trayecto). Una unidad de flota
   * pasa un `tramoId` explícito (uno por llamada, compartido por sus dos tramos) porque
   * reutiliza el mismo `ambulanceId` en cada llamada que atiende — sin esto, la segunda vez
   * que cruza un semáforo ya decidido en una llamada anterior se saltaría la decisión.
   */
  tramoId?: string;
  posicionAmbulancia: PosicionAmbulancia;
  semaforosPendientes: SemaforoPendiente[];
}

export interface ResultadoSemaforo {
  semaforoId: string;
  etaSegundos: number;
  fase: FaseSemaforo;
  decision: DecisionSemaforo | null;
}

export interface OrquestarTickDeps {
  /**
   * Fronteras de I/O real — en producción hablan con Portal/el LLM, en tests son dobles en
   * memoria. Escopadas por `(semaforoId, ambulanceId)`, no solo `semaforoId` (issue #12/#14).
   */
  obtenerAccionesPrevias: (semaforoId: string, tramoId: string) => Promise<AccionSemaforo[]>;
  publicarDecision: (decision: DecisionSemaforoPublicada) => Promise<void>;
  /** Agente de decisión (LLM real en producción, ticket #8) — inyectado para no gastar cuota en tests. */
  decidirAccion: (contexto: ContextoDecisionSemaforo) => Promise<DecisionSemaforo>;
  /**
   * Congestión del tráfico transversal (TomTom, ticket #10) — inyectado por la misma razón que
   * `decidirAccion`. Se llama solo dentro de la ventana de decisión de un semáforo, en el mismo
   * punto que gatilla `decidirAccion` (ver abajo): como esa invocación ya ocurre una única vez
   * por semáforo por trayecto, TomTom hereda esa misma garantía sin lógica de rate-limit
   * adicional — es la forma en que este ticket cumple "no re-consultar el mismo semáforo más de
   * una vez por trayecto" contra la cuota gratuita de 2.500 requests/día.
   */
  obtenerCongestionTransversal: (semaforo: SemaforoPendiente) => Promise<CongestionTransversal | null>;
  /** Inyectable para tests determinísticos; por default el reloj real. */
  ahoraSegundos?: () => number;
}

/**
 * El seam principal del proyecto: por cada semáforo pendiente calcula ETA y fase (funciones
 * puras, se ejecutan de verdad), y si el ETA entra en la ventana de decisión y el semáforo
 * todavía no tiene ninguna decisión publicada **para este `ambulanceId`**, invoca al agente
 * (LLM real, ticket #8; `deps` lo inyecta para no gastar cuota en tests) una sola vez y
 * publica su decisión.
 *
 * "Todavía no tiene decisión" se resuelve consultando semaforos-ruta-1 por `(semaforoId,
 * ambulanceId)` (ver `deps.obtenerAccionesPrevias`) — issue #12/#14 resuelve así, como efecto
 * colateral, el gap documentado desde ticket #7: antes solo se filtraba por `semaforoId`, así
 * que una decisión de un trayecto anterior (o de otra ambulancia activa a la vez) bloqueaba una
 * decisión nueva para el mismo semáforo. Con dos ambulancias cruzando el mismo semáforo, cada
 * una decide independientemente — lo que sí sigue siendo cierto es que un único marcador en el
 * mapa no puede mostrar dos decisiones distintas a la vez para la misma ubicación física (ver
 * `components/EmergencyMap.tsx`); eso es un límite de la UI, no de esta función.
 *
 * Salvaguarda de intersección (ver `forzarRojoEnVecinos`): forzar verde a un semáforo también
 * fuerza rojo a cualquier otro semáforo geográficamente vecino (misma intersección física) que
 * todavía no tenga su propia decisión — sin esto, dos accesos de la misma intersección podían
 * quedar en verde a la vez y dejar pasar tránsito transversal justo cuando pasa la ambulancia.
 */
export async function orquestarTick(
  input: OrquestarTickInput,
  deps: OrquestarTickDeps
): Promise<ResultadoSemaforo[]> {
  const ahora = (deps.ahoraSegundos ?? (() => Date.now() / 1000))();
  const tramoId = input.tramoId ?? input.ambulanceId;
  const resultados: ResultadoSemaforo[] = [];

  for (const semaforo of input.semaforosPendientes) {
    const etaSegundos = calcularETASegundos(
      input.posicionAmbulancia,
      semaforo,
      input.posicionAmbulancia.velocidadMetrosPorSegundo
    );

    const accionesPrevias = await deps.obtenerAccionesPrevias(semaforo.semaforoId, tramoId);
    const yaTieneDecision = accionesPrevias.length > 0;

    let decision: DecisionSemaforo | null = null;
    if (etaSegundos <= VENTANA_DECISION_SEGUNDOS && !yaTieneDecision) {
      const faseAntesDeDecidir = faseEfectiva(semaforo.semaforoId, ahora, accionesPrevias);
      const congestionTransversal = await deps.obtenerCongestionTransversal(semaforo);
      decision = await deps.decidirAccion({
        semaforoId: semaforo.semaforoId,
        etaSegundos,
        fase: faseAntesDeDecidir,
        congestionTransversal,
        ambulanceId: input.ambulanceId,
      });
      await deps.publicarDecision({ ...decision, ambulanceId: input.ambulanceId, tramoId });
      accionesPrevias.push(decision.accion);

      if (decision.accion === "anticipar_verde" || decision.accion === "extender_verde") {
        await forzarRojoEnVecinos(semaforo, input.semaforosPendientes, input.ambulanceId, tramoId, deps);
      }
    }

    resultados.push({
      semaforoId: semaforo.semaforoId,
      etaSegundos,
      fase: faseEfectiva(semaforo.semaforoId, ahora, accionesPrevias),
      decision,
    });
  }

  return resultados;
}

/**
 * Salvaguarda de intersección: cuando `semaforo` se acaba de forzar a verde para la ambulancia,
 * cualquier otro semáforo de `semaforosPendientes` a metros de distancia (misma intersección
 * física, ver `semaforosVecinos`) se fuerza a rojo — sin invocar al LLM, es una regla mecánica,
 * no una decisión de tráfico. No pisa un vecino que ya tenga cualquier decisión propia publicada
 * (incluida una `forzar_rojo_cruce` anterior de otro semáforo de la misma intersección): eso
 * respeta "una sola decisión por semáforo por trayecto" (ver el bucle de arriba) y, en particular,
 * nunca sobrescribe una decisión directa legítima (el vecino podría estar en el propio trayecto
 * de la ambulancia, no ser tránsito transversal — el dataset no distingue dirección, ver
 * `semaforosVecinos`) con una protección de cruce.
 *
 * Issue #20/#23 (resuelto en el merge con la protección de cruce): escopado por `tramoId`, no
 * `ambulanceId` — igual que el resto de `orquestarTick`, para que una unidad de flota que ya
 * forzó rojo en un vecino durante una llamada anterior no quede bloqueada de volver a hacerlo en
 * una llamada nueva por el mismo semáforo físico. `ambulanceId` se sigue publicando en el
 * registro (igual que la decisión principal) — es solo el campo de audit, no el de scoping.
 */
async function forzarRojoEnVecinos(
  semaforo: SemaforoPendiente,
  semaforosPendientes: readonly SemaforoPendiente[],
  ambulanceId: string,
  tramoId: string,
  deps: Pick<OrquestarTickDeps, "obtenerAccionesPrevias" | "publicarDecision">
): Promise<void> {
  const vecinos = semaforosVecinos(semaforo, semaforosPendientes);

  for (const vecino of vecinos) {
    const accionesVecino = await deps.obtenerAccionesPrevias(vecino.semaforoId, tramoId);
    if (accionesVecino.length > 0) continue;

    await deps.publicarDecision({
      semaforoId: vecino.semaforoId,
      accion: "forzar_rojo_cruce",
      explicacion:
        `El semáforo ${semaforo.semaforoId}, de la misma intersección, se abrió en verde ` +
        "para la ambulancia — este se mantiene en rojo para que el tránsito transversal no se " +
        "cruce en su camino.",
      ambulanceId,
      tramoId,
    });
  }
}
