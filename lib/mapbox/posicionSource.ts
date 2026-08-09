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

export interface InterpoladaPosicionSourceOptions {
  tickMs?: number;
  /**
   * Patrullaje de una unidad de flota libre (issue #20/#21): en vez de terminar al llegar al
   * extremo de la ruta, rebota y la recorre de vuelta, indefinidamente — nunca reporta
   * `arrived: true`. Si lo hiciera, `EmergencyMap.tsx#observarAmbulancia` interpretaría el
   * primer extremo del loop como una llegada real y removería el marker a los 4s, aunque la
   * unidad sigue patrullando.
   */
  loop?: boolean;
}

/**
 * Simulada (tickets #4/#6-#9) — avanza el tiempo con un timer local propio y reusa
 * `ambulancePositionAt` (pura). Emite la primera posición de forma síncrona al suscribirse,
 * sin esperar el primer tick — mismo comportamiento que tenía `EmergencyMap.tsx` antes de esta
 * abstracción.
 */
export class InterpoladaPosicionSource implements PosicionSource {
  private readonly tickMs: number;
  private readonly loop: boolean;

  constructor(
    private readonly route: DrivingRoute,
    options: InterpoladaPosicionSourceOptions = {}
  ) {
    this.tickMs = options.tickMs ?? TICK_MS_DEFAULT;
    this.loop = options.loop ?? false;
  }

  suscribir(onPosicion: (posicion: AmbulancePosition) => void): () => void {
    let elapsedSeconds = 0;
    let direccion: 1 | -1 = 1;
    let timer: ReturnType<typeof setInterval> | null = null;

    const emitir = (): AmbulancePosition => {
      const posicion = ambulancePositionAt(this.route, elapsedSeconds);
      const posicionFinal = this.loop ? { ...posicion, arrived: false } : posicion;
      onPosicion(posicionFinal);
      return posicionFinal;
    };

    const avanzar = () => {
      elapsedSeconds += direccion * (this.tickMs / 1000);
      if (elapsedSeconds >= this.route.durationSeconds) {
        elapsedSeconds = this.route.durationSeconds;
        direccion = -1;
      } else if (elapsedSeconds <= 0) {
        elapsedSeconds = 0;
        direccion = 1;
      }
    };

    const primeraPosicion = emitir();
    if (this.loop || !primeraPosicion.arrived) {
      timer = setInterval(() => {
        avanzar();
        const posicion = emitir();
        if (!this.loop && posicion.arrived && timer !== null) {
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
