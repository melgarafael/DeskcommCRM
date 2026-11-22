// @vitest-environment node
/**
 * #4927 — a LISTA DE HORÁRIOS LIVRES que o agente acabou de tirar de
 * `crm_find_free_slots` é EVIDÊNCIA do turno, não promessa do modelo.
 *
 * O traço da issue (1.117.0, self-host, conferência ligada por padrão) é curto:
 * `crm_list_event_types` ok, `crm_find_free_slots` ok e as `send_message`
 * seguintes vetadas com `promise_semantic` — "Tenho estes horários disponíveis
 * para consulta (1h30): …". Os horários barrados são EXATAMENTE os que a agenda
 * devolveu. O turno só passa quando o modelo desiste da lista e manda uma frase
 * vaga, sem data e sem horário — a pessoa fica sem saber quando marcar.
 *
 * A causa está no EVIDENCIADOR, não no rigor: só catálogo, conhecimento e a
 * leitura do servidor MCP EXTERNO viravam evidência comercial
 * (`inbound-turn.ts`, ramo `mcp.leiturasRemotas.has(name)`). As tools de agenda
 * NATIVAS ficavam de fora, e sem lastro o revisor lia a lista como "vaga
 * confirmada sem comprovação". O conserto registra o retorno delas na MESMA
 * origem `servidor_externo` — que sustenta relatar data, horário, duração e
 * situação, nunca condição comercial.
 *
 * O que este arquivo prende, em três desfechos:
 *   1. lista com lastro PASSA (o caso da issue);
 *   2. a MESMA frase sem o registro continua vetada, com o mesmo código —
 *      nenhum afrouxamento do veto;
 *   3. desconto/prazo SEM ferramenta que o sustente continua vetado com
 *      `promise_semantic`, mesmo com a agenda do turno na mão.
 *
 * A variação entre execuções do #4665 é issue vizinha: aqui só se mede que as
 * DUAS redações da mesma frase têm o MESMO desfecho e a MESMA evidência.
 *
 * A costura do turno é reproduzida aqui na forma mínima — o `execute` de cada
 * tool chama `registrarConsultaDeAgenda` direto. Isso prova o registrador e a
 * conferência, não o loop do turno. Que `crm_list_event_types` chega ao
 * registrador pelo `inbound-turn.ts` (ramo `comEvidenciaDoCadastroDaAgenda`,
 * fora de `AGENDA_TOOL_NAMES`) é medido em `lib/agent-engine/agent/inbound-turn.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock("@/lib/agent-engine/edge/llm/run-model-call", () => ({ runModelCall: seam.call }));

import { criarEvidenciasComerciaisDoTurno } from "@/lib/agent-engine/guardrails/promise/evidencias-comerciais";
import { classifyPromise } from "@/lib/agent-engine/guardrails/promise/semantic";
import { semanticPromiseGate, type GateContext } from "@/lib/agent-engine/guardrails/before-send";
import type { LlmEdgeConfig } from "@/lib/agent-engine/edge/llm/run-model-call";
import type pg from "pg";

const ORG = "bcc12320-f555-4fef-8d90-38a0ac5950e0";
const FUSO = "America/Sao_Paulo";

/** Os horários que a agenda devolveu no turno da issue — 18, 19 e 20/11. */
const HORARIOS = [
  ["Qua 18/11 às 16:30", "2026-11-18T19:30:00.000Z", "2026-11-18T21:00:00.000Z"],
  ["Qui 19/11 às 08:00", "2026-11-19T11:00:00.000Z", "2026-11-19T12:30:00.000Z"],
  ["Qui 19/11 às 09:30", "2026-11-19T12:30:00.000Z", "2026-11-19T14:00:00.000Z"],
  ["Qui 19/11 às 13:30", "2026-11-19T16:30:00.000Z", "2026-11-19T18:00:00.000Z"],
  ["Qui 19/11 às 15:00", "2026-11-19T18:00:00.000Z", "2026-11-19T19:30:00.000Z"],
  ["Qui 19/11 às 16:30", "2026-11-19T19:30:00.000Z", "2026-11-19T21:00:00.000Z"],
  ["Sex 20/11 às 08:00", "2026-11-20T11:00:00.000Z", "2026-11-20T12:30:00.000Z"],
  ["Sex 20/11 às 09:30", "2026-11-20T12:30:00.000Z", "2026-11-20T14:00:00.000Z"],
  ["Sex 20/11 às 13:30", "2026-11-20T16:30:00.000Z", "2026-11-20T18:00:00.000Z"],
  ["Sex 20/11 às 15:00", "2026-11-20T18:00:00.000Z", "2026-11-20T19:30:00.000Z"],
  ["Sex 20/11 às 16:30", "2026-11-20T19:30:00.000Z", "2026-11-20T21:00:00.000Z"],
] as const;

/** O retorno real de `crm_find_free_slots` (`payloadDeHorarios`). */
const RESULTADO_DOS_HORARIOS = {
  horarios: HORARIOS.map(([quando, inicio, fim]) => ({ inicio, fim, quando })),
  total_de_horarios: HORARIOS.length,
  ha_mais: false,
  fuso_da_regra: FUSO,
  publicou_horarios: true,
  fuso_suposto: false,
  fontes_defasadas: [],
  agenda_externa_nunca_lida: false,
};

/** O retorno real de `crm_list_event_types` — a duração de 1h30 vem daqui. */
const RESULTADO_DOS_TIPOS = {
  tipos: [
    {
      slug: "consulta-inicial",
      nome: "Consulta inicial",
      descricao: "Avaliação com a profissional.",
      duracao_minutos: 90,
      onde: "Presencial · Unidade Centro",
      // Preço cadastrado: NÃO pode virar evidência — a origem `servidor_externo`
      // não autoriza oferta, e o registro não é política comercial.
      preco_padrao_cents: 35000,
      precisa_confirmacao: true,
    },
  ],
};

/** A frase da issue, na redação 1. */
const FRASE_1 =
  "Tenho estes horários disponíveis para consulta (1h30): hoje, quarta-feira, às 16h30; " +
  "quinta-feira às 8h, 9h30, 13h30, 15h ou 16h30; e sexta-feira às 8h, 9h30, 13h30, 15h ou 16h30.";

/** A MESMA frase, na redação 2 (a segunda tentativa vetada no traço). */
const FRASE_2 =
  "Na agenda, aparecem estes horários para consulta (1h30): quarta-feira, 18/11, às 16h30; " +
  "quinta-feira, 19/11, às 8h, 9h30, 13h30, 15h ou 16h30; e sexta-feira, 20/11, às 8h, 9h30, 13h30, 15h ou 16h30.";

/** A 3ª frase vetada no traço: só a duração, sem lista. */
const FRASE_DURACAO = "A consulta dura 1h30.";

type Executavel = { execute: () => Promise<unknown> };

/**
 * O turno como o engine o monta: as duas tools executam e cada retorno é
 * registrado pelo MESMO `registrarConsultaDeAgenda` que o ramo
 * `AGENDA_TOOL_NAMES` de `inbound-turn.ts` chama. `falha` é a tool que voltou
 * com erro — ela não pode virar evidência de sucesso.
 */
async function turnoDaIssue(modo: "ok" | "falha" = "ok") {
  const evidencias = criarEvidenciasComerciaisDoTurno([]);
  const tools: Record<string, Executavel> = {
    crm_list_event_types: {
      execute: async () =>
        modo === "falha" ? { ok: false, error: "agenda indisponível" } : RESULTADO_DOS_TIPOS,
    },
    crm_find_free_slots: {
      execute: async () =>
        modo === "falha" ? { ok: false, error: "agenda indisponível" } : RESULTADO_DOS_HORARIOS,
    },
  };
  for (const [nome, tool] of Object.entries(tools)) {
    const resultado = await tool.execute();
    evidencias.registrarConsultaDeAgenda(nome, resultado);
  }
  return evidencias;
}

const db = {} as pg.Pool;
const cfg = {} as LlmEdgeConfig;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/** "8h", "9h30", "16:30" → "08:00", "09:30", "16:30" — a régua em que a agenda fala. */
function horariosCitados(frase: string): string[] {
  // Duração não é horário: "(1h30)" e "dura 1h30" saem antes de a régua rodar,
  // senão "1h30" viraria o horário "01:30" e a frase certa seria vetada por ele.
  const semDuracao = frase.replace(/\(\s*\d+h\d*\s*\)/g, " ").replace(/dura\s+\d+h\d*/g, " ");
  const comH = [...semDuracao.matchAll(/(\d{1,2})h(\d{2})?/g)].map(
    ([, h, m]) => `${h!.padStart(2, "0")}:${m ?? "00"}`,
  );
  const comDoisPontos = [...semDuracao.matchAll(/(\d{1,2}):(\d{2})/g)].map(
    ([, h, m]) => `${h!.padStart(2, "0")}:${m!}`,
  );
  return [...new Set([...comH, ...comDoisPontos])];
}

/**
 * O revisor de mentira aplica a REGRA que a instrução descreve, e só ela: o que
 * a evidência da agenda registra (dia/horário/duração) é RELATO; o que ela não
 * registra — ou uma condição comercial, que a origem `servidor_externo` nunca
 * autoriza — é promessa. O teste prende a evidência que chega ao revisor e o
 * veredito do gate; a inferência do modelo não é o que se mede aqui.
 */
function revisorQueLeAAgenda() {
  seam.call.mockImplementation(async (...args: unknown[]) => {
    const request = args[2] as { messages: Array<{ content: string }> };
    let mensagem = "";
    let lastro = "";
    try {
      const pedido = JSON.parse(request.messages[0]!.content) as {
        mensagem?: string;
        evidencias?: Array<{ titulo: string; conteudo: string }>;
      };
      mensagem = pedido.mensagem ?? "";
      lastro = (pedido.evidencias ?? []).map((e) => `${e.titulo}\n${e.conteudo}`).join("\n");
    } catch {
      // Sem evidência o pedido vai como TEXTO (`buildPromiseMessage`): é o
      // caminho do defeito — nada de agenda chega ao revisor.
      mensagem = request.messages[0]!.content;
      lastro = "";
    }
    const semLastro = horariosCitados(mensagem).filter((h) => !lastro.includes(`às ${h}`));
    const duracaoSemLastro = /1h30/.test(mensagem) && !lastro.includes("1h30");
    // Desconto/prazo/garantia: a evidência de agenda não autoriza nenhum deles.
    const comercial = /desconto|parcelo|prazo|garantia|grátis|gratuidade/i.test(mensagem);
    const suspeita = comercial
      ? "te dou 20% de desconto"
      : (semLastro[0] ?? (duracaoSemLastro ? "1h30" : ""));
    const isPromise = comercial || semLastro.length > 0 || duracaoSemLastro;
    return {
      result: {
        text: JSON.stringify({
          isPromise,
          suspectPhrase: isPromise && suspeita !== "" ? suspeita : null,
          prometeuRetornoHumano: false,
          retornoSoDoAssistente: false,
        }),
      },
    };
  });
}

function gateCom(classificacao: Awaited<ReturnType<typeof classifyPromise>>): GateContext {
  return { body: FRASE_1, semanticPromise: classificacao } as unknown as GateContext;
}

/** Cada teste é um TURNO: `jobId` entra na chave do cache de veredito (#4665). */
let turno = 0;
async function classificar(
  frase: string,
  evidencias: ReturnType<typeof criarEvidenciasComerciaisDoTurno>,
  jobId = `run-4927-${++turno}`,
) {
  return classifyPromise(
    db,
    cfg,
    { tenantId: ORG, jobId },
    { candidate: frase, commercialEvidence: evidencias.ler(frase) },
    { log },
  );
}

beforeEach(() => {
  seam.call.mockReset();
  log.warn.mockReset();
});

describe("#4927 — a agenda nativa vira evidência `servidor_externo` do turno", () => {
  it("a lista devolvida por `crm_find_free_slots` entra como evidência: um item por horário", async () => {
    const evidencias = await turnoDaIssue();
    const lidas = evidencias.ler(FRASE_1).filter((e) => e.origem === "servidor_externo");
    // 1 cabeçalho por consulta (2 tools) + 11 horários + 1 tipo.
    expect(lidas.filter((e) => e.titulo.startsWith("Horário livre"))).toHaveLength(HORARIOS.length);
    expect(lidas.filter((e) => e.titulo.startsWith("Consulta à agenda"))).toHaveLength(2);
    const quarta = lidas.find((e) => e.conteudo.includes("Qua 18/11 às 16:30"));
    expect(quarta?.conteudo).toContain("2026-11-18T19:30:00.000Z");
  });

  it("a duração do tipo de atendimento vem junto, nas duas formas que a pessoa fala", async () => {
    const evidencias = await turnoDaIssue();
    const tipo = evidencias.ler(FRASE_DURACAO).find((e) => e.conteudo.includes("Consulta inicial"));
    expect(tipo?.conteudo).toContain("90 minutos (1h30)");
    expect(tipo?.conteudo).toContain("depende de confirmação da equipe");
  });

  it("o PREÇO cadastrado do tipo NÃO vira evidência — o registro relata, não autoriza oferta", async () => {
    const evidencias = await turnoDaIssue();
    const tudo = JSON.stringify(evidencias.contexto());
    expect(tudo).not.toContain("35000");
    expect(tudo).not.toContain("R$");
    // E o material da organização segue só com catálogo/conhecimento: a agenda
    // não dá lastro a concessão comercial nenhuma.
    expect(evidencias.materialDaOrganizacao()).toBe("[]");
  });

  it("tool de agenda que FALHOU não vira evidência de sucesso", async () => {
    const evidencias = await turnoDaIssue("falha");
    expect(evidencias.ler(FRASE_1)).toEqual([]);
  });
});

describe("#4927 — os três desfechos na conferência de promessa", () => {
  it("⭐ CASO 1: lista com lastro PASSA (frase 1 e frase 2 da issue)", async () => {
    revisorQueLeAAgenda();
    const evidencias = await turnoDaIssue();
    for (const frase of [FRASE_1, FRASE_2]) {
      const classificacao = await classificar(frase, evidencias);
      expect(classificacao.isPromise).toBe(false);
      expect(semanticPromiseGate.evaluate(gateCom(classificacao)).pass).toBe(true);
    }
  });

  it("a duração sozinha também passa: ela está no cadastro que a tool devolveu", async () => {
    revisorQueLeAAgenda();
    const evidencias = await turnoDaIssue();
    const classificacao = await classificar(FRASE_DURACAO, evidencias);
    expect(classificacao.isPromise).toBe(false);
    expect(semanticPromiseGate.evaluate(gateCom(classificacao)).pass).toBe(true);
  });

  it("⭐ CASO 2: SEM o registro, a MESMA frase continua vetada pelo mesmo código", async () => {
    revisorQueLeAAgenda();
    // O turno do defeito: agenda consultada, retorno NÃO registrado como evidência.
    const evidencias = criarEvidenciasComerciaisDoTurno([]);
    const classificacao = await classificar(FRASE_1, evidencias);
    expect(classificacao.isPromise).toBe(true);
    const veredito = semanticPromiseGate.evaluate(gateCom(classificacao));
    expect(veredito.pass).toBe(false);
    if (veredito.pass) throw new Error("devia vetar");
    expect(veredito.code).toBe("promise_semantic");
  });

  it("⭐ CASO 3: desconto/prazo SEM ferramenta que o sustente continua barrado, mesmo com a agenda no turno", async () => {
    revisorQueLeAAgenda();
    const evidencias = await turnoDaIssue();
    for (const frase of [
      "Fechado: te dou 20% de desconto se confirmar hoje.",
      "Consigo segurar esse valor e te dou 20% de desconto na quinta.",
    ]) {
      const classificacao = await classificar(frase, evidencias);
      expect(classificacao.isPromise).toBe(true);
      const veredito = semanticPromiseGate.evaluate({
        ...gateCom(classificacao),
        body: frase,
      } as GateContext);
      expect(veredito.pass).toBe(false);
      if (veredito.pass) throw new Error("devia vetar");
      expect(veredito.code).toBe("promise_semantic");
    }
  });

  it("⭐ CASO 4: a mesma frase escrita de dois jeitos tem o MESMO desfecho e a MESMA evidência", async () => {
    revisorQueLeAAgenda();
    const evidencias = await turnoDaIssue();

    const referencias = (frase: string) =>
      evidencias
        .ler(frase)
        .map((e) => e.referencia)
        .sort();
    // A seleção de evidência não depende da redação: as duas frases nomeiam os
    // MESMOS horários, e todos cabem no pacote do revisor.
    expect(referencias(FRASE_2)).toEqual(referencias(FRASE_1));

    const primeira = await classificar(FRASE_1, evidencias, "run-4927-variacao");
    const segunda = await classificar(FRASE_2, evidencias, "run-4927-variacao");
    expect(segunda.isPromise).toBe(primeira.isPromise);
    expect(semanticPromiseGate.evaluate(gateCom(primeira)).pass).toBe(
      semanticPromiseGate.evaluate(gateCom(segunda)).pass,
    );
    // Rodar de novo não muda o veredito: mesma frase, mesmo turno, mesmo
    // desfecho — o cache por conteúdo do #4665 devolve o veredito já dado, sem
    // uma segunda chamada que pudesse vir diferente.
    const chamadasAntes = seam.call.mock.calls.length;
    const repetida = await classificar(FRASE_1, evidencias, "run-4927-variacao");
    expect(repetida.isPromise).toBe(primeira.isPromise);
    expect(seam.call.mock.calls.length).toBe(chamadasAntes);
    expect(chamadasAntes).toBe(2);
  });
});

describe("#4927 — o pedido ao revisor leva a agenda como DADO", () => {
  it("as evidências vão no campo `evidencias`, e a instrução as trata como fato", async () => {
    revisorQueLeAAgenda();
    const evidencias = await turnoDaIssue();
    await classificar(FRASE_1, evidencias);
    const request = seam.call.mock.calls[0]![2] as {
      system?: string;
      messages: Array<{ content: string }>;
    };
    const pedido = JSON.parse(request.messages[0]!.content) as {
      evidencias?: Array<{ origem: string }>;
    };
    expect(pedido.evidencias).toEqual(
      expect.arrayContaining([expect.objectContaining({ origem: "servidor_externo" })]),
    );
    expect(request.system).toContain("é relatar um fato, não prometer");
    expect(request.system).toContain("LISTA DE HORÁRIOS LIVRES");
    expect(request.system).toContain("duração");
    // A casa do veto não mudou de vocabulário: o código é o de sempre.
    expect(request.system).toContain("nunca política comercial");
  });
});
