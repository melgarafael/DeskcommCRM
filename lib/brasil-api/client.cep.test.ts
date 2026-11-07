/**
 * O CEP no MESMO cliente HTTP do CNPJ (#3494, fatia 2).
 *
 * O que se mede aqui é o contrato que a rota depende: a URL (`/cep/v1/...`), o
 * `User-Agent` explícito que a borda da BrasilAPI exige — o mesmo motivo já
 * documentado no CNPJ — e as famílias de erro que a tela distingue (CEP que não
 * existe × serviço fora do ar × CEP malformado, que nem sai para a rede).
 */
import { describe, expect, it, vi } from "vitest";

import { createBrasilApiClient } from "@/lib/brasil-api/client";

function resposta(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CEP_OK = {
  cep: "01310-100",
  state: "SP",
  city: "São Paulo",
  neighborhood: "Bela Vista",
  street: "Avenida Paulista",
  service: "open-cep",
};

describe("createBrasilApiClient().lookupCep", () => {
  it("consulta /cep/v1 com o User-Agent explícito e devolve o endereço", async () => {
    const fetchFn = vi.fn(async () => resposta(CEP_OK));
    const client = createBrasilApiClient({ fetchFn: fetchFn as unknown as typeof fetch });

    const resultado = await client.lookupCep("01310100");

    expect(resultado.ok).toBe(true);
    if (resultado.ok) {
      expect(resultado.data.city).toBe("São Paulo");
      expect(resultado.data.neighborhood).toBe("Bela Vista");
      expect(resultado.data.street).toBe("Avenida Paulista");
      expect(resultado.data.state).toBe("SP");
    }
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://brasilapi.com.br/api/cep/v1/01310100");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe("self-hosted-crm/1.0");
  });

  it("aceita o CEP com máscara — os dígitos são o que vai na URL", async () => {
    const fetchFn = vi.fn(async () => resposta(CEP_OK));
    const client = createBrasilApiClient({ fetchFn: fetchFn as unknown as typeof fetch });

    await client.lookupCep("01310-100");

    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://brasilapi.com.br/api/cep/v1/01310100");
  });

  it("7 dígitos não saem para a rede: invalid_cep", async () => {
    const fetchFn = vi.fn(async () => resposta(CEP_OK));
    const client = createBrasilApiClient({ fetchFn: fetchFn as unknown as typeof fetch });

    const resultado = await client.lookupCep("0131010");

    expect(resultado).toMatchObject({ ok: false, code: "invalid_cep" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("404 vira not_found, sem derrubar quem chamou", async () => {
    const fetchFn = vi.fn(async () => resposta({ message: "CEP não encontrado" }, 404));
    const client = createBrasilApiClient({ fetchFn: fetchFn as unknown as typeof fetch });

    await expect(client.lookupCep("99999999")).resolves.toMatchObject({
      ok: false,
      code: "not_found",
      status: 404,
    });
  });

  it("erro do serviço vira upstream_error com o status", async () => {
    const fetchFn = vi.fn(async () => resposta({ message: "boom" }, 500));
    const client = createBrasilApiClient({ fetchFn: fetchFn as unknown as typeof fetch });

    await expect(client.lookupCep("01310100")).resolves.toMatchObject({
      ok: false,
      code: "upstream_error",
      status: 500,
    });
  });

  it("rede fora vira upstream_error, não exceção", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = createBrasilApiClient({ fetchFn: fetchFn as unknown as typeof fetch });

    await expect(client.lookupCep("01310100")).resolves.toMatchObject({
      ok: false,
      code: "upstream_error",
    });
  });

  it("timeout vira timeout, não exceção", async () => {
    const fetchFn = vi.fn(async () => {
      const erro = new Error("aborted");
      erro.name = "AbortError";
      throw erro;
    });
    const client = createBrasilApiClient({ fetchFn: fetchFn as unknown as typeof fetch });

    await expect(client.lookupCep("01310100")).resolves.toMatchObject({
      ok: false,
      code: "timeout",
    });
  });

  it("resposta sem cidade nem UF é incompleta; só cidade (CEP geral) é válida", async () => {
    const vazio = createBrasilApiClient({
      fetchFn: (async () => resposta({ cep: "01310-100" })) as unknown as typeof fetch,
    });
    await expect(vazio.lookupCep("01310100")).resolves.toMatchObject({
      ok: false,
      code: "incomplete",
    });

    const cepGeral = createBrasilApiClient({
      fetchFn: (async () =>
        resposta({ cep: "69000-000", city: "Manaus", state: "AM" })) as unknown as typeof fetch,
    });
    await expect(cepGeral.lookupCep("69000000")).resolves.toMatchObject({ ok: true });
  });
});
