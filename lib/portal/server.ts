const PORTAL_API_URL = (process.env.PORTAL_API_URL ?? "https://api.useportal.co").replace(
  /\/+$/,
  ""
);

interface PublishToPortalChannelInput {
  channelId: string;
  content: unknown;
  type?: string;
  /**
   * Required by the server REST publish endpoint: unlike the client SDK (which derives the
   * sender from the connection's auth token), a secret-key request has no session identity,
   * so the caller must name one. Not documented publicly — found via a live smoke test.
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
