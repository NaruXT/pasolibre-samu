import type { LineString } from "geojson";
import type { LngLat } from "@/lib/mapbox/directions";
import type { AmbulancePosition } from "@/lib/mapbox/ambulance";

/**
 * Publicado al canal `rutaAmbulanciaChannelId(ambulanceId)` de esta ambulancia — una sola vez
 * por trayecto para un viaje efímero, o una vez por CADA transición de tramo (patrullaje →
 * recogida → hospital → patrullaje) para una unidad de flota.
 *
 * `estado` (issue #20, post-#23) — solo lo publican las unidades de flota (`lib/tick/flota.ts`);
 * un viaje efímero o una ambulancia GPS real lo omiten (no tienen ese concepto, `undefined` se
 * trata como `"libre"` del lado del cliente). Deliberadamente en este canal, NO ephemeral, y no
 * en el de posición (que sí es ephemeral): el cliente necesita poder reconstruir si una unidad
 * está libre u ocupada — y, si está ocupada, su origen/destino real — incluso en una carga
 * fresca de la página (recarga), sin depender de haber estado conectado para ver un tick en
 * vivo. Bug real reportado por el usuario: "no entiendo por qué todas las ambulancias están
 * ocupadas", sin ninguna forma de distinguir una libre de una ocupada en el mapa.
 */
export interface RoutePublishPayload {
  /** Identidad de trayecto (issue #12/#14) — también codificada en el nombre del canal (issue #15), pero se mantiene acá para que el mensaje sea autodescriptivo. */
  ambulanceId: string;
  geometry: LineString;
  distanceMeters: number;
  durationSeconds: number;
  origin: LngLat;
  destination: LngLat;
  estado?: "libre" | "en_proceso";
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
