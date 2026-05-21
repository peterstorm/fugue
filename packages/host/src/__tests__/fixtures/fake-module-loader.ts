/**
 * Fake Module Loader — canonical in-memory fake for ModuleLoaderPort.
 *
 * Returns all pre-configured paths without glob filtering — tests must
 * supply only the expected paths/results. Supports per-path error simulation
 * via the errors array.
 */

import { ok, err } from "@fugue/framework";
import type { Result } from "@fugue/framework";
import type { HostError } from "../../domain/host-error.js";
import type { ModuleLoaderPort, LoadResult, BulkLoadResult } from "../../adapters/module-loader.js";

export const createFakeModuleLoader = (
  dags: LoadResult[] = [],
  errors: Array<{ path: string; error: HostError }> = [],
): ModuleLoaderPort => ({
  loadDagModule: async (modulePath, _sha) => {
    const predefinedError = errors.find((e) => e.path === modulePath);
    if (predefinedError) return err(predefinedError.error);
    const found = dags.find((d) => d.modulePath === modulePath);
    if (found) return ok(found);
    return err({ kind: "import-failed", path: modulePath, message: "not found in fake" });
  },
  discoverDagPaths: async () => ok(dags.map((d) => d.modulePath)),
  loadAll: async () => ({ loaded: dags, errors }),
});
