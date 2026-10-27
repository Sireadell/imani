import type { NextConfig } from "next";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const config: NextConfig = {
  // imani reads its WebAssembly decoder from its own folder at run time, so Node must load it
  // directly instead of Next bundling it.
  serverExternalPackages: ["@sireadell/imani"],
  // In this repo, imani is linked from two folders up (file:../..). Next must be allowed to read
  // it. When you install imani from npm you can delete this file.
  turbopack: { root: resolve(dirname(fileURLToPath(import.meta.url)), "../..") },
};
export default config;
