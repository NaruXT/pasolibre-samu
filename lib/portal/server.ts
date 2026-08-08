const PORTAL_API_URL = (process.env.PORTAL_API_URL ?? "https://api.useportal.co").replace(
  /\/+$/,
  ""
);

interface PublishToPortalChannelInput {
  channelId: string;
  content: unknown;
  type?: string;
  /**
   * Requerido por el endpoint REST de publicación del servidor: a diferencia del SDK cliente
   * (que deriva el sender del token de auth de la conexión), una request con secret key no
   * tiene identidad de sesión, así que quien llama debe nombrar una. No documentado
   * públicamente — encontrado mediante una prueba en vivo.
   */
  senderId: string;
}

interface PortalPublishAck {
  id: string;
  seq: number;
  timestamp: number;
}

export async function publishToPortalChannel({
  channelId,
  content,
  type,
  senderId,
}: PublishToPortalChannelInput): Promise<PortalPublishAck> {
  const secret = process.env.PORTAL_SECRET;
  if (!secret) {
    throw new Error("PORTAL_SECRET is not set. Add it to .env (see .env.example).");
  }

  const response = await fetch(
    `${PORTAL_API_URL}/v1/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content, senderId, ...(type ? { type } : {}) }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Portal publish to "${channelId}" failed (${response.status}): ${body}`);
  }

  return response.json();
}
