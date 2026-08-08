"use client";

import { useState } from "react";
import { EmergencyMap, type EmergencyPoint } from "@/components/EmergencyMap";
import type { RouteState } from "@/lib/mapbox/directions";

function routeStatusText(state: RouteState): string | null {
  switch (state.status) {
    case "idle":
      return null;
    case "loading":
      return "Calculando ruta a Rebagliati...";
    case "ready":
      return `Ruta a Rebagliati: ${(state.route.distanceMeters / 1000).toFixed(1)} km · ${Math.round(state.route.durationSeconds / 60)} min`;
    case "error":
      return `No se pudo calcular la ruta: ${state.message}`;
  }
}

export default function Home() {
  const [emergencyPoint, setEmergencyPoint] = useState<EmergencyPoint | null>(null);
  const [routeState, setRouteState] = useState<RouteState>({ status: "idle" });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-zinc-200 p-4 dark:border-zinc-800">
        <h1 className="text-lg font-semibold">SAMU — punto de emergencia</h1>
        <p className="text-sm text-zinc-500">
          {emergencyPoint
            ? `Emergencia en ${emergencyPoint.lat.toFixed(5)}, ${emergencyPoint.lng.toFixed(5)}`
            : "Click en el mapa para marcar el punto de emergencia."}
        </p>
        {emergencyPoint && (
          <p className="text-sm text-zinc-500">{routeStatusText(routeState)}</p>
        )}
      </header>
      <div className="min-h-0 flex-1">
        <EmergencyMap
          onEmergencyPointChange={setEmergencyPoint}
          onRouteStateChange={setRouteState}
        />
      </div>
    </div>
  );
}
