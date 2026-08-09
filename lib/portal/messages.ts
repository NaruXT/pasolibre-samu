import type { LineString } from "geojson";
import type { LngLat } from "@/lib/mapbox/directions";
import type { AmbulancePosition } from "@/lib/mapbox/ambulance";

/** Publicado una sola vez por trayecto al canal `rutaAmbulanciaChannelId(ambulanceId)` de esta ambulancia. */
export interface RoutePublishPayload {
  /** Identidad de trayecto (issue #12/#14) — también codificada en el nombre del canal (issue #15), pero se mantiene acá para que el mensaje sea autodescriptivo. */
  ambulanceId: string;
  geometry: LineString;
  distanceMeters: number;
  durationSeconds: number;
  origin: LngLat;
  destination: LngLat;
}

/** Publicado como ephemeral en cada tick al canal `ambulanciaChannelId(ambulanceId)` de esta ambulancia. */
export interface AmbulancePositionPayload extends AmbulancePosition {
  ambulanceId: string;
}

/**
 * Publicado una vez a PORTAL_AMBULANCIAS_ACTIVAS_CHANNEL_ID cuando una ambulancia arranca
 * (issue #15) — anuncio de descubrimiento. `tipo` (issue #20/#22) distingue una unidad de flota
 * (`lib/tick/flota.ts`, patrulla libre, ofrece "Fin de turno") de un viaje efímero de un solo
 * uso (`lib/tick/simulacion.ts`, el flujo default) — el cliente necesita saberlo para decidir si
 * mostrar el popup de retiro en `EmergencyMap.tsx#observarAmbulancia`.
 */
export interface AmbulanciaActivaPayload {
  ambulanceId: string;
  tipo: "flota" | "viaje";
}

/** Publicado una vez a PORTAL_AMBULANCIAS_DETENIDAS_CHANNEL_ID cuando el servidor detiene una simulación explícitamente (post-slice #16) — ver la nota del canal en `lib/portal/constants.ts`. */
export interface AmbulanciaDetenidaPayload {
  ambulanceId: string;
}
