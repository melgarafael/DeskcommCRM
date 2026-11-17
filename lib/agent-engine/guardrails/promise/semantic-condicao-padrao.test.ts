/**
 * A CONDIÇÃO PADRÃO DO PRODUTO NÃO É PROMESSA — e a prova é o CORPO que sai.
 *
 * O defeito medido (#4665): o classificador julgava com a lista do caminho SEM
 * evidências mesmo quando as evidências do turno traziam a política escrita da
 * empresa ("frete grátis acima de R$ 199", "entrega em 5 dias úteis"). Quem só
 * repetia a base de conhecimento era vetado, e o agente reescrevia uma frase
 * que a própria empresa cadastrou. A segunda metade do defeito é a variação: a
 * chamada não fixava `temperature` nem guardava o veredito, então o MESMO texto
 * com as MESMAS evidências vetava numa passagem e aprovava na outra.
 *
 * Como o teste mede, no padrão do #4660: o caminho inteiro roda — classificador
 * → `runModelCall` → registry de produção — e o `fetch` é interceptado, então o
 * que se lê é o corpo que SAIRIA para o provedor. Nenhum provedor real é
 * chamado, nenhuma chave é usada.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyPromise } from "./semantic";
import { createDefaultRegistry } from "../../edge/llm/providers";

const ORG = "44444444-4444-4444-8444-444444444444";
const CFG = {
  openrouterApiKey: "chave-openrouter-de-teste",
  cacheTtl: "1h",
} as never;
const LOG = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
const MODELO = "meta-llama/llama-3.3-70b-instruct";

/**
 * A organização pediu amostragem 0.7 para REDAÇÃO. O classificador não pode
 * herdar essa escolha: é ela que fazia o veredito mudar entre execuções.
 */
function poolDaOrg() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("settings->'llm'")) {
        return {
          rows: [
            {
              llm: {
                provider: "openrouter",
                default_model: MODELO,
                params: { temperature: 0.7 },
                enabled_models: [],
                monthly_budget_cents: null,
              },
            },
          ],
        };
      }
      if (sql.includes("insert into llm_calls")) return { rows: [{ id: "call-1" }] };
      return { rows: [] };
    }),
  } as never;
}

/** O corpo de cada pedido ao provedor, na ordem; a última resposta se repete. */
function interceptarSaida(respostas: readonly string[]) {
  const corpos: Array<Record<string, unknown>> = [];
  const fetchFalso = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    corpos.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const conteudo = respostas[Math.min(corpos.length - 1, respostas.length - 1)] ?? "{}";
    return new Response(
      JSON.stringify({
        id: "chatcmpl-teste",
        object: "chat.completion",
        created: 0,
        model: MODELO,
        choices: [
          { index: 0, message: { role: "assistant", content: conteudo }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchFalso);
  return { corpos, fetchFalso };
}

/**
 * O pedido que chega ao provedor: `system` vira a mensagem de sistema e o JSON
 * do revisor é a ÚLTIMA mensagem. Lido do corpo cru, sem passar pelo SDK.
 */
function pedidoDoCorpo(corpo: Record<string, unknown>): Record<string, unknown> {
  const mensagens = corpo.messages as Array<{ role: string; content: string }>;
  return JSON.parse(mensagens[mensagens.length - 1]!.content) as Record<string, unknown>;
}

/**
 * A instrução de sistema como ela SAI: no Chat Completions ela é a mensagem de
 * papel `system`, não um campo do topo do corpo. Caminho sem evidências não
 * manda instrução de sistema — o texto antigo vai dentro da mensagem.
 */
function systemDoCorpo(corpo: Record<string, unknown>): string {
  const mensagens = corpo.messages as Array<{ role: string; content: string }>;
  return mensagens
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
}

function veredito(isPromise: boolean, suspectPhrase: string | null): string {
  return JSON.stringify({
    isPromise,
    suspectPhrase,
    prometeuRetornoHumano: false,
    retornoSoDoAssistente: false,
  });
}

/** A política escrita pela empresa — é ela que o agente só repete. */
const POLITICA_DE_ENTREGA = {
  origem: "conhecimento" as const,
  referencia: "fonte-frete:trecho-1",
  titulo: "Política de frete e prazo",
  conteudo:
    "Frete grátis para pedidos acima de R$ 199. O prazo padrão de entrega é de 5 dias úteis.",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("condição padrão escrita nas evidências", () => {
  it("repetir frete grátis e prazo padrão da base de conhecimento não é promessa", async () => {
    const { corpos, fetchFalso } = interceptarSaida([veredito(false, null)]);
    const candidata = "O frete é grátis acima de R$ 199 e a entrega sai em 5 dias úteis.";

    const resultado = await classifyPromise(
      poolDaOrg(),
      CFG,
      { tenantId: ORG, jobId: "turno-da-condicao-padrao" },
      { candidate: candidata, commercialEvidence: [POLITICA_DE_ENTREGA], model: MODELO },
      { registry: createDefaultRegistry(), log: LOG },
    );

    expect(fetchFalso).toHaveBeenCalledTimes(1);
    const corpo = corpos[0]!;
    // O trecho da base de conhecimento chegou ao revisor como EVIDÊNCIA, junto
    // da mensagem que apenas o repete.
    const pedido = pedidoDoCorpo(corpo) as {
      mensagem: string;
      evidencias: Array<{ origem: string; conteudo: string }>;
    };
    expect(pedido.mensagem).toBe(candidata);
    expect(pedido.evidencias).toHaveLength(1);
    expect(pedido.evidencias[0]!.origem).toBe("conhecimento");
    expect(pedido.evidencias[0]!.conteudo).toContain("Frete grátis para pedidos acima de R$ 199");
    // E o prompt diz, com todas as letras, que repetir essa condição não é promessa.
    const system = systemDoCorpo(corpo);
    expect(system).toContain("REPETIR CONDIÇÃO QUE ESTÁ NAS EVIDÊNCIAS NÃO É PROMESSA");
    expect(system).toContain("origem 'catalogo' ou 'conhecimento' registra a condição padrão");
    expect(system).toContain("'servidor_externo' não entra nesta regra");
    expect(system).toContain("frete grátis acima de um valor");
    // O veredito não é reescrito pelo código: continua o do revisor.
    expect(resultado).toMatchObject({ isPromise: false, suspectPhrase: null });
  });

  it("a MESMA entrada devolve o MESMO veredito, com temperatura fixa no corpo", async () => {
    // Se o classificador chamar o modelo duas vezes, as respostas DIVERGEM — é
    // exatamente a falha medida. Com o veredito guardado, a segunda passagem
    // nem chega ao provedor, e o que já foi decidido é o que vale.
    const { corpos, fetchFalso } = interceptarSaida([
      veredito(false, null),
      veredito(true, "entrega em 5 dias úteis"),
    ]);
    const entrada = {
      candidate: "A entrega sai em 5 dias úteis e o frete é grátis acima de R$ 199.",
      commercialEvidence: [POLITICA_DE_ENTREGA],
      model: MODELO,
    };
    const ids = { tenantId: ORG, jobId: "turno-do-determinismo" };

    const primeira = await classifyPromise(poolDaOrg(), CFG, ids, entrada, {
      registry: createDefaultRegistry(),
      log: LOG,
    });
    const segunda = await classifyPromise(poolDaOrg(), CFG, ids, entrada, {
      registry: createDefaultRegistry(),
      log: LOG,
    });

    expect(fetchFalso).toHaveBeenCalledTimes(1);
    expect(segunda).toEqual(primeira);
    expect(primeira.isPromise).toBe(false);
    // A temperatura da chamada é 0 — não a 0.7 que a organização escolheu para
    // redação. Sem isso o mesmo texto pode vetar na execução seguinte.
    expect(corpos[0]!.temperature).toBe(0);
  });
});

describe("o veto continua para a promessa que as evidências não sustentam", () => {
  it("sem nenhuma evidência, promessa de prazo e isenção continua vetada", async () => {
    const { corpos } = interceptarSaida([veredito(true, "Garanto entrega amanhã")]);

    const resultado = await classifyPromise(
      poolDaOrg(),
      CFG,
      { tenantId: ORG, jobId: "turno-sem-evidencia" },
      { candidate: "Garanto entrega amanhã e isento a taxa de instalação.", model: MODELO },
      { registry: createDefaultRegistry(), log: LOG },
    );

    const corpo = corpos[0]!;
    // Caminho SEM evidências: instrução de sempre, sem o campo `evidencias` e
    // sem a ressalva que só vale quando há o que sustentar a condição.
    expect(systemDoCorpo(corpo)).toBe("");
    expect(String((corpo.messages as Array<{ content: string }>)[0]!.content)).not.toContain(
      "\"evidencias\"",
    );
    expect(String((corpo.messages as Array<{ content: string }>)[0]!.content)).toContain(
      "promessa COMERCIAL concreta",
    );
    expect(resultado).toMatchObject({ isPromise: true, suspectPhrase: "Garanto entrega amanhã" });
  });

  it("com evidência que não cobre o compromisso, a promessa continua vetada", async () => {
    const horario = {
      origem: "conhecimento" as const,
      referencia: "fonte-horario:trecho-1",
      titulo: "Horário de funcionamento",
      conteudo: "Abrimos das 8h às 18h, de segunda a sexta.",
    };
    const { corpos } = interceptarSaida([veredito(true, "entrego amanhã")]);

    const resultado = await classifyPromise(
      poolDaOrg(),
      CFG,
      { tenantId: ORG, jobId: "turno-evidencia-fora-de-escopo" },
      {
        candidate: "Abrimos às 8h e entrego amanhã sem taxa.",
        commercialEvidence: [horario],
        model: MODELO,
      },
      { registry: createDefaultRegistry(), log: LOG },
    );

    expect(pedidoDoCorpo(corpos[0]!).evidencias).toHaveLength(1);
    expect(resultado).toMatchObject({ isPromise: true, suspectPhrase: "entrego amanhã" });
  });
});
