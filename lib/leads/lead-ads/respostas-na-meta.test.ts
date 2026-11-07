/**
 * A BUSCA DAS RESPOSTAS NA GRAPH API — o contrato da única peça desta porta que
 * usa rede (issue #3768, fatia 1-bis).
 *
 * ## O que este arquivo mede
 *
 *   1. o caminho bom: `field_data` → respostas normalizadas, na mesma forma que o
 *      parser do aviso produz;
 *   2. o token vai no CABEÇALHO e **não** na URL — a URL é o que aparece em log de
 *      proxy e em mensagem de erro, e este token lê os leads de uma página;
 *   3. toda falha é NOMEADA e nenhuma inventa dado: status HTTP, JSON ilegível,
 *      `field_data` vazio, tempo esgotado, sem token;
 *   4. o teto de tempo é passado ao `fetch` (o sinal de abort existe).
 *
 * ## Por que o `fetch` é injetado
 *
 * Dublar o `fetch` global faria o teste medir o dublê do ambiente. Injetando, o
 * que se mede é o CONTRATO desta função: que URL ela monta, que cabeçalho manda,
 * e o que ela devolve quando o outro lado não coopera.
 */
import { describe, expect, it, vi } from "vitest";

import { graphBaseUrl } from "@/lib/channels/meta/graph-base";
import { buscarRespostasDoLead, TEMPO_LIMITE_DA_BUSCA_MS } from "./respostas-na-meta";

const LEADGEN = "1122334455667788";
const TOKEN = "token-da-pagina-que-le-adultos-".padEnd(40, "x");

function fetchQueResponde(corpo: unknown, status = 200) {
  const espiao = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(corpo), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  return { espiao, fetch: espiao as unknown as typeof fetch };
}

describe("buscarRespostasDoLead", () => {
  it("devolve as respostas normalizadas, com a chave canônica do campo", async () => {
    const { espiao, fetch } = fetchQueResponde({
      id: LEADGEN,
      field_data: [
        { name: "Full Name", values: ["Maria Aparecida Souza"] },
        { name: "phone_number", values: ["+55 11 98888-7777"] },
        { name: "E-mail", values: ["maria@exemplo.com.br"] },
        { name: "qual_o_seu_objetivo", values: ["Comprar", "Pesquisar"] },
      ],
    });

    const resultado = await buscarRespostasDoLead({ leadgenId: LEADGEN, token: TOKEN }, { fetchImpl: fetch });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.respostas).toEqual([
      { campo: "full_name", valor: "Maria Aparecida Souza" },
      { campo: "phone_number", valor: "+55 11 98888-7777" },
      { campo: "e_mail", valor: "maria@exemplo.com.br" },
      // Múltipla escolha: os valores viram uma resposta só, como no parser do
      // aviso — a mesma régua nos dois caminhos.
      { campo: "qual_o_seu_objetivo", valor: "Comprar, Pesquisar" },
    ]);
    expect(espiao).toHaveBeenCalledTimes(1);
  });

  it("manda o token no cabeçalho e NUNCA na URL", async () => {
    const { espiao, fetch } = fetchQueResponde({ field_data: [{ name: "nome", values: ["Ana"] }] });

    await buscarRespostasDoLead({ leadgenId: LEADGEN, token: TOKEN }, { fetchImpl: fetch });

    const [url, init] = espiao.mock.calls[0]! as unknown as [string, RequestInit];
    // A URL é a base da instalação + o id do lead: nada de `access_token` nela.
    expect(url).toBe(`${graphBaseUrl()}/${LEADGEN}?fields=field_data`);
    expect(url).not.toContain(TOKEN);
    expect(url).not.toContain("access_token");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    // O teto de tempo vai junto do pedido: sem sinal, a chamada pendurada segura a
    // resposta HTTP que a plataforma espera.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(TEMPO_LIMITE_DA_BUSCA_MS).toBeGreaterThan(0);
    expect(TEMPO_LIMITE_DA_BUSCA_MS).toBeLessThanOrEqual(10_000);
  });

  it("status fora de 2xx é falha NOMEADA com o status no detalhe — e nenhuma resposta", async () => {
    for (const status of [400, 401, 403, 500]) {
      const { fetch } = fetchQueResponde({ error: { message: "x" } }, status);
      const resultado = await buscarRespostasDoLead({ leadgenId: LEADGEN, token: TOKEN }, { fetchImpl: fetch });
      expect(resultado.ok).toBe(false);
      if (resultado.ok) return;
      expect(resultado.motivo).toBe("recusada_pela_meta");
      expect(resultado.detalhe).toBe(`http_${status}`);
      expect(resultado).not.toHaveProperty("respostas");
    }
  });

  it("tempo esgotado é `tempo_esgotado`, e não um lead em branco", async () => {
    const estouro = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    const fetchImpl = vi.fn(async () => {
      throw estouro;
    }) as unknown as typeof fetch;

    const resultado = await buscarRespostasDoLead(
      { leadgenId: LEADGEN, token: TOKEN },
      { fetchImpl, tempoLimiteMs: 1234 },
    );

    expect(resultado).toEqual({ ok: false, motivo: "tempo_esgotado", detalhe: "1234ms" });
  });

  it("corpo ilegível, `field_data` ausente e `field_data` vazio têm nomes diferentes", async () => {
    const jsonQuebrado = vi.fn(async () => new Response("{nao-e-json", { status: 200 })) as unknown as typeof fetch;
    const semCampo = fetchQueResponde({ id: LEADGEN }).fetch;
    const vazio = fetchQueResponde({ field_data: [{ name: "", values: [] }] }).fetch;

    const a = await buscarRespostasDoLead({ leadgenId: LEADGEN, token: TOKEN }, { fetchImpl: jsonQuebrado });
    const b = await buscarRespostasDoLead({ leadgenId: LEADGEN, token: TOKEN }, { fetchImpl: semCampo });
    const c = await buscarRespostasDoLead({ leadgenId: LEADGEN, token: TOKEN }, { fetchImpl: vazio });

    expect(a).toMatchObject({ ok: false, motivo: "resposta_ilegivel", detalhe: "json_invalido" });
    expect(b).toMatchObject({ ok: false, motivo: "resposta_ilegivel", detalhe: "sem_field_data" });
    expect(c).toMatchObject({ ok: false, motivo: "sem_respostas" });
  });

  it("sem token não chama a plataforma — a recusa é local e nomeada", async () => {
    const { espiao, fetch } = fetchQueResponde({ field_data: [] });

    const resultado = await buscarRespostasDoLead({ leadgenId: LEADGEN, token: "   " }, { fetchImpl: fetch });

    expect(resultado).toEqual({ ok: false, motivo: "sem_token_da_pagina" });
    expect(espiao).not.toHaveBeenCalled();
  });
});
