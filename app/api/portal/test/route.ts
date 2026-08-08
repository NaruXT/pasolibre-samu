import { NextResponse } from "next/server";
import { publishToPortalChannel } from "@/lib/portal/server";
import { PORTAL_SETUP_TEST_CHANNEL_ID } from "@/lib/portal/constants";

export async function POST() {
  try {
    const ack = await publishToPortalChannel({
      channelId: PORTAL_SETUP_TEST_CHANNEL_ID,
      content: { message: "hola desde el servidor", sentAt: new Date().toISOString() },
      type: "setup-check",
      senderId: "server-route-handler",
    });
    return NextResponse.json({ ok: true, ack });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 502 }
    );
  }
}
