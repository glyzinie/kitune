import { getIPFromHeader } from "@better-auth/core/utils/ip";
import type { Config } from "./config";

type ClientIPConfig = Pick<Config, "trusted_ip_source">;

const IPV6_SUBNET = 64;
const LOCALHOST_IP = "127.0.0.1";
const LOCALHOST_IP_HEADER = "x-kitune-localhost-ip";
const headerBySource = {
  fly: "fly-client-ip",
  reverse_proxy: "x-forwarded-for",
} as const;

/** The exact IP input Better Auth may trust for this deployment. */
export function clientIPOptions(config: ClientIPConfig): { ipAddressHeaders: string[]; ipv6Subnet: number } {
  const header = config.trusted_ip_source === "localhost" ? LOCALHOST_IP_HEADER : headerBySource[config.trusted_ip_source];
  return { ipAddressHeaders: [header], ipv6Subnet: IPV6_SUBNET };
}

/** Resolve the same normalized rate-limit key used by Better Auth. */
export function clientIP(request: Request | Headers, config: ClientIPConfig): string | null {
  if (config.trusted_ip_source === "localhost") return LOCALHOST_IP;
  const headers = request instanceof Request ? request.headers : request;
  const header = headerBySource[config.trusted_ip_source];
  return getIPFromHeader(headers.get(header) ?? "", { ipv6Subnet: IPV6_SUBNET });
}

/** Add the fixed loopback source to the request Better Auth receives. */
export function clientIPRequest(request: Request, config: ClientIPConfig): Request {
  if (config.trusted_ip_source !== "localhost") return request;
  const headers = new Headers(request.headers);
  headers.set(LOCALHOST_IP_HEADER, LOCALHOST_IP);
  return new Request(request, { headers });
}
