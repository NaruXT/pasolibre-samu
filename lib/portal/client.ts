import { Portal } from "@portalsdk/core";

const apiKey = process.env.NEXT_PUBLIC_PORTAL_API_KEY;

/**
 * Solo se valida en el navegador. Este módulo, aunque es "use client", también se evalúa
 * server-side durante el SSR de CUALQUIER página (todo pasa por `PortalProviderClient` en el
 * layout raíz) — y ahí un throw a nivel de módulo tumba la página entera con un 500 en cada
 * request, incluso si la env var sí está disponible en el navegador. El SDK de Portal solo abre
 * conexiones reales desde hooks (`useChannel`, etc.) que nunca corren en SSR, así que no hace
 * falta una key válida todavía en ese contexto. Reproducido en vivo en Railway: cada página
 * (`/`, `/portal-test`, `/ambulance-watch`) daba 500 mientras rutas sin Portal (`/api/llm-cost`)
 * respondían bien — mismo bug de fondo que se arregló en `lib/portal/serverReader.ts`.
 */
if (typeof window !== "undefined" && !apiKey) {
  throw new Error(
    "NEXT_PUBLIC_PORTAL_API_KEY is not set. Add it to .env (see .env.example)."
  );
}

export const portalClient = new Portal({ apiKey: apiKey ?? "" });
