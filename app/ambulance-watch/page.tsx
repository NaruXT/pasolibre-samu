"use client";

import { useState } from "react";
import { useChannel } from "@portalsdk/react";
import { PORTAL_AMBULANCE_CHANNEL_ID, PORTAL_ROUTE_CHANNEL_ID } from "@/lib/portal/constants";
import type { AmbulancePositionPayload, RoutePublishPayload } from "@/lib/portal/messages";

export default function AmbulanceWatchPage() {
  const [latestPosition, setLatestPosition] = useState<AmbulancePositionPayload | null>(null);
  const [positionUpdateCount, setPositionUpdateCount] = useState(0);

  const { messages: routeMessages, status: routeStatus } = useChannel<RoutePublishPayload>({
    channelId: PORTAL_ROUTE_CHANNEL_ID,
  });

  // onMessage es la forma documentada de observar envíos ephemeral (nunca llegan a `messages`,
  // que está ordenado por seq). Requiere el parche local a @portalsdk/core — ver CLAUDE.md.
  const { status: ambulanceStatus } = useChannel<AmbulancePositionPayload>({
    channelId: PORTAL_AMBULANCE_CHANNEL_ID,
    onMessage: (msg) => {
      setLatestPosition(msg.content);
      setPositionUpdateCount((count) => count + 1);
    },
  });

  const latestRoute = routeMessages[routeMessages.length - 1];

  return (
    <main className="mx-auto max-w-2xl p-8 font-sans">
      <h1 className="text-2xl font-semibold">Segundo cliente — ruta y posición en vivo</h1>
      <p className="mt-1 text-sm text-zinc-500">
        <code>{PORTAL_ROUTE_CHANNEL_ID}</code>: {routeStatus} · <code>{PORTAL_AMBULANCE_CHANNEL_ID}</code>: {ambulanceStatus}
      </p>

      <section className="mt-6">
        <h2 className="font-medium">
          Ruta ({routeMessages.length} publicada{routeMessages.length === 1 ? "" : "s"})
        </h2>
        {latestRoute ? (
          <p className="text-sm text-zinc-500">
            {(latestRoute.content.distanceMeters / 1000).toFixed(1)} km ·{" "}
            {Math.round(latestRoute.content.durationSeconds / 60)} min ·{" "}
            {latestRoute.content.geometry.coordinates.length} puntos de geometría
          </p>
        ) : (
          <p className="text-sm text-zinc-500">Sin ruta publicada todavía.</p>
        )}
      </section>

      <section className="mt-6">
        <h2 className="font-medium">Posición de la ambulancia ({positionUpdateCount} actualizaciones)</h2>
        {latestPosition ? (
          <p className="text-sm text-zinc-500">
            {latestPosition.lat.toFixed(5)}, {latestPosition.lng.toFixed(5)}
            {latestPosition.arrived ? " · llegó al hospital" : ""}
          </p>
        ) : (
          <p className="text-sm text-zinc-500">Sin posición todavía.</p>
        )}
      </section>
    </main>
  );
}
