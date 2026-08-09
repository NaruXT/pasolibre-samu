import { fetchDrivingRoute, type LngLat } from "@/lib/mapbox/directions";
import { InterpoladaPosicionSource } from "@/lib/mapbox/posicionSource";
import { obtenerCanalServidor } from "@/lib/portal/serverReader";
import {
  ambulanciaChannelId,
  PORTAL_AMBULANCIAS_ACTIVAS_CHANNEL_ID,
  rutaAmbulanciaChannelId,
} from "@/lib/portal/constants";
import type {
  AmbulanciaActivaPayload,
  AmbulancePositionPayload,
  RoutePublishPayload,
} from "@/lib/portal/messages";
import { reconciliarSimulacionesHuerfanas } from "@/lib/tick/simulacion";

/**
 * Unidad de flota persistente (issue #20/#21) — reemplaza, para el flujo de "Agregar
 * ambulancia", al viaje efímero de `lib/tick/simulacion.ts` (que sigue existiendo tal cual para
 * el click default). Slice 1/3: solo cubre el alta y el patrullaje — no hay todavía estado
 * `libre`/`en_proceso` porque nada en este ticket lo lee (la asignación llega en el slice 3/3).
 */
interface UnidadFlota {
  detener: () => void;
}

// Cacheado en globalThis por la misma razón que `__simulacionesActivas`: sobrevive al HMR de
// Next.js en dev sin perder las unidades ya dadas de alta.
const cacheFlota = globalThis as unknown as {
  __flotaActiva?: Map<string, UnidadFlota>;
};
if (!cacheFlota.__flotaActiva) {
  cacheFlota.__flotaActiva = new Map();
}

/** Separado de `MAX_SIMULACIONES_ACTIVAS` — cuenta unidades de flota dadas de alta, no viajes. */
export const MAX_FLOTA_ACTIVA = 8;

/** Distinguible del resto de errores (Mapbox/Portal caídos, etc.) para que la ruta HTTP devuelva 429, no 502. */
export class LimiteFlotaAlcanzadaError extends Error {}

const RADIO_PATRULLAJE_METROS = 700;
const METROS_POR_GRADO_LAT = 111_320;

/**
 * Punto de "vuelta" del patrullaje — a pedido del usuario, un recorrido corto y real (no en
 * línea recta) alrededor de donde se dio de alta la unidad. Dirección fija (norte): simple y
 * suficiente para un patrullaje visible; no busca evitar agua/parques ni variar por unidad
 * (fuera de alcance de este ticket).
 */
function puntoDeVuelta(origen: LngLat): LngLat {
  const deltaLat = RADIO_PATRULLAJE_METROS / METROS_POR_GRADO_LAT;
  return { lng: origen.lng, lat: origen.lat + deltaLat };
}

/**
 * Da de alta una unidad de flota en `origen`: calcula su ruta de patrullaje (ida y vuelta,
 * `fetchDrivingRoute` una sola vez — el loop se recorre reusando esa misma geometría, ver
 * `InterpoladaPosicionSource#loop`), publica ruta + anuncio de descubrimiento (mismos canales
 * que ya usa `simulacion.ts`, sin cambios), y arranca su posición en loop. No calcula ningún
 * hospital ni arranca ningún viaje — eso es responsabilidad de la asignación (slice 3/3).
 * Deliberadamente no llama a `orquestarTick`: mientras está libre, no hay gasto de LLM/TomTom.
 */
export async function darDeAltaUnidadFlota(ambulanceId: string, origen: LngLat): Promise<void> {
  await reconciliarSimulacionesHuerfanas();

  if (
    !cacheFlota.__flotaActiva!.has(ambulanceId) &&
    cacheFlota.__flotaActiva!.size >= MAX_FLOTA_ACTIVA
  ) {
    throw new LimiteFlotaAlcanzadaError(
      `Ya hay ${MAX_FLOTA_ACTIVA} unidades de flota activas (el máximo) — esperá a que alguna termine su turno antes de agregar otra.`
    );
  }

  // Reserva el cupo de inmediato, antes de cualquier `await` — si no, dos altas casi
  // simultáneas podrían pasar ambas el chequeo del tope (ninguna se ve todavía en el Map)
  // y admitirse las dos. Se reemplaza por la unidad real al final, o se libera si el alta falla.
  cacheFlota.__flotaActiva!.set(ambulanceId, { detener: () => {} });

  try {
    const destino = puntoDeVuelta(origen);
    const rutaPatrullaje = await fetchDrivingRoute(origen, destino, "driving");

    const rutaChannel = await obtenerCanalServidor<RoutePublishPayload>(
      rutaAmbulanciaChannelId(ambulanceId)
    );
    await rutaChannel.send({
      content: {
        ambulanceId,
        geometry: rutaPatrullaje.geometry,
        distanceMeters: rutaPatrullaje.distanceMeters,
        durationSeconds: rutaPatrullaje.durationSeconds,
        origin: origen,
        destination: destino,
      },
    });

    const registroChannel = await obtenerCanalServidor<AmbulanciaActivaPayload>(
      PORTAL_AMBULANCIAS_ACTIVAS_CHANNEL_ID
    );
    await registroChannel.send({ content: { ambulanceId } });

    const ambulanceChannel = await obtenerCanalServidor<AmbulancePositionPayload>(
      ambulanciaChannelId(ambulanceId)
    );

    const fuente = new InterpoladaPosicionSource(rutaPatrullaje, { loop: true });
    const detener = fuente.suscribir((posicion) => {
      void ambulanceChannel
        .send({ content: { ...posicion, ambulanceId }, ephemeral: true })
        .catch((error) => {
          console.error(`No se pudo publicar posición de patrullaje de ${ambulanceId}:`, error);
        });
    });

    cacheFlota.__flotaActiva!.set(ambulanceId, { detener });
  } catch (error) {
    cacheFlota.__flotaActiva!.delete(ambulanceId);
    throw error;
  }
}
