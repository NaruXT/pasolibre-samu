import type { LineString } from "geojson";
import type { LngLat } from "@/lib/mapbox/directions";
import type { AmbulancePosition } from "@/lib/mapbox/ambulance";

/** Publicado una sola vez por trayecto a PORTAL_ROUTE_CHANNEL_ID. */
export interface RoutePublishPayload {
  /** Identidad de trayecto (issue #12/#14) — distingue ambulancias simultáneas en el canal compartido. */
  ambulanceId: string;
  geometry: LineString;
  distanceMeters: number;
  durationSeconds: number;
  origin: LngLat;
  destination: LngLat;
}

/** Publicado como ephemeral en cada tick de la ambulancia a PORTAL_AMBULANCE_CHANNEL_ID. */
export interface AmbulancePositionPayload extends AmbulancePosition {
  ambulanceId: string;
}
