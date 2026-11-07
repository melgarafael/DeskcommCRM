import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertCatalogOrigin,
  assertServiceOrigin,
  downloadArtifact,
  type DownloadPolicy,
} from "./download";
import { ExtensionError } from "./errors";
import type { CatalogEntry } from "./manifest";

describe("origem do serviço de um módulo conectado (spec 33, F1)", () => {
  const publico = { localCatalogOrigin: null, appUrl: "https://crm.exemplo.com" };
  const laboratorio = {
    localCatalogOrigin: "http://127.0.0.1:4010",
    appUrl: "http://localhost:3000",
  };

  it("aceita a origem HTTPS exata de um serviço público", () => {
    expect(() => assertServiceOrigin("https://modulo.exemplo.com", publico)).not.toThrow();
  });

  it.each([
    ["http sem laboratório", "http://modulo.exemplo.com", publico],
    ["credencial embutida", "https://user:senha@modulo.exemplo.com", publico],
    ["caminho", "https://modulo.exemplo.com/caminho", publico],
    ["barra final", "https://modulo.exemplo.com/", publico],
    ["query", "https://modulo.exemplo.com?q=1", publico],
    ["fragmento", "https://modulo.exemplo.com#f", publico],
    ["localhost", "https://localhost", publico],
    ["IP privado", "https://10.0.0.1", publico],
    ["IPv6 de loopback", "https://[::1]", publico],
    ["loopback sem a política de laboratório", "http://127.0.0.1:4010", publico],
  ])("recusa %s", (_nome, origem, politica) => {
    expect(() => assertServiceOrigin(origem, politica)).toThrow(ExtensionError);
  });

  it("o loopback de laboratório passa só com a política local ligada e a mesma origem", () => {
    expect(() => assertServiceOrigin("http://127.0.0.1:4010", laboratorio)).not.toThrow();
    expect(() => assertServiceOrigin("http://127.0.0.1:4011", laboratorio)).toThrow(
      ExtensionError,
    );
  });
});

const servers: Server[] = [];

async function fixture(handler: RequestListener): Promise<{ origin: string; server: Server }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

function entry(byteLength: number): CatalogEntry {
  return {
    publisher: "acme",
    name: "tarefas-praticas",
    version: "1.0.0",
    license: "MIT",
    host_api: { min: 1, max: 2 },
    permissions: ["navigation.tasks"],
    display: {
      title: { "pt-BR": "Tarefas" },
      summary: { "pt-BR": "Guia" },
      category: "productivity",
      icon: "ListChecks",
    },
    sha256: "a".repeat(64),
    byte_length: byteLength,
  };
}

function policy(origin: string, appUrl = "http://localhost:3000"): DownloadPolicy {
  return { localCatalogOrigin: origin, appUrl };
}

async function expectCode(promise: Promise<unknown>, code: ExtensionError["code"]) {
  try {
    await promise;
    throw new Error("Esperava ExtensionError");
  } catch (error) {
    expect(error).toBeInstanceOf(ExtensionError);
    expect((error as ExtensionError).code).toBe(code);
  }
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("downloadArtifact", () => {
  it("baixa somente o caminho derivado do digest, sem credenciais nem compressão", async () => {
    const body = new TextEncoder().encode('{"ok":true}');
    const seen: Array<{ url: string; authorization?: string; cookie?: string; encoding?: string }> =
      [];
    const { origin } = await fixture((request, response) => {
      seen.push({
        url: request.url ?? "",
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        encoding: request.headers["accept-encoding"],
      });
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": body.byteLength,
      });
      response.end(body);
    });

    const downloaded = await downloadArtifact(origin, entry(body.byteLength), policy(origin));
    expect(Array.from(downloaded)).toEqual(Array.from(body));
    expect(seen).toEqual([
      {
        url: `/packages/${"a".repeat(64)}.json`,
        authorization: undefined,
        cookie: undefined,
        encoding: "identity",
      },
    ]);
  });

  it("recusa redirects e transporte comprimido", async () => {
    const redirect = await fixture((_request, response) => {
      response.writeHead(302, { location: "http://127.0.0.1/roubado" }).end();
    });
    await expectCode(
      downloadArtifact(redirect.origin, entry(1), policy(redirect.origin)),
      "extension_download_failed",
    );

    const compressed = await fixture((_request, response) => {
      response.writeHead(200, { "content-encoding": "gzip" }).end("comprimido");
    });
    await expectCode(
      downloadArtifact(compressed.origin, entry(10), policy(compressed.origin)),
      "extension_download_failed",
    );
  });

  it("antecipa Content-Length excessivo e cancela stream que ultrapassa o teto real", async () => {
    const header = await fixture((_request, response) => {
      response.writeHead(200, { "content-length": 65_537 }).end();
    });
    await expectCode(
      downloadArtifact(header.origin, entry(65_536), policy(header.origin)),
      "extension_payload_too_large",
    );

    let connectionClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      connectionClosed = resolve;
    });
    const stream = await fixture((_request, response) => {
      response.once("close", connectionClosed);
      response.writeHead(200);
      response.write(Buffer.alloc(40_000));
      setImmediate(() => response.write(Buffer.alloc(40_000)));
    });
    await expectCode(
      downloadArtifact(stream.origin, entry(65_536), policy(stream.origin)),
      "extension_payload_too_large",
    );
    await expect(closed).resolves.toBeUndefined();
  });

  it.each([
    ["http://127.0.0.1:9000", "http://127.0.0.1:9000", "https://app.example.test"],
    ["http://127.0.0.2:9000", "http://127.0.0.2:9000", "http://localhost:3000"],
    ["http://127.0.0.1:9000", "http://127.0.0.1:9001", "http://localhost:3000"],
    ["https://127.0.0.1", null, "http://localhost:3000"],
    ["https://[::1]", null, "http://localhost:3000"],
    ["https://[::ffff:127.0.0.1]", null, "http://localhost:3000"],
    ["https://100.64.0.1", null, "http://localhost:3000"],
    ["https://169.254.1.1", null, "http://localhost:3000"],
    ["https://localhost", null, "http://localhost:3000"],
  ])("recusa origem insegura %s", async (origin, localCatalogOrigin, appUrl) => {
    await expectCode(
      downloadArtifact(origin, entry(1), { localCatalogOrigin, appUrl }),
      "extension_unsafe_origin",
    );
  });

  it("permite validar a política da origem antes do download", () => {
    expect(() =>
      assertCatalogOrigin("https://catalog.example.test", {
        localCatalogOrigin: null,
        appUrl: "https://app.example.test",
      }),
    ).not.toThrow();
    expect(() =>
      assertCatalogOrigin("http://catalog.example.test", {
        localCatalogOrigin: null,
        appUrl: "https://app.example.test",
      }),
    ).toThrow(ExtensionError);
  });

  it("recusa digest não canônico antes de construir o caminho", async () => {
    await expectCode(
      downloadArtifact(
        "https://catalog.example.test",
        { ...entry(1), sha256: "../segredo" },
        {
          localCatalogOrigin: null,
          appUrl: "https://app.example.test",
        },
      ),
      "extension_invalid_package",
    );
  });
});
