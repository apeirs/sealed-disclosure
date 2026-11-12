import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
// @ts-expect-error plain ESM module shared with server.mjs
import { gatewayMiddleware } from "./gateway.mjs";

/** The chain's REST API sends no CORS headers: serve a read-only gateway on the same origin. */
function chainGateway(): Plugin {
  return {
    name: "sealed-disclosure-chain-gateway",
    configureServer(server) {
      server.middlewares.use(gatewayMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(gatewayMiddleware());
    },
  };
}

export default defineConfig({
  plugins: [react(), chainGateway()],
  server: { port: 5173 },
  preview: { port: 4173 },
  build: { chunkSizeWarningLimit: 4000 },
});
