import { WebSocket as NodeWebSocket } from "ws";
import { Portal, type ChannelHandle } from "@portalsdk/core";
import { PORTAL_SEMAFOROS_CHANNEL_ID } from "./constants";
import type { AccionSemaforo, DecisionSemaforo } from "@/lib/tick/decision";

if (typeof globalThis.WebSocket === "undefined") {
  // El SDK de Portal solo usa el subconjunto estándar (send/close/addEventListener) que
  // comparten con el WebSocket del navegador — mismo patrón que usa "portal listen" del CLI.
  globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
}

const apiKeyEnv = process.env.NEXT_PUBLIC_PORTAL_API_KEY;
if (!apiKeyEnv) {
  throw new Error("NEXT_PUBLIC_PORTAL_API_KEY is not set. Add it to .env (see .env.example).");
}
// Reasignado a una const de tipo `string`: el narrowing del guard de arriba no sobrevive
// dentro de la función más abajo, que TypeScript trata como un closure diferido.
const apiKey: string = apiKeyEnv;

// Cacheado en globalThis para sobrevivir al HMR de Next.js en dev — evita abrir una conexión
// WebSocket nueva cada vez que este módulo se recarga (ver CLAUDE.md, ticket #7).
const cachePortal = globalThis as unknown as {
  __portalServerReader?: Portal;
  __canalDecisiones?: ChannelHandle<DecisionSemaforo>;
};

function obtenerPortalReader(): Portal {
  if (!cachePortal.__portalServerReader) {
    cachePortal.__portalServerReader = new Portal({ apiKey });
  }
  return cachePortal.__portalServerReader;
}

function obtenerCanalDecisiones(): ChannelHandle<DecisionSemaforo> {
  // Se cachea el handle en sí (no solo un flag de "ya adquirido"): el SDK cuenta el acquire()
  // por objeto de handle, así que si no se retiene ESE objeto, lo recolecta el GC y avisa
  // "outstanding acquire()" aunque la conexión subyacente siga viva.
  if (!cachePortal.__canalDecisiones) {
    // history: 500 es un tope generoso para el puñado de semáforos de este proyecto, pero es
    // un tope: decisiones más allá de los últimos 500 mensajes del canal dejarían de contar
    // como "ya decidido". No relevante mientras el canal no acumule tráfico real.
    const canal = obtenerPortalReader().channel<DecisionSemaforo>(PORTAL_SEMAFOROS_CHANNEL_ID, {
      history: 500,
    });
    // Nunca se llama canal.release(): es un singleton de servidor de vida larga, no una
    // suscripción por-request — se queda adquirido mientras el proceso viva.
    canal.acquire();
    cachePortal.__canalDecisiones = canal;
  }
  return cachePortal.__canalDecisiones;
}

function esperarListo(canal: ChannelHandle<DecisionSemaforo>, timeoutMs = 5000): Promise<void> {
  if (canal.status === "ready") return Promise.resolve();

  return new Promise((resolve, reject) => {
    let cancelarSuscripcion: () => void = () => {};

    const temporizador = setTimeout(() => {
      cancelarSuscripcion();
      reject(
        new Error(`Portal: tiempo de espera agotado conectando a ${PORTAL_SEMAFOROS_CHANNEL_ID}`)
      );
    }, timeoutMs);

    cancelarSuscripcion = canal.on("status", (status, error) => {
      if (status === "ready") {
        clearTimeout(temporizador);
        cancelarSuscripcion();
        resolve();
      } else if (status === "blocked") {
        clearTimeout(temporizador);
        cancelarSuscripcion();
        reject(error ?? new Error("Portal: conexión bloqueada"));
      }
    });
  });
}

/**
 * Acciones ya publicadas para `semaforoId` en semaforos-ruta-1 — fuente de verdad de
 * intervenciones (ver CLAUDE.md). Filtra solo por `semaforoId`, sin acotar por trayecto: no
 * existe ningún `tripId` en este proyecto todavía, así que una decisión de un trayecto
 * anterior para el mismo semaforoId cuenta como "ya decidido" también en uno nuevo —
 * limitación conocida, documentada también en `orquestarTick`.
 *
 * La lectura vía REST con secret key está confirmada rota (siempre devuelve vacío, sin
 * importar lo publicado); esto usa el mismo protocolo WebSocket anónimo que un cliente
 * normal, igual que "portal listen" de @portalsdk/cli.
 */
export async function obtenerAccionesPreviasSemaforo(
  semaforoId: string
): Promise<AccionSemaforo[]> {
  const canal = obtenerCanalDecisiones();
  await esperarListo(canal);
  return canal.messages
    .filter((mensaje) => mensaje.content.semaforoId === semaforoId)
    .map((mensaje) => mensaje.content.accion);
}
