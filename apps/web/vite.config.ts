// SPDX-License-Identifier: AGPL-3.0-or-later
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development, forward API calls to the local API server.
    proxy: { "/healthz": "http://127.0.0.1:3000", "/api": "http://127.0.0.1:3000" },
  },
});
