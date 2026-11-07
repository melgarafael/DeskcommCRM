import { describe, expect, it } from "vitest";

import type { ExtensionCatalog } from "./manifest";
import { servicoDoModulo } from "./servico-do-modulo";

const display = {
  title: { "pt-BR": "Módulo de teste" },
  summary: { "pt-BR": "Entrada de catálogo para os testes." },
  category: "service" as const,
  icon: "ListChecks" as const,
};

const catalogo: ExtensionCatalog = {
  format_version: 1,
  origin: "https://catalogo.exemplo.com",
  revision: 1,
  entries: [
    {
      publisher: "acme",
      name: "servico",
      version: "1.0.0",
      license: "MIT",
      host_api: { min: 2, max: 2 },
      display,
      permissions: ["area.contatos.leitura"],
      sha256: "a".repeat(64),
      byte_length: 100,
      service_origin: "https://servico.exemplo.com",
    },
    {
      publisher: "acme",
      name: "guia",
      version: "1.0.0",
      license: "MIT",
      host_api: { min: 2, max: 2 },
      display,
      permissions: ["navigation.tasks"],
      sha256: "b".repeat(64),
      byte_length: 100,
    },
  ],
};

describe("servicoDoModulo", () => {
  it("devolve a origem da entrada certa, pelo publicador, nome e versão", () => {
    expect(servicoDoModulo(catalogo, "acme", "servico", "1.0.0")).toBe(
      "https://servico.exemplo.com",
    );
  });

  it("devolve null para entrada sem service_origin", () => {
    expect(servicoDoModulo(catalogo, "acme", "guia", "1.0.0")).toBeNull();
  });

  it("devolve null para entrada inexistente, inclusive outra versão", () => {
    expect(servicoDoModulo(catalogo, "acme", "servico", "2.0.0")).toBeNull();
    expect(servicoDoModulo(catalogo, "outro", "servico", "1.0.0")).toBeNull();
  });
});
