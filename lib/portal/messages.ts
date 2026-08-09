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

/** Publicado una vez a PORTAL_AMBULANCIAS_ACTIVAS_CHANNEL_ID cuando una ambulancia arranca (issue #15) — anuncio de descubrimiento, no lleva más datos que el id. */
export interface AmbulanciaActivaPayload {
  ambulanceId: string;
}

/** Publicado una vez a PORTAL_AMBULANCIAS_DETENIDAS_CHANNEL_ID cuando el servidor detiene una simulación explícitamente (post-slice #16) — ver la nota del canal en `lib/portal/constants.ts`. */
export interface AmbulanciaDetenidaPayload {
  ambulanceId: string;
}
