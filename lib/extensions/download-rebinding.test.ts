import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));

vi.mock("node:dns/promises", () => ({
  lookup: mocks.lookup,
  default: { lookup: mocks.lookup },
}));
vi.mock("node:https", () => ({ request: mocks.request, default: { request: mocks.request } }));

import { downloadArtifact } from "./download";
import type { CatalogEntry } from "./manifest";

const entry: CatalogEntry = {
  publisher: "acme",
  name: "tarefas-praticas",
  version: "1.0.0",
  license: "MIT",
  host_api: { min: 1, max: 1 },
  permissions: ["navigation.tasks"],
  display: {
    title: { "pt-BR": "Tarefas" },
    summary: { "pt-BR": "Guia" },
    category: "productivity",
    icon: "ListChecks",
  },
  sha256: "a".repeat(64),
  byte_length: 1,
};

beforeEach(() => {
  mocks.lookup.mockReset();
  mocks.request.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("vínculo DNS do download", () => {
  it("usa no socket o endereço validado sem abrir uma segunda janela de resolução", async () => {
    mocks.lookup
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const connected: string[] = [];

    type MockRequestOptions = {
      lookup: (
        hostname: string,
        options: { all: boolean },
        callback: (error: Error | null, address: string) => void,
      ) => void;
      servername?: string;
    };
    mocks.request.mockImplementation(
      (url: URL, options: MockRequestOptions, onResponse: (response: Readable) => void) => {
        const req = new EventEmitter() as EventEmitter & { end(): void };
        req.end = () => {
          options.lookup(
            "catalog.example.test",
            { all: false },
            (error: Error | null, address: string) => {
              if (error) {
                req.emit("error", error);
                return;
              }
              connected.push(address);
              const response = Readable.from([Buffer.from("x")]) as Readable & {
                statusCode: number;
                headers: Record<string, string>;
              };
              response.statusCode = 200;
              response.headers = { "content-length": "1" };
              onResponse(response);
            },
          );
        };
        expect(url.hostname).toBe("catalog.example.test");
        expect(options.servername).toBe("catalog.example.test");
        return req;
      },
    );

    await expect(
      downloadArtifact("https://catalog.example.test", entry, {
        localCatalogOrigin: null,
        appUrl: "https://app.example.test",
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(connected).toEqual(["8.8.8.8"]);
  });

  it("recusa todo o conjunto se o DNS devolver endereço especial ou IPv4 mapeado", async () => {
    mocks.lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "::ffff:127.0.0.1", family: 6 },
    ]);

    const pending = downloadArtifact("https://catalog.example.test", entry, {
      localCatalogOrigin: null,
      appUrl: "https://app.example.test",
    });
    await expect(pending).rejects.toMatchObject({
      code: "extension_unsafe_origin",
    });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("inclui a resolução DNS no prazo total de quinze segundos", async () => {
    vi.useFakeTimers();
    mocks.lookup.mockReturnValue(new Promise(() => undefined));

    const pending = downloadArtifact("https://catalog.example.test", entry, {
      localCatalogOrigin: null,
      appUrl: "https://app.example.test",
    });
    const rejection = expect(pending).rejects.toMatchObject({ code: "extension_download_failed" });
    await vi.advanceTimersByTimeAsync(15_001);
    await rejection;
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
