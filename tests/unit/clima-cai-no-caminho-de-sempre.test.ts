/**
 * O FALLBACK É O CONTRATO — e é isto que o prova no caminho de produção.
 *
 * `lib/ai/decisao/clima.test.ts` prova o medidor isolado. Este arquivo prova a
 * peça que interessa a quem opera uma VPS: **enquanto ninguém configurar o
 * fornecedor, o worker se comporta exatamente como antes**, e nenhuma das cinco
 * classes de falha do fornecedor muda esse desfecho.
 *
 * Sem isto, "tem fallback" seria afirmação sobre código em vez de sobre
 * comportamento — e a diferença entre as duas é o que este repo mede o tempo todo.
 */
import { describe, expect, it, vi } from "vitest";

import { medirClima } from "@/lib/ai/decisao/clima";

// O disjuntor é por organização e vive no processo: sem uma organização por
// caso, a terceira falha abriria o disjuntor e os casos seguintes nem chegariam
// à rede — passariam pelo motivo errado.
let seq = 0;
const entrada = () => ({ organizationId: `org-fallback-${++seq}`, mensagem: "adorei o atendimento!" });

/** O estado de TODA instalação hoje: provedor não cadastrado. */
const SEM_CREDENCIAL = { buscarChave: async () => null };

describe("o clima cai no caminho de sempre", () => {
  it("sem credencial, não há medição e nada sai da máquina", async () => {
    const fetchImpl = vi.fn();
    const r = await medirClima(entrada(), { ...SEM_CREDENCIAL, fetchImpl });

    expect(r, "sem nota = o worker segue para o LLM, como antes desta frente").toMatchObject({ ok: false });
    expect(fetchImpl, "nenhuma requisição — a ausência é configuração, não incidente").not.toHaveBeenCalled();
  });

  it.each([
    ["credencial recusada", 401],
    ["pergunta malformada nossa", 422],
    ["limite de taxa", 429],
    ["fornecedor sobrecarregado", 529],
    ["erro do fornecedor", 500],
  ])("%s (HTTP %i) devolve ausência, nunca uma nota", async (_rotulo, status) => {
    const r = await medirClima(entrada(), {
      buscarChave: async () => "tsk_x",
      fetchImpl: vi.fn().mockResolvedValue(new Response("{}", { status })),
    });
    expect(r).toMatchObject({ ok: false, tentouRede: true });
  });

  it("queda de rede devolve ausência, nunca uma nota", async () => {
    const r = await medirClima(entrada(), {
      buscarChave: async () => "tsk_x",
      fetchImpl: vi.fn().mockRejectedValue(new Error("fetch failed")),
    });
    expect(r).toMatchObject({ ok: false, motivo: "provedor_indisponivel", tentouRede: true });
  });

  it("NENHUMA falha vira zero — a falha não carrega nota nenhuma", async () => {
    // O ponto inteiro desta frente. Um fallback que devolvesse nota 0 na falha
    // faria o pior estrago possível AQUI: `sentiment_score` 0 é menor que
    // qualquer limiar (default 0.3), então toda falha do fornecedor abriria um
    // alerta de cliente irritado. O mesmo defeito que travava conversa no gate
    // de handoff, agora ao contrário — inventando crise onde não há.
    const falhas = [
      { buscarChave: async () => null, fetchImpl: vi.fn() },
      { buscarChave: async () => "tsk_x", fetchImpl: vi.fn().mockResolvedValue(new Response("{}", { status: 529 })) },
      { buscarChave: async () => "tsk_x", fetchImpl: vi.fn().mockRejectedValue(new Error("x")) },
      {
        buscarChave: async () => "tsk_x",
        fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({ answers: {} }), { status: 200 })),
      },
    ];
    for (const deps of falhas) {
      const r = await medirClima(entrada(), deps);
      expect(r.ok, "nenhuma falha pode produzir nota — nem a pior delas").toBe(false);
      expect("score01" in r, "e muito menos o zero").toBe(false);
    }
  });
});
