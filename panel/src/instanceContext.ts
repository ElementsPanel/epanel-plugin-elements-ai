import type { InstanceTarget } from "./types";

type RouteLike = {
  path?: unknown;
  query?: Record<string, unknown>;
};

const instancePagePrefixes = ["/instances/terminal"];
const instancePagePaths = new Set(["/instances/schedule"]);

function queryValue(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string")
    return value[0] || undefined;
  return undefined;
}

function isInstancePage(path: unknown): path is string {
  if (typeof path !== "string") return false;
  return (
    instancePagePaths.has(path) ||
    instancePagePrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  );
}

export function currentInstanceFromRoute(route: RouteLike): InstanceTarget | undefined {
  if (!isInstancePage(route.path)) return undefined;
  const daemonId = queryValue(route.query?.daemonId);
  const instanceUuid = queryValue(route.query?.instanceId);
  if (!daemonId || !instanceUuid) return undefined;
  return { daemonId, instanceUuid };
}
