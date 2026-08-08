"use client";

import { useState } from "react";
import { EmergencyMap, type EmergencyPoint } from "@/components/EmergencyMap";

export default function Home() {
  const [emergencyPoint, setEmergencyPoint] = useState<EmergencyPoint | null>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-zinc-200 p-4 dark:border-zinc-800">
        <h1 className="text-lg font-semibold">SAMU — punto de emergencia</h1>
        <p className="text-sm text-zinc-500">
          {emergencyPoint
            ? `Emergencia en ${emergencyPoint.lat.toFixed(5)}, ${emergencyPoint.lng.toFixed(5)}`
            : "Click en el mapa para marcar el punto de emergencia."}
        </p>
      </header>
      <div className="min-h-0 flex-1">
        <EmergencyMap onEmergencyPointChange={setEmergencyPoint} />
      </div>
    </div>
  );
}
