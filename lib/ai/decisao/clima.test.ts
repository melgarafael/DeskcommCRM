/**
 * O CLIMA DA CONVERSA PELO SYSTEM ONE — e a normalização, que é onde mora o risco.
 *
 * O worker grava `sentiment_score` de 0 a 1 e compara com um limiar configurável
 * (default 0.3) para abrir handoff. O System One devolve a posição numa escala de
 * NÍVEIS: com 5 níveis, um número contínuo entre 0 e 4.
 *
 * Trocar a origem do número sem acertar a escala moveria o limiar de todo mundo em
 * silêncio — um 2.0 (neutro) lido como 2.0 numa régua de 0..1 abriria handoff em
 * toda conversa morna. Por isso a normalização tem teste próprio, com os extremos e
 * o meio, e não uma conferência "parece certo".
 */
import { describe, expect, it, vi } from "vitest";

import { medirClima, NIVEIS_DE_CLIMA } from "@/lib/ai/decisao/clima";
import { registrarFalha } from "@/lib/ai/decisao/disjuntor";

function respostaComScore(score: number): Response {
  return new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        clima: { type: "score", score, legend: {}, probabilities: { "0": 1 }, confidence: 0.9 },
      },
      usage: { input_tokens: 80, output_tokens: 18 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** O disjuntor é por organização e vive no processo: cada caso usa a sua. */
let seq = 0;
const novaOrg = () => `org-clima-${++seq}`;

describe("medirClima", () => {
  it.each([
    [0, 0],
    [NIVEIS_DE_CLIMA.length - 1, 1],
    [(NIVEIS_DE_CLIMA.length - 1) / 2, 0.5],
  ])("normaliza o nível %s da escala para %s em 0..1", async (bruto, esperado) => {
    const r = await medirClima(
      { organizationId: novaOrg(), mensagem: "oi" },
      { buscarChave: async () => "tsk_x", fetchImpl: vi.fn().mockResolvedValue(respostaComScore(bruto)) },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.score01).toBeCloseTo(esperado, 5);
  });

  it("devolve a versão que respondeu e os tokens de entrada E de saída", async () => {
    // A saída não é cobrada, mas a API a devolve (> 0): gravar zero seria a
    // telemetria mentindo por omissão.
    const r = await medirClima(
      { organizationId: novaOrg(), mensagem: "oi" },
      { buscarChave: async () => "tsk_x", fetchImpl: vi.fn().mockResolvedValue(respostaComScore(2)) },
    );
    expect(r).toMatchObject({ ok: true, modelo: "jev-1.13.0", tokensDeEntrada: 80, tokensDeSaida: 18 });
  });

  it("o tempo medido é o da chamada ao fornecedor, não o da busca da chave", async () => {
    // Em Execuções, a IA de sempre cronometra só a chamada. Contar aqui a busca
    // da chave no banco poria tempo de banco na conta do fornecedor.
    const r = await medirClima(
      { organizationId: novaOrg(), mensagem: "oi" },
      {
        buscarChave: async () => {
          await new Promise((ok) => setTimeout(ok, 80));
          return "tsk_x";
        },
        fetchImpl: vi.fn().mockResolvedValue(respostaComScore(2)),
      },
    );
    expect(r.ok).toBe(true);
    expect(r.latenciaMs).toBeLessThan(80);
  });

  it("sem credencial não há nota, nem rede — o chamador segue pelo caminho atual", async () => {
    const fetchImpl = vi.fn();
    const r = await medirClima({ organizationId: novaOrg(), mensagem: "oi" }, { buscarChave: async () => null, fetchImpl });
    expect(r, "sem credencial, o clima não é medido aqui — e isso não é um zero").toMatchObject({
      ok: false,
      motivo: "sem_credencial",
      tentouRede: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("com o disjuntor aberto, nada sai para a rede e nem a chave é lida", async () => {
    const org = novaOrg();
    registrarFalha(org, "limite_de_taxa", Date.now());
    const buscarChave = vi.fn(async () => "tsk_x");
    const fetchImpl = vi.fn();

    const r = await medirClima({ organizationId: org, mensagem: "oi" }, { buscarChave, fetchImpl });

    expect(r).toMatchObject({ ok: false, motivo: "disjuntor_aberto", tentouRede: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(buscarChave).not.toHaveBeenCalled();
  });

  it("três falhas seguidas abrem o disjuntor; a quarta mensagem não sai", async () => {
    const org = novaOrg();
    const fetchImpl = vi.fn().mockImplementation(async () => new Response("{}", { status: 500 }));
    for (let i = 0; i < 3; i++) {
      await medirClima({ organizationId: org, mensagem: "oi" }, { buscarChave: async () => "tsk_x", fetchImpl });
    }
    const r = await medirClima({ organizationId: org, mensagem: "oi" }, { buscarChave: async () => "tsk_x", fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(r).toMatchObject({ ok: false, motivo: "disjuntor_aberto" });
  });

  it("CPF, telefone e e-mail não saem para o fornecedor (LGPD)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respostaComScore(1));
    await medirClima(
      { organizationId: novaOrg(), mensagem: "meu CPF é 123.456.789-09, fone +55 11 98765-4321, a@b.com" },
      { buscarChave: async () => "tsk_x", fetchImpl },
    );
    const [, init] = fetchImpl.mock.calls[0]!;
    const { state } = JSON.parse((init as RequestInit).body as string) as { state: string };
    expect(state).toContain("meu CPF é");
    expect(state).not.toMatch(/123\.456|98765|a@b\.com/);
  });

  it("score fora da escala não vira nota — vira ausência", async () => {
    // Defesa contra o contrato do fornecedor mudar (mais níveis, outra base) sem
    // ninguém perceber: um número fora da faixa normalizaria para algo plausível
    // e ERRADO, e o limiar de handoff passaria a disparar por régua trocada.
    const r = await medirClima(
      { organizationId: novaOrg(), mensagem: "oi" },
      { buscarChave: async () => "tsk_x", fetchImpl: vi.fn().mockResolvedValue(respostaComScore(99)) },
    );
    expect(r).toMatchObject({ ok: false, motivo: "resposta_ilegivel", tentouRede: true });
  });

  it("a pergunta enviada tem a escala ORDENADA do pior ao melhor", async () => {
    // A ordem é o contrato do `score`: o fornecedor devolve a POSIÇÃO na escala,
    // então inverter os níveis inverteria a nota sem erro nenhum aparecer.
    const fetchImpl = vi.fn().mockResolvedValue(respostaComScore(2));
    await medirClima({ organizationId: novaOrg(), mensagem: "oi" }, { buscarChave: async () => "tsk_x", fetchImpl });
    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as {
      questions: { clima: { criteria: string[] } };
    };
    expect(body.questions.clima.criteria).toEqual([...NIVEIS_DE_CLIMA]);
    expect(body.questions.clima.criteria[0]).toMatch(/irritad|revoltad|péssim/i);
  });
});
