import type { LineString } from "geojson";
import type { LngLat } from "@/lib/mapbox/directions";
import type { AmbulancePosition } from "@/lib/mapbox/ambulance";

/** Published once per trip to PORTAL_ROUTE_CHANNEL_ID. */
export interface RoutePublishPayload {
  geometry: LineString;
  distanceMeters: number;
  durationSeconds: number;
  origin: LngLat;
  destination: LngLat;
}

/** Published ephemeral on every ambulance tick to PORTAL_AMBULANCE_CHANNEL_ID. */
export type AmbulancePositionPayload = AmbulancePosition;
