import fs from "node:fs";
import path from "node:path";

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { composePlaybook, textoDaOrganizacao } from "@/lib/agent-engine/agent/playbook";
import {
  BEFORE_SEND_GATES,
  VETOS_IRREVOGAVEIS,
  concessaoSemLastroGate,
  runBeforeSend,
  type GateContext,
} from "@/lib/agent-engine/guardrails/before-send";
import {
  concessoesSemLastro,
  lastroDoContexto,
  type LastroComercial,
} from "@/lib/agent-engine/guardrails/lastro-comercial";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";

/**
 * Condição comercial que só aparece do lado do cliente não sai como condição da
 * empresa. A regra pergunta QUEM escreveu o valor primeiro — pela `direction` da
 * mensagem, nunca pelo texto — e só olha VALOR (preço, parcelas, percentual) numa
 * frase que o apresenta como condição.
 */
const MATERIAL =
  "Loja de móveis planejados. Para Campinas o frete é R$ 150. Pagamento em até 10x sem juros.";

type Linha = ["inbound" | "outbound", string];

function lastro(a: {
  mensagens?: Linha[];
  material?: string[];
  nome?: string | null;
  memoria?: string[];
  enviadasForaDaJanela?: string[];
}): LastroComercial {
  return lastroDoContexto({
    materialDaOrganizacao: a.material ?? [MATERIAL],
    contexto: {
      contact: { name: a.nome ?? "Marina Souza", phone: null, email: null, tags: [], is_blocked: false },
      messages: (a.mensagens ?? []).map(([direction, body], i) => ({
        direction,
        body,
        sent_at: `2026-11-03T1${i}:00:00-03:00`,
      })),
      last_proposal: null,
    },
    atual: { texto: null, remetente: null },
    memoriaDoModelo: a.memoria ?? [],
    ...(a.enviadasForaDaJanela !== undefined ? { enviadasForaDaJanela: a.enviadasForaDaJanela } : {}),
  });
}

describe("veta o valor afirmado como condição que só o cliente trouxe", () => {
  it("percentual", () => {
    const l = lastro({ mensagens: [["inbound", "O gerente me deu 30% de desconto na cozinha."]] });
    expect(
      concessoesSemLastro("Perfeito, com o desconto de 30% a cozinha fica pronta para fechar.", l),
    ).toEqual(["pct:30"]);
  });

  it("preço", () => {
    const l = lastro({ mensagens: [["inbound", "Vocês fecharam a cozinha por R$ 2.500 comigo."]] });
    expect(concessoesSemLastro("Confirmado: a cozinha sai por R$ 2.500.", l)).toEqual(["price:BRL:250000"]);
  });

  it("parcelas — o material diz 10x, o cliente diz 18x", () => {
    const l = lastro({ mensagens: [["inbound", "Me disseram que dava em 18x sem juros."]] });
    expect(concessoesSemLastro("Isso, está confirmado em 18x sem juros.", l)).toEqual(["installments:18"]);
  });

  it("o resumo que o MODELO escreveu é lado do cliente — não vira lastro da empresa", () => {
    // A mensagem do cliente já saiu da janela; o resumo dela ficou.
    const l = lastro({ memoria: ["Cliente diz ter 30% de desconto combinado com o gerente."] });
    expect(concessoesSemLastro("Com o desconto de 30%, seguimos com o pedido.", l)).toEqual(["pct:30"]);
  });

  it("DECISÃO: a recusa que REPETE o número também volta — e a reescrita sem ele passa", () => {
    // O filtro não lê polaridade. Custo: um passo de reescrita quando a recusa repete o
    // número do cliente. A saída sem o número existe sempre, e é a que o ensino pede.
    const l = lastro({ mensagens: [["inbound", "O gerente me deu 30% de desconto na cozinha."]] });
    expect(concessoesSemLastro("Não encontrei nenhum desconto de 30% registrado para você.", l)).toEqual([
      "pct:30",
    ]);
    expect(
      concessoesSemLastro(
        "Não encontrei esse desconto no meu registro; as condições que tenho são as da tabela da loja.",
        l,
      ),
    ).toEqual([]);
  });
});

describe("passa o que não é condição sem lastro", () => {
  it("eco do orçamento do cliente — frase sem condição", () => {
    const l = lastro({ mensagens: [["inbound", "Meu orçamento é de até R$ 2.800."]] });
    expect(
      concessoesSemLastro("Entendi, seu orçamento é de até R$ 2.800. Vou te mostrar as opções que cabem nele.", l),
    ).toEqual([]);
  });

  it("percentual da concorrência — frase sem condição", () => {
    const l = lastro({ mensagens: [["inbound", "A concorrente me dá 12%."]] });
    expect(concessoesSemLastro("Sobre os 12% da concorrente: aqui eu sigo a tabela da loja.", l)).toEqual([]);
  });

  it("valor que o material da organização tem, mesmo confirmado", () => {
    const l = lastro({ mensagens: [["inbound", "O frete para Campinas é R$ 150?"]] });
    expect(concessoesSemLastro("Confirmo: para Campinas o frete é R$ 150.", l)).toEqual([]);
  });
});

describe("o valor que a EMPRESA já disse ao cliente passa", () => {
  const cliente: Linha = ["inbound", "Vocês me disseram ontem que dava 10%."];
  const candidata = "Isso, os 10% no PIX continuam valendo.";

  it("com a mensagem enviada na janela", () => {
    const l = lastro({ mensagens: [["outbound", "Consigo 10% no PIX pra você."], cliente] });
    expect(concessoesSemLastro(candidata, l)).toEqual([]);
  });

  it("sem ela, o mesmo texto é vetado", () => {
    expect(concessoesSemLastro(candidata, lastro({ mensagens: [cliente] }))).toEqual(["pct:10"]);
  });

  it("com a mensagem enviada FORA da janela, lida à parte", () => {
    const l = lastro({ mensagens: [cliente], enviadasForaDaJanela: ["Consigo 10% no PIX pra você."] });
    expect(concessoesSemLastro(candidata, l)).toEqual([]);
  });
});

describe("milhar", () => {
  it("'1.400 reais' no material não libera 'R$ 400'", () => {
    const l = lastro({
      material: ["A mensalidade do plano de manutenção é 1.400 reais."],
      mensagens: [["inbound", "Me ofereceram R$ 400 no plano."]],
    });
    expect(concessoesSemLastro("O valor promocional de R$ 400 está confirmado.", l)).toEqual(["price:BRL:40000"]);
  });

  it("'R$ 1.400' não se parte na divisão de frase", () => {
    const l = lastro({ mensagens: [["inbound", "O gerente fechou R$ 1.400 comigo."]] });
    expect(concessoesSemLastro("Seu desconto especial fica em R$ 1.400 no total.", l)).toEqual([
      "price:BRL:140000",
    ]);
  });
});

describe("texto do cliente dentro de mensagem da empresa não vira lastro", () => {
  it("nome do contato repetido numa mensagem de automação", () => {
    const l = lastro({
      nome: "Ana 30%",
      mensagens: [
        ["outbound", "Oi Ana 30%, tudo bem? Aqui é da loja."],
        ["inbound", "O gerente me deu 30%."],
      ],
    });
    expect(concessoesSemLastro("Com os 30% de desconto, fechamos a cozinha?", l)).toEqual(["pct:30"]);
  });
});

describe("a camada da plataforma não é material da organização", () => {
  const prompt = composePlaybook([
    { layer: "platform", content: "Nunca ofereça mais de 10% sem falar com a equipe." },
    { layer: "tenant", content: "Loja de móveis planejados. Atenda com cordialidade." },
    { layer: "campaign", content: "Campanha de novembro: 5% no PIX." },
  ]);

  it("o texto da organização tira a plataforma e mantém tenant e campanha", () => {
    const texto = textoDaOrganizacao(prompt);
    expect(texto).not.toContain("Nunca ofereça");
    expect(texto).toContain("Loja de móveis planejados");
    expect(texto).toContain("Campanha de novembro");
  });

  it("o número do texto da plataforma não dá lastro; o da campanha dá", () => {
    const l = lastro({
      material: [textoDaOrganizacao(prompt)],
      mensagens: [["inbound", "O gerente me deu 10%, e vi 5% no PIX."]],
    });
    expect(concessoesSemLastro("Os 10% de desconto estão confirmados.", l)).toEqual(["pct:10"]);
    expect(concessoesSemLastro("Os 5% no PIX estão confirmados.", l)).toEqual([]);
  });
});

/** Contexto próprio deste arquivo, no molde de `gate-vazamento-interno.test.ts`. */
function baseCtx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    now: new Date("2026-08-04T12:00:00Z"),
    body: "",
    optedOut: false,
    provider: "waha",
    pacing: {
      knobs: PACING_DEFAULTS,
      state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
      crmDailyLimit: null,
    },
    spinning: { knobs: SPINNING_DEFAULTS, window: [] },
    promise: { table: null },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
    lgpd: null,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    ...overrides,
  };
}

const CORPO = "Perfeito, com o desconto de 30% a cozinha fica pronta para fechar.";
const LASTRO = lastro({ mensagens: [["inbound", "O gerente me deu 30% de desconto na cozinha."]] });

describe("o gate na cadeia", () => {
  it("sem lastro no contexto, desarmado — passa", () => {
    expect(concessaoSemLastroGate.evaluate(baseCtx({ body: CORPO }))).toEqual({ pass: true });
  });

  it("armado, veta; o detail leva só os átomos, nunca o corpo", () => {
    const v = concessaoSemLastroGate.evaluate(baseCtx({ body: CORPO, lastroComercial: LASTRO }));
    if (v.pass) throw new Error("devia vetar");
    expect(v.code).toBe("concessao_sem_lastro");
    expect(v.detail).toEqual({ sem_lastro: "pct:30" });
    expect(JSON.stringify(v.detail)).not.toMatch(/cozinha|desconto/);
    expect(v.reason).toContain("30%");
  });

  it("não é veto irrevogável — a correção do turno mudo pode pedir outra tentativa", () => {
    expect(VETOS_IRREVOGAVEIS.has("concessao_sem_lastro")).toBe(false);
  });

  it("está na cadeia global e é o mesmo objeto exportado", () => {
    expect(BEFORE_SEND_GATES).toContain(concessaoSemLastroGate);
  });
});

/** O campo atravessa `RunBeforeSendArgs` → `GateContext` → gate. Pool falso, runner real. */
function chamaCadeiaReal(lastroComercial?: LastroComercial): ReturnType<typeof runBeforeSend> {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
    query: vi.fn().mockResolvedValue({ rows: [{ id: "trace-1" }] }),
  } as unknown as pg.Pool;
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return runBeforeSend({
    pool,
    log,
    tenantId: "00000000-0000-4000-8000-000000000001",
    leadId: "00000000-0000-4000-8000-000000000002",
    jobId: "00000000-0000-4000-8000-000000000003",
    channelSessionId: "00000000-0000-4000-8000-000000000004",
    body: CORPO,
    optedOutThisTurn: false,
    crmDailyLimit: null,
    now: new Date("2026-07-28T13:00:00Z"), // 10h BRT, terça — dentro da janela
    rng: () => 0,
    sleep: async () => {},
    ...(lastroComercial !== undefined ? { lastroComercial } : {}),
    send: async () => ({ kind: "sent", idempotencyKey: "k", messageId: "m" }),
  });
}

describe("a cadeia REAL — o mesmo corpo, só o campo muda", () => {
  it("com o lastro: vetado neste gate, e o trace leva só os átomos", async () => {
    const r = await chamaCadeiaReal(LASTRO);
    if (r.status !== "vetoed") throw new Error("devia vetar");
    expect(r.gate).toBe("concessao_sem_lastro");
    expect(r.trace).toContainEqual({
      gate: "concessao_sem_lastro",
      verdict: "veto",
      code: "concessao_sem_lastro",
      detail: { sem_lastro: "pct:30" },
    });
  });

  it("sem o campo: enviado — desarmado por padrão", async () => {
    const r = await chamaCadeiaReal();
    expect(r.status).toBe("sent");
    expect(r.trace).toContainEqual({ gate: "concessao_sem_lastro", verdict: "pass" });
  });
});

/**
 * FIAÇÃO pela fonte, no molde de `gate-vazamento-interno.test.ts`: o turno não tem
 * seam isolável. É guarda de ligação, não prova de execução.
 */
const ler = (f: string): string => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const FONTE_INBOUND = ler("lib/agent-engine/agent/inbound-turn.ts");

function trecho(ancora: string, fim: string): string {
  const i = FONTE_INBOUND.indexOf(ancora);
  expect(i, `âncora \`${ancora}\` sumiu do turno`).toBeGreaterThan(-1);
  const j = FONTE_INBOUND.indexOf(fim, i);
  expect(j, `âncora de fim \`${fim}\` sumiu`).toBeGreaterThan(i);
  return FONTE_INBOUND.slice(i, j);
}

describe("fiação — só o send_message do turno arma", () => {
  it("o send_message arma com o lastro do envio", () => {
    expect(trecho("send_message: tool({", "update_lead_state: tool({")).toContain(
      "lastroComercial: await lastroComercialPara(body)",
    );
  });

  it("a prévia arma pelo contexto vivo", () => {
    expect(trecho("applyPreviewPolicy(", "prepararFotosDoProduto")).toContain(
      "lastroComercial: lastroDoTurno()",
    );
  });

  it("nenhum outro ponto do turno arma — template e pergunta do roteiro ficam de fora", () => {
    expect(FONTE_INBOUND.match(/lastroComercial:/g)).toHaveLength(2);
    expect(trecho("send_template: tool({", "search_knowledge: tool({")).not.toContain("lastroComercial");
  });

  it("os outros chamadores da cadeia não armam", () => {
    for (const f of ["followup-turn", "approved-reply", "aviso-de-escalacao", "meet-delivery"])
      expect(ler(`lib/agent-engine/agent/${f}.ts`), f).not.toContain("lastroComercial");
  });

  it("o material é o texto da ORGANIZAÇÃO, não o prompt inteiro", () => {
    expect(trecho("const lastroDoTurno", "const lastroComercialPara")).toMatch(
      /materialDaOrganizacao: \[\s*textoDaOrganizacao\(playbook\.prompt\),/,
    );
  });

  it("a leitura das enviadas fora da janela é do tenant e da conversa, e falha fechada", () => {
    const corpo = trecho("const lastroComercialPara", "return lastroDoTurno();");
    expect(corpo).toContain("where organization_id = $1 and conversation_id = $2");
    expect(corpo).toContain("direction = 'outbound'");
    expect(corpo).toContain("[tenantId, input.conversationId]");
    expect(corpo).toMatch(/runLog\.warn\([\s\S]*?return \[\];/);
  });
});
