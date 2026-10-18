// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  sourcemap: true,
  noExternal: [/^@riffle\//],
});
