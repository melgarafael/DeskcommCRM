/**
 * A diferença entre "a chave existe" e "a chave funciona".
 *
 * O produto só sabia responder a primeira, e chamava isso de "Validada": o
 * validador bate no endpoint de LISTAGEM de modelos, que não consome crédito e
 * responde 200 com a conta zerada. Quem instalou, viu o selo verde e recebeu
 * erro na primeira conversa não tinha onde olhar.
 */
import { describe, expect, it, vi } from "vitest";

import {
  classificarResposta,
  montarRequisicaoDeProva,
  provarSaldo,
} from "@/lib/instalacao/prova-de-credito";
import { IDS_DE_PROVEDOR } from "@/lib/ai/pontos/provedores";

describe("montarRequisicaoDeProva", () => {
  it("sabe cobrar TODOS os provedores que a lista oferece", () => {
    // Se a lista ganhar um provedor e este módulo não souber testá-lo, o
    // diagnóstico ficaria mudo justamente para quem escolheu o mais novo.
    const semProva = IDS_DE_PROVEDOR.filter(
      (id) => montarRequisicaoDeProva(id, "k", "m") === null,
    );
    expect(semProva).toEqual([]);
  });

  it("é uma GERAÇÃO, não uma listagem — é o que o provedor cobra", () => {
    // O ponto do arquivo inteiro: listar modelos passa com saldo zero.
    for (const id of IDS_DE_PROVEDOR) {
      const req = montarRequisicaoDeProva(id, "k", "modelo-x");
      expect(req, id).not.toBeNull();
      expect(req!.url, `${id} está batendo num endpoint de catálogo`).not.toMatch(/\/models$/);
    }
  });

  it("pede o mínimo possível — o objetivo é atravessar a cobrança, não gerar texto", () => {
    const anthropic = montarRequisicaoDeProva("anthropic", "k", "m");
    expect(anthropic!.body).toMatchObject({ max_tokens: 1 });
  });

  it("OpenAI usa max_completion_tokens — max_tokens é recusado pelos modelos de raciocínio (o1/o3/gpt-5)", () => {
    // Medido em produção: o modelo padrão curado para OpenAI é da família de
    // raciocínio, e ela responde 400 "Unsupported parameter: 'max_tokens' is
    // not supported with this model. Use 'max_completion_tokens' instead."
    // Isso derrubava a prova de crédito no onboarding com toda chave válida.
    const openai = montarRequisicaoDeProva("openai", "k", "gpt-5.6-terra");
    expect(openai!.body).toMatchObject({ max_completion_tokens: 1 });
    expect(openai!.body).not.toHaveProperty("max_tokens");
  });

  it("provedor desconhecido não recebe 'ok' por omissão", () => {
    expect(montarRequisicaoDeProva("inventado", "k", "m")).toBeNull();
  });
});

describe("classificarResposta", () => {
  it("200 é a única forma de passar", () => {
    expect(classificarResposta(200, "{}")).toEqual({ ok: true });
  });

  it("saldo/limite tem balde próprio — é o caso que o selo 'Validada' escondia", () => {
    const r = classificarResposta(429, '{"error":{"message":"insufficient_quota"}}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("limite_ou_saldo");
  });

  it("chave recusada não se confunde com falta de saldo", () => {
    // São conselhos opostos: uma manda trocar a chave, a outra manda por
    // crédito na conta. Trocar os dois faz o operador mexer no que está certo.
    const r = classificarResposta(401, "invalid api key");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("credencial_recusada");
  });

  it("provedor fora do ar não vira culpa da chave", () => {
    const r = classificarResposta(503, "service unavailable");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("provedor_indisponivel");
  });

  it("modelo inexistente é diagnóstico próprio", () => {
    const r = classificarResposta(404, "model not found");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("modelo_inexistente");
  });
});

describe("provarSaldo", () => {
  it("faz UMA chamada e devolve ok quando o provedor aceita", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const r = await provarSaldo("anthropic", "sk-x", "claude-sonnet-5", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("erro de rede não é chave ruim", async () => {
    // Dizer "credencial recusada" aqui mandaria o operador trocar uma chave
    // que está certa, enquanto o problema é o servidor não alcançar a internet.
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    const r = await provarSaldo("openai", "sk-x", "gpt-x", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("provedor_indisponivel");
  });

  it("não engole o corpo do erro: a causa chega a quem vai consertar", async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":{"message":"insufficient_quota"}}', { status: 402 }),
    );
    const r = await provarSaldo("openrouter", "sk-or", "z-ai/glm-4.7", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codigo).toBe("limite_ou_saldo");
      expect(r.httpStatus).toBe(402);
    }
  });
});
