// Entry point for the hosted site's /api/check. Bundled into api/check.mjs by npm run relay:build.
import { checkApi } from "./check-api.ts";

export default checkApi();
