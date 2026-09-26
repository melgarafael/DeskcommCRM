/**
 * A diferença entre "a chave existe" e "a chave funciona".
 *
 * O produto só sabia responder a primeira, e chamava isso de "Validada": o
 * validador bate no endpoint de LISTAGEM de modelos, que não consome crédito e
 * responde 200 com a conta zerada. Quem instalou, viu o selo verde e recebeu
 * erro na primeira conversa não tinha onde olhar.
 */
import { describe, expect, it, vi } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";
import { EXPLICACAO_POR_BALDE, explicacaoParaQuemInstala } from "@/lib/instalacao/explicacao-da-falha";
import {
  classificarResposta,
  LIMITE_DE_SAIDA_ATINGIDO,
  montarRequisicaoDeProva,
  provarSaldo,
} from "@/lib/instalacao/prova-de-credito";
import { IDS_DE_PROVEDOR } from "@/lib/ai/pontos/provedores";

describe("montarRequisicaoDeProva", () => {
  it("sabe cobrar TODOS os provedores que a lista oferece", () => {
    // Se a lista ganhar um provedor e este módulo não souber testá-lo, o
    // diagnóstico ficaria mudo justamente para quem escolheu o mais novo.
    // `custom` nasce com o endereço na credencial: sem ele a prova não tem
    // para onde ir, e recusar é o comportamento certo — mas a lista dos
    // OUTROS segue medida sem endereço nenhum.
    const semProva = IDS_DE_PROVEDOR.filter(
      (id) =>
        montarRequisicaoDeProva(
          id,
          "k",
          "m",
          id === "custom" ? "https://gw.exemplo/v1" : undefined,
        ) === null,
    );
    expect(semProva).toEqual([]);
  });

  it("é uma GERAÇÃO, não uma listagem — é o que o provedor cobra", () => {
    // O ponto do arquivo inteiro: listar modelos passa com saldo zero.
    for (const id of IDS_DE_PROVEDOR) {
      const req = montarRequisicaoDeProva(
        id,
        "k",
        "modelo-x",
        id === "custom" ? "https://gw.exemplo/v1" : undefined,
      );
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

  it("o 400 de teto de saída é a prova PASSANDO: a chave foi aceita e o modelo gerou", () => {
    // O modelo curado padrão é de raciocínio: gasta o único token pensando e este
    // 400 já provou o que a prova queria provar (a cobrança atravessou).
    // O corpo é o REAL do provedor, montado a partir da constante — assim o caso
    // acompanha a frase que o módulo reconhece.
    const teto = JSON.stringify({ error: { message: `Could not finish the message because ${LIMITE_DE_SAIDA_ATINGIDO}. Please try again with higher max_tokens.`, type: "invalid_request_error", param: null, code: null } });
    expect(classificarResposta(400, teto)).toEqual({ ok: true });
  });

  it("e é SÓ esse 400 — o resto continua falha, com o balde certo", () => {
    // A guarda não pode virar "qualquer 400 passa": `max_tokens` sozinho aparece
    // em recusa de PARÂMETRO, e casar por ele daria sucesso a uma chave que não
    // funciona.
    for (const [nome, status, corpo, esperado] of [
      ["400 outro motivo", 400, '{"error":{"message":"Unsupported parameter: \'temperature\' is not supported with this model."}}', "erro_desconhecido"],
      ["400 quase a frase", 400, '{"error":{"message":"Unsupported parameter: max_tokens is not supported with this model."}}', "erro_desconhecido"],
      ["401 chave inválida", 401, '{"error":{"message":"Incorrect API key provided"}}', "credencial_recusada"],
      ["429 sem saldo", 429, '{"error":{"message":"insufficient_quota"}}', "limite_ou_saldo"],
    ] as const) {
      const r = classificarResposta(status, corpo);
      expect(r.ok, nome).toBe(false);
      if (!r.ok) expect(r.codigo, nome).toBe(esperado);
    }
  });
});

describe("explicacaoParaQuemInstala", () => {
  it("tem espanhol, não fala a língua do engenheiro e nunca é o corpo do provedor", () => {
    // As frases chegam à tela por `t(variável)`, e o guarda de tela só enxerga
    // `t("literal")`: sem estas linhas, frase nova sairia em português numa
    // instalação em espanhol sem gate nenhum reclamar. Mesmo desenho de
    // `lib/ai/decisao/textos.test.ts`.
    const frases = [...Object.values(EXPLICACAO_POR_BALDE), explicacaoParaQuemInstala("balde_novo")];
    expect(frases.length, "controle positivo").toBe(5);
    expect(frases.filter((f) => !DICIONARIO[f]?.es), "frase sem espanhol").toEqual([]);
    expect(frases.filter((f) => /[{}\[\]"]|max_tokens|invalid_request_error/.test(f))).toEqual([]);
    expect(frases.filter((f) => /\b(400|401|402|403|429|5\d\d|HTTP|status|timeout|token|prompt|API|JSON)\b/i.test(f))).toEqual([]);
    expect(explicacaoParaQuemInstala("limite_ou_saldo")).not.toBe(explicacaoParaQuemInstala("credencial_recusada"));
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
