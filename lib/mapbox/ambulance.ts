import { along } from "@turf/along";
import { length } from "@turf/length";
import type { LineString } from "geojson";

export interface AmbulancePosition {
  lng: number;
  lat: number;
  arrived: boolean;
}

/**
 * Posición de una ambulancia con prioridad sobre `route` tras `elapsedSeconds` de viaje,
 * asumiendo velocidad constante sobre la duración estimada por Mapbox para todo el tramo
 * (la ambulancia nunca se ralentiza por tráfico — ver CLAUDE.md).
 */
export function ambulancePositionAt(
  route: { geometry: LineString; durationSeconds: number },
  elapsedSeconds: number
): AmbulancePosition {
  const [startLng, startLat] = route.geometry.coordinates[0];

  if (route.durationSeconds <= 0) {
    return { lng: startLng, lat: startLat, arrived: true };
  }

  const fraction = Math.min(elapsedSeconds / route.durationSeconds, 1);
  const line = { type: "Feature" as const, properties: {}, geometry: route.geometry };
  const totalLengthKm = length(line, { units: "kilometers" });
  const point = along(line, totalLengthKm * fraction, { units: "kilometers" });
  const [lng, lat] = point.geometry.coordinates;

  return { lng, lat, arrived: fraction >= 1 };
}
