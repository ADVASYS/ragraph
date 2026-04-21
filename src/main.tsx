import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import "./i18n";
import "./styles/globals.css";
import "katex/dist/katex.min.css";
import "@xyflow/react/dist/style.css";
import { App } from "./app/App";

const client = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <App />
      <Toaster position="bottom-right" richColors closeButton />
    </QueryClientProvider>
  </React.StrictMode>,
);
