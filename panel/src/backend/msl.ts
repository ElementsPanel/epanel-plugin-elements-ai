import { MslMirrorsService } from "../../../../../panel/plugins/instance/src/backend/service/msl_mirrors";
import { MINECRAFT_SERVERS } from "../../../../../panel/plugins/instance/src/minecraft";

export { MslMirrorsService, MINECRAFT_SERVERS };

const segment = { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$" };
const id = { type: "string", minLength: 1, maxLength: 200 };
const selection = { server: segment, version: segment, build: segment };
const paging = {
  search: { type: "string", maxLength: 100 },
  page: { type: "integer", minimum: 1, maximum: 10000 }
};
const define = (
  name: string,
  description: string,
  properties: object,
  required: string[] = []
) => ({
  type: "function",
  function: {
    name,
    description,
    parameters: { type: "object", properties, required, additionalProperties: false }
  }
});

export const mslDefinitions = [
  define(
    "list_msl_servers",
    "Index installable Minecraft server software from MSL. Pages contain 50 entries; optional search filters names. Use exact server IDs from results.",
    paging
  ),
  define(
    "list_msl_versions",
    "List available versions for an MSL server, with optional search and pagination. Never guess version IDs. Bedrock versions include the operating system.",
    { server: segment, ...paging },
    ["server"]
  ),
  define(
    "list_msl_builds",
    "List available builds for an exact MSL server and version, with optional search and pagination.",
    { server: segment, version: segment, ...paging },
    ["server", "version"]
  ),
  define(
    "get_msl_download",
    "Resolve a selected MSL artifact's official download link, file type and optional SHA-256. Read-only: does not download or install. Links may expire; download/create tools resolve fresh links themselves.",
    selection,
    Object.keys(selection)
  ),
  define(
    "download_msl_server",
    "Start downloading a selected MSL artifact into a stopped accessible instance's root using a generated new filename. Requires an idle node file downloader and returns immediately with the generated path. Continue other independent work, then call get_msl_download_status when no useful work remains. Does not extract, install, change settings or start the server. Never retry an uncertain request.",
    { daemonId: id, instanceUuid: id, ...selection },
    ["daemonId", "instanceUuid", ...Object.keys(selection)]
  ),
  define(
    "get_msl_download_status",
    "Wait for a previously accepted MSL file download using the exact returned path and instance IDs. In agent chat this call blocks and reports progress until the task completes, fails, or becomes unknown. Call it only after other useful tool work is finished; unknown does not authorize a retry.",
    { daemonId: id, instanceUuid: id, path: { type: "string", maxLength: 255 } },
    ["daemonId", "instanceUuid", "path"]
  ),
  define(
    "create_msl_instance",
    "Create an instance and start downloading/installing a selected MSL server. Returns immediately with the new instanceUuid and taskId. Continue other independent work, then call get_msl_install_status when no useful work remains. Supply a user-approved nickname, daemon ID, exact server/version/build, and optional existing Java executable path. Uses a new daemon-managed directory and generates the startup command. Forge/NeoForge run the official installer. Does not start the server or accept the Minecraft EULA. Never retry an uncertain creation.",
    {
      daemonId: id,
      nickname: { type: "string", minLength: 1, maxLength: 100 },
      ...selection,
      javaPath: { type: "string", minLength: 1, maxLength: 2048 }
    },
    ["daemonId", "nickname", ...Object.keys(selection)]
  ),
  define(
    "get_msl_install_status",
    "Wait for MSL installation using the returned taskId and instance IDs. In agent chat this call blocks and reports progress until installation completes or reaches another terminal state. Call it only after other useful tool work is finished. Download percentage 100 does not mean installation is finished. If task status is unknown, inspect the instance and terminal before taking any further action.",
    { daemonId: id, instanceUuid: id, taskId: id },
    ["daemonId", "instanceUuid", "taskId"]
  )
];
