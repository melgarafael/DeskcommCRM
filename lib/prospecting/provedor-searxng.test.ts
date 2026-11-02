import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const destino = vi.hoisted(() => ({ recusa: vi.fn() }));

vi.mock("@/lib/automation/destinos-internos-autorizados", () => ({
  motivoDaRecusaDeDestino: destino.recusa,
}));

import { ProspectingError } from "./provider";
import {
  provedorSearxng,
  searxngConfiguradoNaInstalacao,
  statusDaInstalacaoSearxng,
  validarSearxng,
} from "./provedor-searxng";
import { searchSchema } from "./schema";

const SEARCH = searchSchema.parse({
  name: "Clínicas de Campinas",
  niche: "clínica odontológica",
  location: "Campinas, SP",
  limit: 4,
  budget_usd: 1,
  enrich: false,
});

function resultado(url: string, extra: Record<string, unknown> = {}) {
  return {
    title: "Clínica Exemplo",
    url,
    content: "Contato: vendas@clinica.test · (19) 99999-1234",
    ...extra,
  };
}

describe("provedor SearXNG self-hosted", () => {
  const fetchOriginal = globalThis.fetch;

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.stubEnv("SEARXNG_BASE_URL", "https://busca.example.test/");
    vi.stubEnv("SEARXNG_INTERNAL_BASE_URL", "");
    vi.stubEnv("SEARXNG_INTERNAL_IP", "");
    destino.recusa.mockResolvedValue(null);
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.fetch = fetchOriginal;
  });

  it("usa a URL da instalação e devolve só sites comerciais HTTPS únicos", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      Response.json({
        results: [
          resultado("https://www.clinica.test/contato"),
          resultado("https://clinica.test/outra-pagina", { title: "Duplicada" }),
          resultado("https://facebook.com/clinica"),
          resultado("http://clinica-insegura.test/"),
          resultado("https://cylex.com.br/clinica", { title: "Agregador" }),
          resultado("javascript:alert(1)"),
        ],
      }),
    );

    const result = await provedorSearxng.startSearch("chave-ignorada", SEARCH);

    expect(result.status).toBe("SUCCEEDED");
    expect(result.usageTotalUsd).toBe(0);
    expect(result.results).toHaveLength(1);
    expect(result.results?.[0]).toMatchObject({
      title: "Clínica Exemplo",
      website: "https://www.clinica.test",
      categoryName: "clínica odontológica",
      emails: ["vendas@clinica.test"],
      phone: "(19) 99999-1234",
      address: null,
      url: null,
    });

    const [requestUrl, requestInit] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    const parsed = new URL(String(requestUrl));
    expect(parsed.origin).toBe("https://busca.example.test");
    expect(parsed.pathname).toBe("/search");
    expect(parsed.searchParams.get("format")).toBe("json");
    expect(parsed.searchParams.get("language")).toBe("pt-BR");
    expect(parsed.searchParams.get("safesearch")).toBe("1");
    expect(parsed.searchParams.get("q")).toContain("Campinas, SP");
    expect(requestInit).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
    expect(destino.recusa).toHaveBeenCalledWith("https://busca.example.test", "instalacao");
  });

  it("falha fechada em configuração dupla ou endereço inseguro, sem chamar o destino", async () => {
    vi.stubEnv("SEARXNG_INTERNAL_BASE_URL", "http://searxng-search:8080");
    vi.stubEnv("SEARXNG_INTERNAL_IP", "172.20.0.4");
    expect(searxngConfiguradoNaInstalacao()).toBe(false);
    expect(statusDaInstalacaoSearxng()).toBe("conflito");
    await expect(validarSearxng("")).rejects.toBeInstanceOf(ProspectingError);
    expect(globalThis.fetch).not.toHaveBeenCalled();

    vi.stubEnv("SEARXNG_INTERNAL_BASE_URL", "");
    vi.stubEnv("SEARXNG_INTERNAL_IP", "");
    vi.stubEnv("SEARXNG_BASE_URL", "http://127.0.0.1:8080");
    expect(searxngConfiguradoNaInstalacao()).toBe(false);
    expect(statusDaInstalacaoSearxng()).toBe("configuracao-invalida");
    await expect(validarSearxng("")).rejects.toThrow("HTTPS");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("respeita a política de saída antes de fazer a busca", async () => {
    destino.recusa.mockResolvedValue("destino_nao_autorizado");

    await expect(provedorSearxng.startSearch("", SEARCH)).rejects.toThrow(
      "destino_nao_autorizado",
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("nomeia quando a instância não permite JSON ou devolve resposta inválida", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("forbidden", { status: 403 }));
    await expect(validarSearxng("")).rejects.toThrow("permitir respostas JSON");

    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ nope: [] }));
    await expect(validarSearxng("")).rejects.toThrow("lista de resultados web");
  });
});
