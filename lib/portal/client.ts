import { Portal } from "@portalsdk/core";

const apiKey = process.env.NEXT_PUBLIC_PORTAL_API_KEY;

if (!apiKey) {
  throw new Error(
    "NEXT_PUBLIC_PORTAL_API_KEY is not set. Add it to .env (see .env.example)."
  );
}

export const portalClient = new Portal({ apiKey });
