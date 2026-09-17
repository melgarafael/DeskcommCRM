import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import type { LookupAddress, LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";

import ipaddr from "ipaddr.js";

import { ExtensionError, isExtensionError } from "./errors";
import { EXTENSION_LIMITS, type CatalogEntry } from "./manifest";

export interface DownloadPolicy {
  localCatalogOrigin: string | null;
  appUrl: string;
}

const DOWNLOAD_TIMEOUT_MS = 15_000;

function unsafe(cause?: unknown): never {
  throw new ExtensionError("extension_unsafe_origin", cause === undefined ? undefined : { cause });
}

function hostnameWithoutBrackets(hostname: string) {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function parseExactOrigin(origin: string) {
  let url: URL;
  try {
    url = new URL(origin);
  } catch (error) {
    unsafe(error);
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.origin !== origin
  ) {
    unsafe();
  }
  return url;
}

function isLoopbackAppUrl(appUrl: string) {
  try {
    const url = new URL(appUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = hostnameWithoutBrackets(url.hostname).toLowerCase();
    if (hostname === "localhost") return true;
    return ipaddr.isValid(hostname) && ipaddr.process(hostname).range() === "loopback";
  } catch {
    return false;
  }
}

function isAllowedLocalOrigin(url: URL, origin: string, policy: DownloadPolicy) {
  return (
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    policy.localCatalogOrigin === origin &&
    isLoopbackAppUrl(policy.appUrl)
  );
}

function validateCatalogOrigin(origin: string, policy: DownloadPolicy) {
  const url = parseExactOrigin(origin);
  const isLocal = isAllowedLocalOrigin(url, origin, policy);
  if (!isLocal && url.protocol !== "https:") unsafe();
  if (!isLocal && /(^|\.)localhost$/i.test(hostnameWithoutBrackets(url.hostname))) unsafe();
  if (
    !isLocal &&
    ipaddr.isValid(hostnameWithoutBrackets(url.hostname)) &&
    !isPublicAddress(hostnameWithoutBrackets(url.hostname))
  ) {
    unsafe();
  }
  return { url, isLocal };
}

/** Validação síncrona para a admissão; DNS continua vinculado ao socket no download. */
export function assertCatalogOrigin(origin: string, policy: DownloadPolicy): void {
  validateCatalogOrigin(origin, policy);
}

function isPublicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

async function resolvePublicAddresses(hostname: string, signal: AbortSignal) {
  const literal = hostnameWithoutBrackets(hostname);
  const addresses: LookupAddress[] = ipaddr.isValid(literal)
    ? [{ address: literal, family: ipaddr.process(literal).kind() === "ipv4" ? 4 : 6 }]
    : await waitWithSignal(lookup(literal, { all: true, verbatim: true }), signal);

  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    unsafe();
  }
  return addresses;
}

/** O socket recebe somente os endereços já classificados; não há segunda resolução DNS. */
function pinnedLookup(expectedHostname: string, addresses: LookupAddress[]): LookupFunction {
  return (hostname, options: LookupOptions, callback) => {
    if (hostname !== expectedHostname) {
      callback(Object.assign(new Error("Hostname inesperado."), { code: "EHOSTUNREACH" }), "", 0);
      return;
    }
    if (options.all) {
      callback(null, addresses);
      return;
    }
    const first = addresses[0];
    if (!first) {
      callback(
        Object.assign(new Error("Sem endereço resolvido."), { code: "EHOSTUNREACH" }),
        "",
        0,
      );
      return;
    }
    callback(null, first.address, first.family);
  };
}

async function readResponse(response: http.IncomingMessage, entry: CatalogEntry) {
  if (response.statusCode !== 200) {
    response.destroy();
    throw new ExtensionError("extension_download_failed", {
      cause: { code: "http_status", status: response.statusCode },
    });
  }

  const encoding = response.headers["content-encoding"];
  if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") {
    response.destroy();
    throw new ExtensionError("extension_download_failed", {
      cause: { code: "content_encoding" },
    });
  }

  const contentLengthHeader = response.headers["content-length"];
  if (contentLengthHeader !== undefined) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      response.destroy();
      throw new ExtensionError("extension_download_failed", {
        cause: { code: "content_length" },
      });
    }
    if (contentLength > EXTENSION_LIMITS.packageBytes) {
      response.destroy();
      throw new ExtensionError("extension_payload_too_large");
    }
    if (contentLength > entry.byte_length) {
      response.destroy();
      throw new ExtensionError("extension_invalid_package");
    }
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response) {
    const bytes =
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    total += bytes.byteLength;
    if (total > EXTENSION_LIMITS.packageBytes) {
      response.destroy();
      throw new ExtensionError("extension_payload_too_large");
    }
    if (total > entry.byte_length) {
      response.destroy();
      throw new ExtensionError("extension_invalid_package");
    }
    chunks.push(bytes);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function requestBytes(
  url: URL,
  entry: CatalogEntry,
  signal: AbortSignal,
  lookupFunction?: LookupFunction,
) {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise<Uint8Array>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: "GET",
        headers: { accept: "application/json", "accept-encoding": "identity" },
        agent: false,
        signal,
        lookup: lookupFunction,
        ...(url.protocol === "https:" && !ipaddr.isValid(hostnameWithoutBrackets(url.hostname))
          ? { servername: hostnameWithoutBrackets(url.hostname) }
          : {}),
      },
      (response) => {
        readResponse(response, entry).then(resolve, reject);
      },
    );
    request.once("error", reject);
    request.end();
  });
}

export async function downloadArtifact(
  origin: string,
  entry: CatalogEntry,
  policy: DownloadPolicy,
): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Prazo total do download excedido.")),
    DOWNLOAD_TIMEOUT_MS,
  );

  try {
    if (
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.byte_length) ||
      entry.byte_length < 1 ||
      entry.byte_length > EXTENSION_LIMITS.packageBytes
    ) {
      throw new ExtensionError("extension_invalid_package");
    }
    const { url: originUrl, isLocal } = validateCatalogOrigin(origin, policy);

    let lookupFunction: LookupFunction | undefined;
    if (!isLocal) {
      const addresses = await resolvePublicAddresses(originUrl.hostname, controller.signal);
      lookupFunction = pinnedLookup(hostnameWithoutBrackets(originUrl.hostname), addresses);
    }

    const url = new URL(`/packages/${entry.sha256}.json`, originUrl);
    return await requestBytes(url, entry, controller.signal, lookupFunction);
  } catch (error) {
    if (isExtensionError(error)) throw error;
    throw new ExtensionError("extension_download_failed", { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}
