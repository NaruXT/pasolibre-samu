import type { LineString } from "geojson";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

export interface LngLat {
  lng: number;
  lat: number;
}

export interface DrivingRoute {
  geometry: LineString;
  distanceMeters: number;
  durationSeconds: number;
}

/** Distinguishes "still loading" from "failed" — a plain nullable route can't. */
export type RouteState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; route: DrivingRoute }
  | { status: "error"; message: string };

interface MapboxDirectionsResponse {
  code: string;
  routes?: {
    geometry: LineString;
    distance: number;
    duration: number;
  }[];
}

/**
 * "driving-traffic" for the user-facing ETA preview; "driving" (no traffic) for anything
 * deriving the ambulance's own pace — CLAUDE.md's invariant is the ambulance is never slowed
 * by traffic. Required (not defaulted) so every call site has to make this choice on purpose.
 */
export type DrivingProfile = "driving" | "driving-traffic";

export async function fetchDrivingRoute(
  origin: LngLat,
  destination: LngLat,
  profile: DrivingProfile,
  options?: { signal?: AbortSignal }
): Promise<DrivingRoute> {
  if (!MAPBOX_TOKEN) {
    throw new Error("NEXT_PUBLIC_MAPBOX_TOKEN is not set. Add it to .env (see .env.example).");
  }

  const coordinates = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
  const url = new URL(`https://api.mapbox.com/directions/v5/mapbox/${profile}/${coordinates}`);
  url.searchParams.set("geometries", "geojson");
  url.searchParams.set("overview", "full");
  url.searchParams.set("alternatives", "false");
  url.searchParams.set("access_token", MAPBOX_TOKEN);

  const response = await fetch(url.toString(), { signal: options?.signal });
  if (!response.ok) {
    throw new Error(`Mapbox Directions request failed (${response.status}).`);
  }

  const body: MapboxDirectionsResponse = await response.json();
  const route = body.routes?.[0];
  if (body.code !== "Ok" || !route) {
    throw new Error(`Mapbox Directions returned no route (${body.code}).`);
  }

  return {
    geometry: route.geometry,
    distanceMeters: route.distance,
    durationSeconds: route.duration,
  };
}
