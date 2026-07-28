import "./styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "@/components/ui/sonner";
import { LocaleProvider } from "@/lib/i18n";
import { getActiveAccountId, shouldInvalidateVnuRefreshQuery, shouldRetryQuery, VNU_REFRESH_COMMITTED_EVENT } from "@/lib/api";
import { router } from "@/router";
import { HyeboardProvider } from "@/state";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: shouldRetryQuery } },
});

window.addEventListener(VNU_REFRESH_COMMITTED_EVENT, (event) => {
  const accountId = (event as CustomEvent<{ accountId?: unknown }>).detail?.accountId;
  if (typeof accountId !== "string") return;
  void queryClient.invalidateQueries({
    predicate: (query) => shouldInvalidateVnuRefreshQuery(query, accountId, getActiveAccountId()),
  });
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LocaleProvider>
        <HyeboardProvider>
          <RouterProvider router={router} />
          <Toaster />
        </HyeboardProvider>
      </LocaleProvider>
    </QueryClientProvider>
  </StrictMode>,
);
