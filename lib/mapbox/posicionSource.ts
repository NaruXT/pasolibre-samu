import type { ChannelHandle } from "@portalsdk/core";
import { ambulancePositionAt, type AmbulancePosition } from "./ambulance";
import type { DrivingRoute } from "./directions";
import type { AmbulancePositionPayload } from "@/lib/portal/messages";

const TICK_MS_DEFAULT = 5000;

/**
 * Issue #12/#16: abstrae "de dónde viene la próxima posición de esta ambulancia" — una
 * ambulancia simulada la calcula localmente (`InterpoladaPosicionSource`), una real la recibe
 * empujada por su propio canal Portal (`RealPosicionSource`). `AmbulanceInstance`
 * (`components/EmergencyMap.tsx`) no necesita saber cuál es: solo le importa la secuencia de
 * posiciones.
 */
export interface PosicionSource {
  /**
   * Empieza a emitir posiciones a `onPosicion`; devuelve una función para dejar de escuchar
   * (limpia el timer interno en la simulada, cancela la suscripción Portal en la real).
   */
  suscribir(onPosicion: (posicion: AmbulancePosition) => void): () => void;
}

/**
 * Simulada (tickets #4/#6-#9) — avanza el tiempo con un timer local propio y reusa
 * `ambulancePositionAt` (pura). Emite la primera posición de forma síncrona al suscribirse,
 * sin esperar el primer tick — mismo comportamiento que tenía `EmergencyMap.tsx` antes de esta
 * abstracción.
 */
export class InterpoladaPosicionSource implements PosicionSource {
  constructor(
    private readonly route: DrivingRoute,
    private readonly tickMs: number = TICK_MS_DEFAULT
  ) {}

  suscribir(onPosicion: (posicion: AmbulancePosition) => void): () => void {
    let elapsedSeconds = 0;
    let timer: ReturnType<typeof setInterval> | null = null;

    const emitir = (): AmbulancePosition => {
      const posicion = ambulancePositionAt(this.route, elapsedSeconds);
      onPosicion(posicion);
      return posicion;
    };

    if (!emitir().arrived) {
      timer = setInterval(() => {
        elapsedSeconds += this.tickMs / 1000;
        const posicion = emitir();
        if (posicion.arrived && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      }, this.tickMs);
    }

    return () => {
      if (timer !== null) clearInterval(timer);
    };
  }
}

/**
 * Real (issue #12/#16) — pasiva: no tiene timer propio, solo reenvía lo que llegue por el
 * canal Portal ephemeral de esta ambulancia (`ambulanciaChannelId(ambulanceId)`), publicado
 * por `POST /api/ambulance/[id]/position`. Si el device deja de mandar updates, esta fuente
 * simplemente deja de emitir — el marker se congela en la última posición conocida (ver nota
 * en `CLAUDE.md` sobre timeout no implementado).
 */
export class RealPosicionSource implements PosicionSource {
  constructor(private readonly ambulanceChannel: ChannelHandle<AmbulancePositionPayload>) {}

  suscribir(onPosicion: (posicion: AmbulancePosition) => void): () => void {
    return this.ambulanceChannel.on("message", (msg) => onPosicion(msg.content));
  }
}
