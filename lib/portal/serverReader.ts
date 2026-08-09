import { WebSocket as NodeWebSocket } from "ws";
import { Portal, type ChannelHandle, type ChannelOptions } from "@portalsdk/core";
import { PORTAL_SEMAFOROS_CHANNEL_ID } from "./constants";
import type { AccionSemaforo, DecisionSemaforoPublicada } from "@/lib/tick/decision";

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
// WebSocket nueva cada vez que este módulo se recarga (ver CLAUDE.md, ticket #7). Issue #12/#16:
// generalizado de "un solo canal fijo" a un mapa por channelId — el endpoint de ingestión GPS
// real necesita canales dinámicos por ambulancia sobre la misma conexión.
const cachePortal = globalThis as unknown as {
  __portalServerReader?: Portal;
  __canalesServidor?: Map<string, ChannelHandle<unknown>>;
  __canalesConBackfillListo?: Set<string>;
};

function obtenerPortalReader(): Portal {
  if (!cachePortal.__portalServerReader) {
    cachePortal.__portalServerReader = new Portal({ apiKey });
  }
  return cachePortal.__portalServerReader;
}

function esperarListo(canal: ChannelHandle<unknown>, channelId: string, timeoutMs = 5000): Promise<void> {
  if (canal.status === "ready") return Promise.resolve();

  return new Promise((resolve, reject) => {
    let cancelarSuscripcion: () => void = () => {};

    const temporizador = setTimeout(() => {
      cancelarSuscripcion();
      reject(new Error(`Portal: tiempo de espera agotado conectando a ${channelId}`));
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
 * Canal Portal del lado servidor, listo para leer/publicar (`.messages`, `.send()`) — mismo
 * protocolo WebSocket anónimo que un cliente normal, igual que "portal listen" de
 * `@portalsdk/cli`. La lectura vía REST con secret key está confirmada rota (siempre devuelve
 * vacío); la escritura vía REST funciona pero no soporta `ephemeral` (ver `lib/portal/server.ts`
 * y el invariante de CLAUDE.md) — esta es la única vía que soporta ambas cosas desde el server.
 *
 * Cacheado por `channelId`, no solo un handle fijo: cada canal se adquiere una única vez y
 * nunca se libera (`release()`) — son singletons de servidor de vida larga, no suscripciones
 * por-request, igual que el canal de decisiones original de este archivo.
 */
export async function obtenerCanalServidor<M>(
  channelId: string,
  options?: ChannelOptions
): Promise<ChannelHandle<M>> {
  if (!cachePortal.__canalesServidor) cachePortal.__canalesServidor = new Map();

  let canal = cachePortal.__canalesServidor.get(channelId) as ChannelHandle<M> | undefined;
  if (!canal) {
    canal = obtenerPortalReader().channel<M>(channelId, options);
    canal.acquire();
    cachePortal.__canalesServidor.set(channelId, canal as ChannelHandle<unknown>);
  }
  await esperarListo(canal as ChannelHandle<unknown>, channelId);
  return canal;
}

/**
 * Espera a que el backfill de historial de `channelId` termine de llegar — bug real descubierto
 * en vivo (issue #12/#16, confirmado también del lado servidor): `status === "ready"` NO alcanza,
 * el backfill llega en un evento *posterior* separado vía `subscribe()` (ver el fix equivalente
 * en `EmergencyMap.tsx#esperarPrimerMensaje`, y la nota de CLAUDE.md). Sin esto, una lectura de
 * `.messages` justo después de que el proceso arranca (primer acceso a un canal en frío) puede
 * devolver una lista vacía aunque sí haya historial real.
 *
 * Cacheado por `channelId` (una sola espera por canal por vida del proceso): llamadas repetidas
 * para el mismo canal ya cargado devuelven al instante, en vez de re-esperar cada vez — necesario
 * porque `obtenerAccionesPreviasSemaforo` se llama una vez por semáforo por tick.
 *
 * Solo hace falta antes de leer `.messages` para algo que dependa de precisión — no hace falta
 * si el canal se va a usar únicamente para publicar (`.send()`), donde no importa qué historial
 * ya tenía.
 */
export async function esperarBackfillDe(
  channelId: string,
  canal: ChannelHandle<unknown>,
  timeoutMs = 3000
): Promise<void> {
  if (!cachePortal.__canalesConBackfillListo) cachePortal.__canalesConBackfillListo = new Set();
  if (cachePortal.__canalesConBackfillListo.has(channelId)) return;

  await new Promise<void>((resolve) => {
    let cancelar: () => void = () => {};
    const temporizador = setTimeout(() => {
      cancelar();
      resolve();
    }, timeoutMs);
    cancelar = canal.subscribe(() => {
      clearTimeout(temporizador);
      cancelar();
      resolve();
    });
  });

  cachePortal.__canalesConBackfillListo.add(channelId);
}

/**
 * Acciones ya publicadas para `(semaforoId, ambulanceId)` en semaforos-ruta-1 — fuente de
 * verdad de intervenciones (ver CLAUDE.md). Issue #12/#14: filtra por ambos campos, no solo
 * `semaforoId` — resuelve el gap documentado desde ticket #7 (una decisión de un trayecto
 * anterior, o de otra ambulancia activa a la vez, ya no bloquea una decisión nueva para el
 * mismo semáforo en un trayecto distinto).
 */
export async function obtenerAccionesPreviasSemaforo(
  semaforoId: string,
  ambulanceId: string
): Promise<AccionSemaforo[]> {
  // history: 500 es un tope generoso para el puñado de semáforos de este proyecto, pero es
  // un tope: decisiones más allá de los últimos 500 mensajes del canal dejarían de contar
  // como "ya decidido". No relevante mientras el canal no acumule tráfico real.
  const canal = await obtenerCanalServidor<DecisionSemaforoPublicada>(PORTAL_SEMAFOROS_CHANNEL_ID, {
    history: 500,
  });
  await esperarBackfillDe(PORTAL_SEMAFOROS_CHANNEL_ID, canal);
  return canal.messages
    .filter(
      (mensaje) =>
        mensaje.content.semaforoId === semaforoId && mensaje.content.ambulanceId === ambulanceId
    )
    .map((mensaje) => mensaje.content.accion);
}
