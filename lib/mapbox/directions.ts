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

/** Distingue "todavía cargando" de "falló" — una ruta simplemente nullable no puede. */
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
 * "driving-traffic" para el ETA que ve el usuario; "driving" (sin tráfico) para todo lo que
 * derive el ritmo propio de la ambulancia — el invariante de CLAUDE.md es que la ambulancia
 * nunca se ralentiza por tráfico. Obligatorio (sin default) para que cada sitio de llamada
 * tenga que elegir a propósito.
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
