"use client";

import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

// Corredor Av. Javier Prado (San Borja) -> Hospital Nacional Edgardo Rebagliati Martins.
const CORRIDOR_START: [number, number] = [-76.9973, -12.0905]; // Av. Javier Prado Este x Av. Aviación, San Borja
const REBAGLIATI: [number, number] = [-77.0399, -12.0784]; // Destino fijo (ver CLAUDE.md)

export interface EmergencyPoint {
  lng: number;
  lat: number;
}

interface EmergencyMapProps {
  onEmergencyPointChange: (point: EmergencyPoint | null) => void;
}

export function EmergencyMap({ onEmergencyPointChange }: EmergencyMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);

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

    map.on("click", (event) => {
      const { lng, lat } = event.lngLat;

      markerRef.current?.remove();
      markerRef.current = new mapboxgl.Marker({ color: "#dc2626" })
        .setLngLat([lng, lat])
        .addTo(map);

      onEmergencyPointChange({ lng, lat });
    });

    return () => {
      markerRef.current?.remove();
      map.remove();
    };
  }, [onEmergencyPointChange]);

  if (!MAPBOX_TOKEN) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-zinc-100 p-8 text-center text-sm text-zinc-500 dark:bg-zinc-900">
        Falta NEXT_PUBLIC_MAPBOX_TOKEN — agrégalo a .env (ver .env.example).
      </div>
    );
  }

  return <div ref={containerRef} className="h-full w-full" />;
}
