/**
 * O TEXTO QUE O MOTOR GRAVA NASCE NO IDIOMA DA ORGANIZAÇÃO (Refs #755, PR #4724).
 *
 * A linha "Resposta da IA" na linha do tempo, o resumo da passagem, a razão da
 * nota do negócio e os avisos da Central são DADO: a tela os mostra como foram
 * gravados, sem `t()`. Então a tradução acontece na escrita — e é isso que este
 * arquivo prova, com uma organização em `es`:
 *
 *  1. cada construtor sai em espanhol (e em `pt-BR` continua o de antes);
 *  2. o cartão da passagem reconhece a marca do Jev num resumo gravado em
 *     espanhol — a comparação que a máquina relê;
 *  3. `idiomaDoAviso` com locale nulo, desconhecido ou leitura quebrada cai em
 *     `pt-BR`, nunca lança;
 *  4. os valores entram numa passada só: um nome de etapa com `{detalhe}` ou
 *     uma promessa com `{prazo}` não é trocado pelo valor seguinte;
 *  5. o aviso de canal pausado sai no idioma da ORGANIZAÇÃO, não no de quem
 *     clicou (o dele vale só para a data).
 *
 * Cada caso fica vermelho se a tradução correspondente for desfeita: as
 * asserções procuram a frase em espanhol E a ausência da portuguesa.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { renderDeclaracaoParaHumano } from "@/lib/agent-engine/agent/declaracao";
import { avisoDoEspelhoRecusado } from "@/lib/agent-engine/edge/crm/move-lead-stage";
import { corpoDoBloqueio } from "@/lib/agent-engine/edge/llm/orcamento";
import { sincronizarAvisoDePausa } from "@/lib/channels/central-de-pausa";
import { montarBriefingDaPassagem } from "@/lib/escalacao/briefing-da-passagem";
import { montarCartoesDaPassagem, type PassagemDaConversa } from "@/lib/escalacao/cartao-da-passagem";
import { idiomaDoAviso, preencher } from "@/lib/i18n/idioma-do-aviso";
import { diffCheckpoint } from "@/lib/leads/checkpoint-diff";
import { calculaScore, type SinaisDoLead } from "@/lib/leads/score-formula";

const ORG = "11111111-1111-4111-8111-111111111111";

const CHECKPOINT_VAZIO = { commitments: [], objections: [], next_action: null, rolling_summary: null };

describe("linha do tempo — diffCheckpoint", () => {
  const atual = {
    commitments: ["enviar o orçamento"],
    objections: [],
    next_action: "ligar amanhã",
    rolling_summary: null,
  };

  it("em es, os rótulos saem em espanhol e o conteúdo da IA entra como veio", () => {
    const { reason } = diffCheckpoint(CHECKPOINT_VAZIO, atual, "es");
    expect(reason).toContain("Nuevo compromiso: enviar o orçamento");
    expect(reason).toContain("Próxima acción: ligar amanhã");
    expect(reason).not.toContain("Novo compromisso");
    expect(reason).not.toContain("Próxima ação");
  });

  it("controle: em pt-BR o texto é o de sempre", () => {
    const { reason } = diffCheckpoint(CHECKPOINT_VAZIO, atual);
    expect(reason).toContain("Novo compromisso: enviar o orçamento");
    expect(reason).toContain("Próxima ação: ligar amanhã");
  });

  it("um `{n}` dentro do que a IA escreveu não é trocado", () => {
    const { reason } = diffCheckpoint(CHECKPOINT_VAZIO, { ...atual, commitments: ["mandar {n} fotos"] }, "es");
    expect(reason).toContain("Nuevo compromiso: mandar {n} fotos");
  });
});

describe("resumo da passagem — montarBriefingDaPassagem", () => {
  it("em es, os rótulos do resumo saem em espanhol", () => {
    const { body } = montarBriefingDaPassagem({
      checkpoint: {
        commitments: ["enviar o orçamento"],
        objections: ["preço alto"],
        next_action: "ligar amanhã",
        rolling_summary: "",
      },
      motivo: { codigo: "low_sentiment" },
      idioma: "es",
    });
    expect(body).toContain("Por qué la IA pasó la conversación:");
    expect(body).toContain("Compromisos: enviar o orçamento");
    expect(body).toContain("Objeciones: preço alto");
    expect(body).toContain("Próxima acción: ligar amanhã");
    expect(body).not.toContain("Por que a IA passou");
    expect(body).not.toContain("Compromissos:");
  });

  it("a promessa com prazo sai inteira, mesmo com `{prazo}` no texto da promessa", () => {
    const texto = renderDeclaracaoParaHumano(
      { intencoes: [], promessas: [{ o_que: "ligar {prazo}", prazo: "2026-11-20" }], nada_a_declarar: false },
      "es",
    );
    expect(texto).toBe("Lo que se le prometió: ligar {prazo} (hasta 2026-11-20)");
    // E em pt-BR, o mesmo — era o que saía na main.
    expect(
      renderDeclaracaoParaHumano({
        intencoes: [],
        promessas: [{ o_que: "ligar {prazo}", prazo: "2026-11-20" }],
        nada_a_declarar: false,
      }),
    ).toBe("Prometido a ela: ligar {prazo} (até 2026-11-20)");
  });
});

describe("cartão da passagem — a marca do Jev num resumo gravado em espanhol", () => {
  const passagem = (body: string): PassagemDaConversa => ({
    id: "p1",
    origem: "pedido_explicito",
    motivo_codigo: "low_sentiment",
    title: null,
    body,
    notes: null,
    content: null,
    tentativas: [],
    cliente_avisado: null,
    aviso_motivo_codigo: null,
    caso_id: null,
    criado_em: "2026-11-16T12:00:00.000Z",
    reconhecido_em: null,
    reconhecido_por: null,
  });
  const quem = { usuarioId: "u", donoId: null, donoNome: null };

  it("o resumo em es com o Jev ganha a marca", () => {
    const { body } = montarBriefingDaPassagem({
      checkpoint: null,
      motivo: { codigo: "low_sentiment", percebidoPeloJev: true },
      idioma: "es",
    });
    expect(body).not.toContain("percebido pelo Jev");
    expect(montarCartoesDaPassagem([passagem(body)], quem)[0]!.percebidoPeloJev).toBe(true);
  });

  it("controle: o mesmo resumo em es sem o Jev não ganha a marca", () => {
    const { body } = montarBriefingDaPassagem({ checkpoint: null, motivo: { codigo: "low_sentiment" }, idioma: "es" });
    expect(montarCartoesDaPassagem([passagem(body)], quem)[0]!.percebidoPeloJev).toBe(false);
  });
});

describe("aviso do espelho de etapa — avisoDoEspelhoRecusado", () => {
  it("em es, título e corpo saem em espanhol", () => {
    const aviso = avisoDoEspelhoRecusado({
      motivo: "fora_do_escopo",
      detalhe: "nenhum funil liberado para este assistente",
      etapaDeDestino: "qualifying",
      idioma: "es",
    })!;
    expect(aviso.title).toBe("El asistente quiso organizar un negocio de un embudo que no es suyo");
    expect(aviso.body).toContain("la etapa de destino del embudo");
    expect(aviso.body).toContain("ningún embudo habilitado para este asistente");
    expect(aviso.body).not.toContain("O assistente");
  });

  it("um nome de etapa com `{detalhe}` entra como foi digitado, e o detalhe real também", () => {
    const aviso = avisoDoEspelhoRecusado({
      motivo: "fora_do_escopo",
      detalhe: "nenhum funil liberado para este assistente",
      etapaDeDestino: "qualifying",
      etapaDoFunil: "Etapa {detalhe}",
    })!;
    expect(aviso.body).toContain('"Etapa {detalhe}"');
    expect(aviso.body).toContain("(nenhum funil liberado para este assistente)");
  });
});

describe("razão da nota do negócio — calculaScore", () => {
  const sinais: SinaisDoLead = {
    commitments: ["enviar o orçamento"],
    objections: ["preço alto"],
    checkpointId: "ck1",
    qualification: { budget: "ok" },
    risco: "em_risco",
    status: "open",
    bandAnterior: null,
  };

  it("em es, a razão e as frases das evidências saem em espanhol", () => {
    const r = calculaScore(sinais, "es");
    expect(r.reason).toContain("compromiso del cliente");
    expect(r.reason).not.toContain("compromisso do cliente");
    expect(r.evidence.factors?.some((f) => f.frase === "1 objeción abierta")).toBe(true);
  });

  it("controle: em pt-BR, o de sempre — e o idioma não vaza para a chamada seguinte", () => {
    calculaScore(sinais, "es");
    const r = calculaScore(sinais);
    expect(r.reason).toContain("compromisso do cliente");
  });
});

describe("aviso do teto de IA — corpoDoBloqueio", () => {
  it("em es, o corpo sai em espanhol", () => {
    const corpo = corpoDoBloqueio(5000, 5000, "es");
    expect(corpo).toContain("El gasto en IA de este mes llegó a");
    expect(corpo).toContain("(100%)");
    expect(corpo).not.toContain("O gasto de IA");
  });
});

/** Um cliente com `organizations` que responde o que o caso pedir. */
function clienteComLocale(resposta: () => Promise<unknown>) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: resposta }) }) }),
  };
}

describe("idiomaDoAviso — nunca lança, cai em pt-BR", () => {
  it("lê o locale da organização", async () => {
    expect(await idiomaDoAviso(clienteComLocale(async () => ({ data: { locale: "es" } })), ORG)).toBe("es");
  });

  it.each([
    ["locale nulo", async () => ({ data: { locale: null } })],
    ["organização sem linha", async () => ({ data: null })],
    ["locale desconhecido", async () => ({ data: { locale: "xx-YY" } })],
    [
      "leitura que quebra",
      async () => {
        throw new Error("banco fora");
      },
    ],
  ])("%s → pt-BR", async (_caso, resposta) => {
    await expect(idiomaDoAviso(clienteComLocale(resposta), ORG)).resolves.toBe("pt-BR");
  });

  it("sem organização → pt-BR, sem ler nada", async () => {
    let leu = false;
    const cliente = clienteComLocale(async () => {
      leu = true;
      return { data: { locale: "es" } };
    });
    expect(await idiomaDoAviso(cliente, null)).toBe("pt-BR");
    expect(leu).toBe(false);
  });
});

describe("preencher — uma passada só", () => {
  it("um valor com o nome de outro marcador não é trocado de novo", () => {
    expect(preencher("{etapa} / {detalhe}", { etapa: "Etapa {detalhe}", detalhe: "D" })).toBe("Etapa {detalhe} / D");
  });

  it("`$&` num valor entra literal", () => {
    expect(preencher("custa {valor}", { valor: "$& 10" })).toBe("custa $& 10");
  });
});

describe("canal pausado — o aviso segue a organização, não quem clicou", () => {
  it("pessoa em pt-BR pausando numa organização em es: título e corpo em espanhol", async () => {
    const itens: Array<Record<string, unknown>> = [];
    const db = {
      from(tabela: string) {
        if (tabela === "organizations") {
          return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { locale: "es" } }) }) }) };
        }
        if (tabela === "channel_sessions") {
          const c: Record<string, unknown> = {
            select: () => c,
            eq: () => c,
            maybeSingle: async () => ({
              data: {
                id: "c1",
                organization_id: ORG,
                display_name: "Loja Centro",
                phone_number: null,
                archived_at: null,
                metadata: { disabled: true },
              },
              error: null,
            }),
          };
          return c;
        }
        let payload: Record<string, unknown> | null = null;
        const c: Record<string, unknown> = {
          select: () => c,
          eq: () => c,
          limit: () => c,
          insert: (p: Record<string, unknown>) => {
            payload = p;
            return c;
          },
          maybeSingle: async () => ({ data: null, error: null }),
          then: (ok: (r: unknown) => unknown) => {
            if (payload) itens.push(payload);
            return Promise.resolve({ data: null, error: null }).then(ok);
          },
        };
        return c;
      },
    } as unknown as SupabaseClient;

    const desfecho = await sincronizarAvisoDePausa(
      db,
      { id: "c1", organization_id: ORG },
      { autor: "Ana Silva", agora: new Date("2026-10-07T15:42:00.000Z"), idioma: "pt-BR" },
    );

    expect(desfecho).toBe("aberto");
    expect(itens).toHaveLength(1);
    expect(itens[0]!.title).toBe("Este canal está en pausa — no recibe ni envía mensajes");
    expect(itens[0]!.body).toContain("«Loja Centro» está en pausa desde");
    expect(itens[0]!.body).toContain("lo pausó Ana Silva");
    expect(itens[0]!.body).not.toContain("está pausado desde");
  });
});
