/**
 * Next.js llama a `register()` una única vez, apenas arranca el proceso del servidor — antes de
 * que cualquier request real pueda llegar. Bug real encontrado post-#23: `reconciliarSimulacionesHuerfanas`
 * (`lib/tick/simulacion.ts`) es lazy — solo corre en el primer acceso a una función de
 * flota/simulación (dar de alta, detener, despachar). Si el proceso arranca y nadie dispara
 * ninguna de esas acciones antes de que un cliente cargue el mapa, la reconciliación nunca
 * corre — y el cliente lee `ambulancias-activas`/`ambulancias-detenidas` directo de Portal, sin
 * pasar por el servidor, así que sigue mostrando como "vivas" todas las ambulancias anunciadas
 * en procesos anteriores. Este hook la dispara proactivamente al boot, sin esperar ningún
 * request.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { reconciliarSimulacionesHuerfanas } = await import("@/lib/tick/simulacion");
    await reconciliarSimulacionesHuerfanas();
  }
}
