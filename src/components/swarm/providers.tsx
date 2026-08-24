"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      })
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

// Re-export the data hooks so the page can import everything from one place.
export {
  useSwarmState,
  useTick,
  useAutopilot,
  useToggleAgent,
  useIngestHits,
  usePreviewHits,
  useCreateMission,
} from "./hooks";
