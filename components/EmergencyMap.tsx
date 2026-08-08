"use client";

import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Feature, LineString } from "geojson";
import { fetchDrivingRoute, type RouteState } from "@/lib/mapbox/directions";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

// Corredor Av. Javier Prado (San Borja) -> Hospital Nacional Edgardo Rebagliati Martins.
const CORRIDOR_START: [number, number] = [-76.9973, -12.0905]; // Av. Javier Prado Este x Av. Aviación, San Borja
const REBAGLIATI: [number, number] = [-77.0399, -12.0784]; // Destino fijo (ver CLAUDE.md)

const ROUTE_SOURCE_ID = "emergency-route";
const ROUTE_LAYER_ID = "emergency-route-line";
const EMPTY_ROUTE_GEOMETRY: LineString = { type: "LineString", coordinates: [] };

function toRouteFeature(geometry: LineString): Feature<LineString> {
  return { type: "Feature", properties: {}, geometry };
}

export interface EmergencyPoint {
  lng: number;
  lat: number;
}

interface EmergencyMapProps {
  onEmergencyPointChange: (point: EmergencyPoint | null) => void;
  onRouteStateChange: (state: RouteState) => void;
}

export function EmergencyMap({ onEmergencyPointChange, onRouteStateChange }: EmergencyMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const requestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!containerRef.current || !MAPBOX_TOKEN) return;

    mapboxgl.accessToken = MAPBOX_TOKEN;
    const corridorBounds = new mapboxgl.LngLatBounds()
      .extend(CORRIDOR_START)
      .extend(REBAGLIATI);
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/streets-v12",
      bounds: corridorBounds,
      fitBoundsOptions: { padding: 64 },
    });

    map.addControl(new mapboxgl.NavigationControl(), "top-right");

    // Click handling lives inside "load" so it's a no-op until the route source/layer exist —
    // otherwise a click during the brief load window would place a marker with no route drawn.
    map.on("load", () => {
      map.addSource(ROUTE_SOURCE_ID, {
        type: "geojson",
        data: toRouteFeature(EMPTY_ROUTE_GEOMETRY),
      });
      map.addLayer({
        id: ROUTE_LAYER_ID,
        type: "line",
        source: ROUTE_SOURCE_ID,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#2563eb", "line-width": 5, "line-opacity": 0.85 },
      });

      map.on("click", async (event) => {
        const { lng, lat } = event.lngLat;

        markerRef.current?.remove();
        markerRef.current = new mapboxgl.Marker({ color: "#dc2626" })
          .setLngLat([lng, lat])
          .addTo(map);

        onEmergencyPointChange({ lng, lat });
        onRouteStateChange({ status: "loading" });

        abortControllerRef.current?.abort();
        const abortController = new AbortController();
        abortControllerRef.current = abortController;
        const requestId = ++requestIdRef.current;
        const routeSource = () =>
          map.getSource(ROUTE_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;

        try {
          const route = await fetchDrivingRoute(
            { lng, lat },
            { lng: REBAGLIATI[0], lat: REBAGLIATI[1] },
            { signal: abortController.signal }
          );
          if (requestId !== requestIdRef.current) return; // superseded by a later click

          routeSource()?.setData(toRouteFeature(route.geometry));
          onRouteStateChange({ status: "ready", route });
        } catch (error) {
          if (requestId !== requestIdRef.current) return;

          routeSource()?.setData(toRouteFeature(EMPTY_ROUTE_GEOMETRY));
          const message = error instanceof Error ? error.message : String(error);
          onRouteStateChange({ status: "error", message });
          console.error("No se pudo calcular la ruta a Rebagliati:", error);
        }
      });
    });

    return () => {
      abortControllerRef.current?.abort();
      markerRef.current?.remove();
      map.remove();
    };
  }, [onEmergencyPointChange, onRouteStateChange]);

  if (!MAPBOX_TOKEN) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-zinc-100 p-8 text-center text-sm text-zinc-500 dark:bg-zinc-900">
        Falta NEXT_PUBLIC_MAPBOX_TOKEN — agrégalo a .env (ver .env.example).
      </div>
    );
  }

  return <div ref={containerRef} className="h-full w-full" />;
}
