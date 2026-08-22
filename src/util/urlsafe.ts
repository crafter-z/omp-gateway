/**
 * SSRF guard for attachment/media downloads (hermes parity: is_safe_url).
 * Only http(s) URLs to public hosts are allowed; loopback, private, link-local
 * and reserved ranges are rejected so a crafted attachment URL cannot reach
 * internal services.
 */
import { isIP } from "node:net";

/** RFC 1918 + other non-public IPv4 ranges (CIDR start + prefix length). */
const BLOCKED_IPV4: Array<{ start: number; bits: number }> = [
  { start: 0x00000000, bits: 8 }, // 0.0.0.0/8
  { start: 0x0a000000, bits: 8 }, // 10.0.0.0/8
  { start: 0x7f000000, bits: 8 }, // 127.0.0.0/8
  { start: 0xa9fe0000, bits: 16 }, // 169.254.0.0/16
  { start: 0xac100000, bits: 12 }, // 172.16.0.0/12
  { start: 0xc0000200, bits: 24 }, // 192.0.2.0/24
  { start: 0xc0a80000, bits: 16 }, // 192.168.0.0/16
  { start: 0xc6336400, bits: 24 }, // 198.51.100.0/24
  { start: 0xcb007100, bits: 24 }, // 203.0.113.0/24
  { start: 0xe0000000, bits: 4 }, // 224.0.0.0/4 (multicast)
  { start: 0xf0000000, bits: 4 }, // 240.0.0.0/4 (reserved)
  { start: 0xffffffff, bits: 32 }, // 255.255.255.255
];

function ipv4ToInt(octets: number[]): number {
  return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const value = ipv4ToInt(parts);
  for (const { start, bits } of BLOCKED_IPV4) {
    const mask = bits === 0 ? 0 : 0xffffffff << (32 - bits);
    if ((value & mask) === (start & mask)) return true;
  }
  return false;
}

const BLOCKED_IPV6_PREFIXES = ["::", "::1", "fc", "fd", "fe80", "ff"];

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return BLOCKED_IPV6_PREFIXES.some((p) => lower.startsWith(p));
}

/** Reject non-http(s) schemes, localhost, and private/loopback/link-local IPs. */
export function isSafeUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  const family = isIP(host);
  if (family === 4) return !isBlockedIpv4(host);
  if (family === 6) return !isBlockedIpv6(host);
  // Domain name: reject bare numeric-looking labels just in case.
  return host.includes(".");
}
