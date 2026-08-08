"use client";

import type { ReactNode } from "react";
import { PortalProvider } from "@portalsdk/react";
import { portalClient } from "@/lib/portal/client";

export function PortalProviderClient({ children }: { children: ReactNode }) {
  return <PortalProvider client={portalClient}>{children}</PortalProvider>;
}
