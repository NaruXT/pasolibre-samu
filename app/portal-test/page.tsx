"use client";

import { useState } from "react";
import { useChannel } from "@portalsdk/react";
import { PORTAL_SETUP_TEST_CHANNEL_ID } from "@/lib/portal/constants";

const CHANNEL_ID = PORTAL_SETUP_TEST_CHANNEL_ID;

export default function PortalTestPage() {
  const { messages, send, status } = useChannel<{ message: string; sentAt: string }>({
    channelId: CHANNEL_ID,
  });
  const [serverResult, setServerResult] = useState<string | null>(null);

  async function sendFromClient() {
    await send({
      content: { message: "hola desde el cliente", sentAt: new Date().toISOString() },
      type: "setup-check",
    });
  }

  async function sendFromServer() {
    setServerResult("Enviando...");
    const response = await fetch("/api/portal/test", { method: "POST" });
    const body = await response.json();
    setServerResult(JSON.stringify(body));
  }

  return (
    <main className="mx-auto max-w-2xl p-8 font-sans">
      <h1 className="text-2xl font-semibold">Portal SDK — prueba de ida y vuelta</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Canal: <code>{CHANNEL_ID}</code> · Estado: {status}
      </p>

      <div className="mt-6 flex gap-3">
        <button
          onClick={sendFromClient}
          className="rounded bg-black px-4 py-2 text-white dark:bg-white dark:text-black"
        >
          Publicar desde el cliente
        </button>
        <button
          onClick={sendFromServer}
          className="rounded border border-black px-4 py-2 dark:border-white"
        >
          Publicar desde el servidor
        </button>
      </div>

      {serverResult && <p className="mt-3 text-sm text-zinc-500">{serverResult}</p>}

      <ul className="mt-6 flex flex-col gap-2">
        {messages.map((msg) => (
          <li key={msg.id} className="rounded border border-zinc-200 p-3 text-sm dark:border-zinc-800">
            <span className="font-mono text-xs text-zinc-400">
              {msg.sender.anon ? `anon:${msg.sender.id}` : msg.sender.id}
            </span>
            <pre className="mt-1 whitespace-pre-wrap">{JSON.stringify(msg.content, null, 2)}</pre>
          </li>
        ))}
      </ul>
    </main>
  );
}
