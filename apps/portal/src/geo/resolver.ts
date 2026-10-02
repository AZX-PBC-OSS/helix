import { readFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { Reader, type CityResponse } from "mmdb-lib";
import type { GeoStatus } from "@azx-pbc/shared";

/**
 * Coarse IP geolocation for the Visitors view (ADR-0050). The lookup reads an
 * offline `.mmdb` file in process — there is no network call, and no visitor
 * address leaves the portal. Input is the network prefix the edge stored
 * (`a.b.c.0/24`, an IPv6 `/48`), never a full address.
 */

export interface GeoLocation {
  /** ISO 3166-1 alpha-2, e.g. `US`. */
  country: string;
  /** English country name when the database carries one. */
  countryName: string | null;
  /** First-level subdivision (state, province), English, when known. */
  region: string | null;
}

export interface GeoResolver {
  readonly status: GeoStatus;
  lookup(prefix: string): GeoLocation | null;
}

/**
 * Reports its own absence as a value, like `UnavailableDirectory`: the
 * Visitors view still shows counts, and says that location is unavailable.
 */
export class UnavailableGeoResolver implements GeoResolver {
  readonly status: GeoStatus;
  constructor(reason: string) {
    this.status = { available: false, reason, attribution: null };
  }
  lookup(): GeoLocation | null {
    return null;
  }
}

/** Fixed prefix → location table for tests and local fixtures. */
export class StaticGeoResolver implements GeoResolver {
  readonly status: GeoStatus = { available: true, reason: null, attribution: null };
  readonly #table: ReadonlyMap<string, GeoLocation>;
  constructor(table: Record<string, GeoLocation>) {
    this.#table = new Map(Object.entries(table));
  }
  lookup(prefix: string): GeoLocation | null {
    return isPublicPrefix(prefix) ? (this.#table.get(prefix) ?? null) : null;
  }
}

export class MmdbGeoResolver implements GeoResolver {
  readonly status: GeoStatus;
  readonly #reader: Reader<CityResponse>;

  constructor(db: Buffer) {
    this.#reader = new Reader<CityResponse>(db);
    this.status = {
      available: true,
      reason: null,
      attribution: attributionFor(this.#reader.metadata.databaseType),
    };
  }

  lookup(prefix: string): GeoLocation | null {
    if (!isPublicPrefix(prefix)) return null;
    const address = networkAddress(prefix);
    if (address === null) return null;
    let hit: CityResponse | null;
    try {
      hit = this.#reader.get(address);
    } catch {
      return null;
    }
    const country = hit?.country?.iso_code;
    if (!hit || !country) return null;
    return {
      country,
      countryName: hit.country?.names?.en ?? null,
      region: hit.subdivisions?.[0]?.names?.en ?? null,
    };
  }
}

/**
 * The licence notice the database's terms require next to its output. DB-IP
 * Lite is CC-BY 4.0; GeoLite2 requires its own notice. Anything else is the
 * operator's file and the operator's notice.
 */
function attributionFor(databaseType: string): GeoStatus["attribution"] {
  if (/dbip/i.test(databaseType)) {
    return { text: "IP geolocation by DB-IP", url: "https://db-ip.com" };
  }
  if (/geolite2/i.test(databaseType)) {
    return {
      text: "This product includes GeoLite2 data created by MaxMind",
      url: "https://www.maxmind.com",
    };
  }
  return null;
}

/** The prefix's network address, the form the reader takes. */
function networkAddress(prefix: string): string | null {
  const [address] = prefix.split("/");
  return address ? address : null;
}

/**
 * False for loopback, private, CGNAT, link-local and ULA networks — they have
 * no location, and a dev edge sees nothing else.
 */
export function isPublicPrefix(prefix: string): boolean {
  const address = networkAddress(prefix);
  if (address === null) return false;
  if (isIPv4(address)) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    return a < 224;
  }
  const first = Number.parseInt(address.split(":")[0] || "0", 16);
  if (first === 0) return false; // ::, ::1 and the IPv4-compatible block
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  return true;
}

export interface GeoLog {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

/**
 * Build the resolver from `PORTAL_GEOIP_DB_PATH`. Unset or unreadable degrades
 * to {@link UnavailableGeoResolver}; it never fails the boot, because visitor
 * counts are useful without location.
 */
export function createGeoResolverFromEnv(
  log: GeoLog,
  env: NodeJS.ProcessEnv = process.env,
): GeoResolver {
  const path = env.PORTAL_GEOIP_DB_PATH;
  if (!path) {
    log.info({}, "geoip: PORTAL_GEOIP_DB_PATH not set; visitor location is unavailable");
    return new UnavailableGeoResolver("No geolocation database is configured.");
  }
  try {
    const resolver = new MmdbGeoResolver(readFileSync(path));
    log.info({ path }, "geoip: database loaded");
    return resolver;
  } catch (err) {
    log.warn({ err, path }, "geoip: database could not be loaded; visitor location is unavailable");
    return new UnavailableGeoResolver("The geolocation database could not be loaded.");
  }
}
