"use client";

import { useState } from "react";
import { useChannel } from "@portalsdk/react";
import {
  ambulanciaChannelId,
  PORTAL_AMBULANCIAS_ACTIVAS_CHANNEL_ID,
  rutaAmbulanciaChannelId,
} from "@/lib/portal/constants";
import type {
  AmbulanciaActivaPayload,
  AmbulancePositionPayload,
  RoutePublishPayload,
} from "@/lib/portal/messages";

// Issue #12/#15: cada ambulancia publica en su propio canal Portal (no uno compartido) — esta
// fila es la única forma de suscribirse dinámicamente a un canal por-id sin violar las rules of
// hooks (un componente por ambulanceId, cada uno con su propia llamada a useChannel).
function AmbulanceRow({ ambulanceId }: { ambulanceId: string }) {
  const [latestPosition, setLatestPosition] = useState<AmbulancePositionPayload | null>(null);
  const [positionUpdateCount, setPositionUpdateCount] = useState(0);

  const { messages: routeMessages, status: routeStatus } = useChannel<RoutePublishPayload>({
    channelId: rutaAmbulanciaChannelId(ambulanceId),
  });

  // onMessage es la forma documentada de observar envíos ephemeral (nunca llegan a `messages`,
  // que está ordenado por seq). Requiere el parche local a @portalsdk/core — ver CLAUDE.md.
  const { status: ambulanceStatus } = useChannel<AmbulancePositionPayload>({
    channelId: ambulanciaChannelId(ambulanceId),
    onMessage: (msg) => {
      setLatestPosition(msg.content);
      setPositionUpdateCount((count) => count + 1);
    },
  });

  const latestRoute = routeMessages[routeMessages.length - 1];

  return (
    <section className="mt-6 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <h2 className="font-medium">
        Ambulancia <code>{ambulanceId.slice(0, 8)}</code>
      </h2>
      <p className="text-xs text-zinc-500">
        <code>{rutaAmbulanciaChannelId(ambulanceId)}</code>: {routeStatus} ·{" "}
        <code>{ambulanciaChannelId(ambulanceId)}</code>: {ambulanceStatus}
      </p>

      <p className="mt-2 text-sm text-zinc-500">
        Ruta ({routeMessages.length} publicada{routeMessages.length === 1 ? "" : "s"}):{" "}
        {latestRoute ? (
          <>
            {(latestRoute.content.distanceMeters / 1000).toFixed(1)} km ·{" "}
            {Math.round(latestRoute.content.durationSeconds / 60)} min
          </>
        ) : (
          "sin ruta publicada todavía."
        )}
      </p>

      <p className="text-sm text-zinc-500">
        Posición ({positionUpdateCount} actualizaciones):{" "}
        {latestPosition ? (
          <>
            {latestPosition.lat.toFixed(5)}, {latestPosition.lng.toFixed(5)}
            {latestPosition.arrived ? " · llegó al hospital" : ""}
          </>
        ) : (
          "sin posición todavía."
        )}
      </p>
    </section>
  );
}

export default function AmbulanceWatchPage() {
  // Canal de descubrimiento: cada ambulancia anuncia su propio id acá al arrancar (una
  // publicación, no ephemeral) — sin esto no hay forma de saber de antemano qué canales
  // por-ambulancia existen para suscribirse dinámicamente.
  const { messages: registroMessages, status: registroStatus } =
    useChannel<AmbulanciaActivaPayload>({
      channelId: PORTAL_AMBULANCIAS_ACTIVAS_CHANNEL_ID,
    });

  const ambulanceIds = [...new Set(registroMessages.map((msg) => msg.content.ambulanceId))];

  return (
    <main className="mx-auto max-w-2xl p-8 font-sans">
      <h1 className="text-2xl font-semibold">Segundo cliente — ambulancias activas en vivo</h1>
      <p className="mt-1 text-sm text-zinc-500">
        <code>{PORTAL_AMBULANCIAS_ACTIVAS_CHANNEL_ID}</code>: {registroStatus} · {ambulanceIds.length}{" "}
        ambulancia{ambulanceIds.length === 1 ? "" : "s"} anunciada
        {ambulanceIds.length === 1 ? "" : "s"}
      </p>

      {ambulanceIds.length === 0 && (
        <p className="mt-6 text-sm text-zinc-500">
          Ninguna ambulancia anunciada todavía — arrancá una desde el mapa principal.
        </p>
      )}

      {ambulanceIds.map((ambulanceId) => (
        <AmbulanceRow key={ambulanceId} ambulanceId={ambulanceId} />
      ))}
    </main>
  );
}
