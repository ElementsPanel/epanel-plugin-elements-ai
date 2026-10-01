import axios from "axios";
import { lookup, type LookupOptions, type LookupAddress } from "dns";
import { Agent as HttpAgent } from "http";
import { Agent as HttpsAgent } from "https";
import * as net from "net";

// The host still ships Node 14 declarations; BlockList is available in its Node 18+ runtime.
interface AddressBlockList {
  addSubnet(address: string, prefix: number, family: "ipv4" | "ipv6"): void;
  check(address: string, family: "ipv4" | "ipv6"): boolean;
}
const { BlockList } = net as typeof net & { BlockList: new () => AddressBlockList };
const { isIP } = net;

// Regular users' personal endpoints cannot proxy requests into the panel's intranet.
// Administrator presets may intentionally point to a local model server.
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["168.63.129.16", 32]
] as [string, number][]) {
  blocked.addSubnet(address, prefix, "ipv4");
  blocked.addSubnet(`64:ff9b::${address}`, 96 + prefix, "ipv6");
}
for (const [address, prefix] of [
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20]
] as [string, number][])
  blocked.addSubnet(address, prefix, "ipv6");
const publicV6 = new BlockList();
publicV6.addSubnet("2000::", 3, "ipv6");
publicV6.addSubnet("::ffff:0:0", 96, "ipv6");
publicV6.addSubnet("64:ff9b::", 96, "ipv6");

// Common proxy Fake-IP pools are resolution hints, never connection targets.
const fakeAddresses = new BlockList();
fakeAddresses.addSubnet("198.18.0.0", 15, "ipv4");
fakeAddresses.addSubnet("fdfe:dcba:9876::", 48, "ipv6");

function isFakeAddress(address: string) {
  const family = isIP(address);
  return (family === 4 || family === 6) &&
    fakeAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

export function isPublicAddress(address: string) {
  if (address.includes("%")) return false;
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 && publicV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export function assertPublicEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (isIP(host)
      ? !isPublicAddress(host)
      : !host.includes(".") || /\.(localhost|local)\.?$/.test(host))
  )
    throw new Error("Private model endpoint is not allowed");
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void;

const publicResolvers = [
  { url: "https://dns.alidns.com/resolve", address: "223.5.5.5" },
  { url: "https://cloudflare-dns.com/dns-query", address: "1.1.1.1" }
].map(({ url, address }) => ({
  url,
  agent: new HttpsAgent({
    // Pin the resolver connection to avoid consulting Fake-IP DNS again.
    // The URL hostname still supplies TLS certificate verification and SNI.
    lookup: ((_host: string, options: LookupOptions, callback: LookupCallback) => {
      if (options.all) callback(null, [{ address, family: 4 }]);
      else callback(null, address, 4);
    }) as import("net").LookupFunction
  })
}));

async function resolvePublicAddresses(host: string, family?: number): Promise<LookupAddress[]> {
  const types = family === 4 ? ["A"] : family === 6 ? ["AAAA"] : ["A", "AAAA"];
  let failure: unknown;
  for (const resolver of publicResolvers) {
    try {
      const answers = await Promise.all(types.map(async (type) => {
        const { data } = await axios.get<{
          Status: number;
          Answer?: { type: number; data: string }[];
        }>(resolver.url, {
          params: { name: host, type },
          headers: { Accept: "application/dns-json" },
          adapter: "http",
          proxy: false,
          httpsAgent: resolver.agent,
          responseType: "json",
          timeout: 5000,
          maxRedirects: 0,
          maxContentLength: 16 * 1024
        });
        if (data?.Status !== 0 || (data.Answer !== undefined && !Array.isArray(data.Answer)))
          throw new Error("Unable to resolve public model endpoint");
        return (data.Answer || [])
          .filter((entry) => entry.type === (type === "A" ? 1 : 28))
          .map((entry) => ({ address: entry.data, family: type === "A" ? 4 : 6 }));
      }));
      const addresses = ([] as LookupAddress[]).concat(...answers);
      if (!addresses.length) throw new Error("Unable to resolve public model endpoint");
      return addresses;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

export const lookupPublicAddress = (
  host: string,
  options: LookupOptions,
  callback: LookupCallback
) => {
  lookup(host, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 4);
    const finish = (resolved: LookupAddress[]) => {
      if (!resolved.length || resolved.some((entry) =>
        typeof entry.address !== "string" || !isPublicAddress(entry.address)))
        return callback(new Error("Private model endpoint is not allowed"), "", 4);
      if (options.all) callback(null, resolved);
      else callback(null, resolved[0].address, resolved[0].family);
    };
    if (addresses.length && addresses.every((entry) => isFakeAddress(entry.address))) {
      // Connect only to the verified real address, preserving private-network
      // and DNS-rebinding protection for ordinary users' personal models.
      resolvePublicAddresses(host, options.family).then(finish, (error) => callback(error, "", 4));
    } else finish(addresses);
  });
};

const agentOptions = {
  keepAlive: false,
  lookup: lookupPublicAddress as import("net").LookupFunction
};
const httpAgent = new HttpAgent(agentOptions);
const httpsAgent = new HttpsAgent(agentOptions);
export function modelTransport(endpoint: string, publicOnly: boolean) {
  if (!publicOnly) return {};
  assertPublicEndpoint(endpoint);
  return { adapter: "http" as const, proxy: false as const, httpAgent, httpsAgent };
}
