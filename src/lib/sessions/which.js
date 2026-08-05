import { PROVIDERS } from "@/lib/sessions/providers";

/**
 * Detect which AI CLIs are on PATH.
 * @returns {Promise<Array<{id:string,displayName:string,binary:string}>>}
 */
export async function detectInstalled() {
  const checks = PROVIDERS.map(async (provider) => {
    for (const name of provider.binaries) {
      try {
        const result = await muxy.exec(["bash", "-lc", `command -v ${name}`], {
          timeoutMs: 5000,
        });
        const path = String(result.stdout ?? "").trim();
        if ((result.exitCode === 0 || result.code === 0) && path) {
          return {
            id: provider.id,
            displayName: provider.displayName,
            binary: provider.binary,
            path,
          };
        }
      } catch {
        // try next name
      }
    }
    return null;
  });
  const results = await Promise.all(checks);
  return results.filter(Boolean);
}
