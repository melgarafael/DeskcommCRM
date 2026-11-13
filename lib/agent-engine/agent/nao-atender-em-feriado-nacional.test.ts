/**
 * "NÃO ATENDER EM FERIADO NACIONAL" — a opção do agente, desligada de fábrica
 * (#3877, PR #4169, doc de decisão 316, alternativa A).
 *
 * O defeito que a triagem mediu no PR: o aviso só era chamado FORA da janela
 * semanal, então às 10h de Finados (segunda) nenhum aviso saía e a IA atendia
 * como num dia comum — e ligar o aviso sem adiar o turno faria o cliente
 * receber "estamos fechados" e, logo depois, a resposta da IA.
 *
 * O que estes testes fixam, nos dois sentidos:
 *
 *   - DESLIGADA (o padrão): feriado é dia comum — dentro do horário a IA
 *     atende, nada é adiado, nenhum aviso sai. É a `main` de antes da opção.
 *   - LIGADA: num feriado, quem escreve dentro do horário recebe o aviso E o
 *     turno espera a abertura do próximo dia útil. Os dois juntos.
 *   - LIGADA num dia útil comum: nada muda.
 *
 * Relógio: tudo é instante fixo. O turno recebe `clock` injetado e, por
 * garantia, o `Date` do processo também é congelado no mesmo instante — um
 * teste que dependesse do relógio real mudaria de resposta de madrugada.
 *
 * Harness do turno: o de `intervalo-entre-respostas-no-turno.test.ts` — o turno
 * segue o caminho de produção e para na primeira chamada de modelo
 * (`/config LLM/`), que é a prova de que ele NÃO foi adiado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const espiaDoAviso = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agent-engine/agent/destino-da-intencao", () => ({
  aplicaDestinoDaIntencao: vi.fn().mockResolvedValue({ status: "movido" }),
  funisDeProdutoDoRoteador: vi.fn().mockResolvedValue([]),
}));

// O envio do aviso em si (pacing, canal, dedupe) é medido em
// `aviso-fora-do-horario.test.ts`. Aqui o que importa é SE o turno o chama e
// com que fato do dia.
vi.mock("@/lib/agent-engine/agent/aviso-fora-do-horario", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/agent-engine/agent/aviso-fora-do-horario")>();
  return { ...real, enviaAvisoForaDoHorario: espiaDoAviso };
});

import { ehFeriadoNacionalNoFuso } from "@/lib/agent-engine/agent/feriado-nacional";
import { runAgentTurn } from "@/lib/agent-engine/agent/inbound-turn";
import {
  lerFechadoEmFeriadoNacional,
  msAteAJanelaAbrir,
  msAteAJanelaAbrirPulandoFeriado,
  type JanelaDeAtendimento,
} from "@/lib/agent-engine/agent/janela-de-atendimento";
import { versionPatchSchema } from "@/lib/ai/agents/validation";

const HORA = 60 * 60_000;

/** Segunda a sexta, 8h–18h em São Paulo (BRT = UTC-3, sem horário de verão). */
const JANELA: JanelaDeAtendimento = {
  timezone: "America/Sao_Paulo",
  start: "08:00",
  end: "18:00",
  weekdays: [1, 2, 3, 4, 5],
};

const ehFeriado = (instante: Date) => ehFeriadoNacionalNoFuso(instante, JANELA.timezone);

/** 02/11/2026, segunda, Finados — 10:00 BRT, DENTRO da janela semanal. */
const FINADOS_10H = new Date("2026-11-02T13:00:00.000Z");
/** 02/11/2026, Finados — 06:00 BRT, antes da abertura. */
const FINADOS_06H = new Date("2026-11-02T09:00:00.000Z");
/** 01/11/2026, domingo — 20:00 BRT; a segunda seguinte é Finados. */
const DOMINGO_ANTES_DE_FINADOS_20H = new Date("2026-11-01T23:00:00.000Z");
/** 03/11/2026, terça, dia útil — 10:00 BRT, dentro da janela. */
const TERCA_10H = new Date("2026-11-03T13:00:00.000Z");
/** 03/11/2026, terça, dia útil — 20:00 BRT, fora da janela. */
const TERCA_20H = new Date("2026-11-03T23:00:00.000Z");
/** 20/11/2026, sexta, Consciência Negra — 10:00 BRT. */
const CONSCIENCIA_NEGRA_10H = new Date("2026-11-20T13:00:00.000Z");
/** 08/02/2027, segunda de Carnaval — 10:00 BRT; a terça também é feriado. */
const CARNAVAL_SEGUNDA_10H = new Date("2027-02-08T13:00:00.000Z");

describe("msAteAJanelaAbrirPulandoFeriado — o próximo dia ÚTIL da janela", () => {
  it("feriado dentro do horário: espera a abertura do dia seguinte (Finados 10h → terça 8h)", () => {
    expect(msAteAJanelaAbrirPulandoFeriado(JANELA, FINADOS_10H, ehFeriado)).toBe(22 * HORA);
    // A janela semanal pura diria "aberta" — é a diferença que a opção faz.
    expect(msAteAJanelaAbrir(JANELA, FINADOS_10H)).toBeNull();
  });

  it("feriado antes da abertura: pula a abertura do feriado (Finados 6h → terça 8h)", () => {
    expect(msAteAJanelaAbrirPulandoFeriado(JANELA, FINADOS_06H, ehFeriado)).toBe(26 * HORA);
  });

  it("véspera de feriado: a abertura de segunda é pulada (domingo 20h → terça 8h)", () => {
    expect(msAteAJanelaAbrirPulandoFeriado(JANELA, DOMINGO_ANTES_DE_FINADOS_20H, ehFeriado)).toBe(36 * HORA);
  });

  it("feriado na sexta: o próximo dia útil é segunda (20/11 10h → 23/11 8h)", () => {
    expect(msAteAJanelaAbrirPulandoFeriado(JANELA, CONSCIENCIA_NEGRA_10H, ehFeriado)).toBe(70 * HORA);
  });

  it("dois feriados seguidos (Carnaval): segunda 10h → quarta 8h", () => {
    expect(msAteAJanelaAbrirPulandoFeriado(JANELA, CARNAVAL_SEGUNDA_10H, ehFeriado)).toBe(46 * HORA);
  });

  it("dia útil comum: idêntica à janela semanal", () => {
    expect(msAteAJanelaAbrirPulandoFeriado(JANELA, TERCA_10H, ehFeriado)).toBeNull();
    expect(msAteAJanelaAbrirPulandoFeriado(JANELA, TERCA_20H, ehFeriado)).toBe(msAteAJanelaAbrir(JANELA, TERCA_20H));
    expect(msAteAJanelaAbrirPulandoFeriado(JANELA, TERCA_20H, ehFeriado)).toBe(12 * HORA);
  });

  it("régua que nunca vê feriado: idêntica à janela semanal, inclusive no feriado", () => {
    const nunca = () => false;
    for (const instante of [FINADOS_10H, FINADOS_06H, DOMINGO_ANTES_DE_FINADOS_20H, TERCA_20H]) {
      expect(msAteAJanelaAbrirPulandoFeriado(JANELA, instante, nunca)).toBe(msAteAJanelaAbrir(JANELA, instante));
    }
  });

  it("régua que vê feriado em todo dia: falha ABERTA para a janela semanal, nunca mordaça", () => {
    const sempre = () => true;
    expect(msAteAJanelaAbrirPulandoFeriado(JANELA, TERCA_10H, sempre)).toBe(msAteAJanelaAbrir(JANELA, TERCA_10H));
  });
});

describe("a opção no trigger_config — desligada de fábrica", () => {
  const config = (bh: Record<string, unknown> | null) => ({ filters: { business_hours: bh } });

  it("só `true` liga; ausente, falso, outro tipo ou sem horário é DESLIGADA", () => {
    expect(lerFechadoEmFeriadoNacional(config({ ...JANELA, fechado_em_feriado_nacional: true }))).toBe(true);
    expect(lerFechadoEmFeriadoNacional(config({ ...JANELA }))).toBe(false);
    expect(lerFechadoEmFeriadoNacional(config({ ...JANELA, fechado_em_feriado_nacional: false }))).toBe(false);
    expect(lerFechadoEmFeriadoNacional(config({ ...JANELA, fechado_em_feriado_nacional: "true" }))).toBe(false);
    expect(lerFechadoEmFeriadoNacional(config(null))).toBe(false);
    expect(lerFechadoEmFeriadoNacional(null)).toBe(false);
    expect(lerFechadoEmFeriadoNacional("lixo")).toBe(false);
  });

  it("a API que salva a versão PRESERVA a opção (o Zod não a descarta)", () => {
    const parsed = versionPatchSchema.safeParse({
      trigger_config: { filters: { business_hours: { ...JANELA, fechado_em_feriado_nacional: true } } },
    });

    expect(parsed.success).toBe(true);
    expect(lerFechadoEmFeriadoNacional(parsed.data?.trigger_config)).toBe(true);
  });

  it("a API recusa valor que não é booleano", () => {
    const parsed = versionPatchSchema.safeParse({
      trigger_config: { filters: { business_hours: { ...JANELA, fechado_em_feriado_nacional: "sim" } } },
    });

    expect(parsed.success).toBe(false);
  });
});

// ─── O turno: aviso e adiamento juntos ──────────────────────────────────────

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const CANAL = "44444444-4444-4444-8444-444444444444";
const JOB = "55555555-5555-4555-8555-555555555555";
const MENSAGEM = "66666666-6666-4666-8666-666666666666";

const NOTICE = "Nosso atendimento funciona de segunda a sexta, das 8h às 18h.";

const AGENTE = {
  agentId: "agente-1",
  versionId: "v1",
  operationMode: "automatic",
  pausedAt: null,
  systemPrompt: "persona",
  toolIds: [],
  casesEnabled: false,
  historyMessageWindow: 20,
  historyTokenWindow: 1000,
  handoffKeywords: [],
  filtroDePalavraChave: null,
  janelaDeAtendimento: JANELA,
  avisoForaDoHorario: NOTICE,
};

const LINHA_DO_CONTATO = {
  name: "Cliente",
  display_name: null,
  email: null,
  phone_number: "5511999999999",
  tags: [],
  is_blocked: false,
  is_personal: false,
  source: "whatsapp",
  consent: null,
  is_anonymized: false,
};

interface Consulta {
  sql: string;
  params: unknown[];
}

const ehReagendamento = (sql: string) => /update job_queue\s+set status = 'pending'/.test(sql);

function bancoFingido(instante: Date, pais: string | null = null) {
  const consultas: Consulta[] = [];
  const doCliente = {
    direction: "inbound",
    type: "text",
    body: "vocês abrem hoje?",
    media_url: null,
    media_storage_path: null,
    media_mime: null,
    media_derived_text: null,
    sent_at: new Date(instante.getTime() - 2_000),
  };
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      consultas.push({ sql, params: params ?? [] });
      if (/select country from organizations where id = \$1/.test(sql)) return { rows: [{ country: pais }] };
      if (/from contacts where organization_id = \$1 and id = \$2/.test(sql)) {
        return { rows: [LINHA_DO_CONTATO] };
      }
      if (sql.includes("from messages") && /and id = \$3/.test(sql)) return { rows: [doCliente] };
      if (sql.includes("from messages") && sql.includes("media_mime")) return { rows: [doCliente] };
      if (sql.includes("playbook_pointers")) {
        return { rows: [{ layer: "platform", version_id: "v1", content: "plataforma" }] };
      }
      return { rows: [] };
    }),
  };
  return { pool, consultas };
}

async function turno(
  banco: ReturnType<typeof bancoFingido>,
  instante: Date,
  naoAtenderEmFeriadoNacional: boolean | undefined,
): Promise<Error | null> {
  vi.setSystemTime(instante);
  try {
    await runAgentTurn(
      {
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        llmCfg: {},
        crmCfg: {},
        knobs: { maxSteps: 1 },
        clock: () => instante,
      } as never,
      {
        id: JOB,
        organization_id: ORG,
        contact_id: CONTATO,
        kind: "inbound_turn",
        payload: { inbound_message_id: MENSAGEM },
        attempts: 1,
        claimed_by: "w",
        claimed_at: instante,
        created_at: new Date(instante.getTime() - 60_000),
      } as never,
      banco.pool as never,
      { workerId: "w" },
      {
        resolvedAgent: {
          config: { ...AGENTE, naoAtenderEmFeriadoNacional },
          routerId: null,
          intentName: null,
          confidence: null,
          outcome: "default",
        },
        channelSessionId: CANAL,
        conversationId: CONVERSA,
        inboundMessageId: MENSAGEM,
        buildOpening: () => "",
      } as never,
    );
    return null;
  } catch (err) {
    return err as Error;
  }
}

const reagendamentos = (b: ReturnType<typeof bancoFingido>) => b.consultas.filter((c) => ehReagendamento(c.sql));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  espiaDoAviso.mockResolvedValue({ enviar: true, texto: NOTICE });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("opção DESLIGADA (o padrão) — feriado é dia comum", () => {
  it.each([undefined, false])("valor %s: Finados 10h, a IA atende, nada é adiado, nenhum aviso", async (opcao) => {
    const banco = bancoFingido(FINADOS_10H);

    const erro = await turno(banco, FINADOS_10H, opcao);

    expect(String(erro?.message)).toMatch(/config LLM/);
    expect(reagendamentos(banco)).toHaveLength(0);
    expect(espiaDoAviso).not.toHaveBeenCalled();
  });
});

describe("opção LIGADA — feriado é dia fechado", () => {
  it("Finados 10h: sai o aviso E o turno espera terça 8h", async () => {
    const banco = bancoFingido(FINADOS_10H);

    const erro = await turno(banco, FINADOS_10H, true);

    expect(erro?.name).toBe("job_settled");
    expect(String(erro?.message)).toMatch(/fora do horário de funcionamento/);
    const [r] = reagendamentos(banco);
    expect(reagendamentos(banco)).toHaveLength(1);
    expect(r?.params[0]).toBe(JOB);
    expect(r?.params[2], "o turno não esperou o próximo dia útil").toBe(22 * HORA);

    // O aviso recebe o MESMO fato do dia que adiou o turno.
    expect(espiaDoAviso).toHaveBeenCalledTimes(1);
    expect(espiaDoAviso.mock.calls[0]?.[1]).toMatchObject({
      texto: NOTICE,
      agora: FINADOS_10H,
      ehFeriadoNacional: true,
    });
  });

  it("dia útil comum (terça 10h): nada muda — a IA atende, sem aviso", async () => {
    const banco = bancoFingido(TERCA_10H);

    const erro = await turno(banco, TERCA_10H, true);

    expect(String(erro?.message)).toMatch(/config LLM/);
    expect(reagendamentos(banco)).toHaveLength(0);
    expect(espiaDoAviso).not.toHaveBeenCalled();
  });

  it("organização fora do Brasil: o feriado brasileiro não fecha o agente", async () => {
    const banco = bancoFingido(FINADOS_10H, "PT");

    const erro = await turno(banco, FINADOS_10H, true);

    expect(String(erro?.message)).toMatch(/config LLM/);
    expect(reagendamentos(banco)).toHaveLength(0);
    expect(espiaDoAviso).not.toHaveBeenCalled();
  });
});
