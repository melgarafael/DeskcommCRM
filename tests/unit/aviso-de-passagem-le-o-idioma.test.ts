/**
 * OS DOIS EMISSORES DO AVISO DE PASSAGEM LEEM O IDIOMA DA ORGANIZAÇÃO.
 *
 * `tests/unit/aviso-ao-lead.test.ts` mede a FRASE em cada idioma. Este arquivo
 * mede o ENCANAMENTO: que `avisarLeadDaEscalacao` (motor, `pg.Pool`) e
 * `avisarLeadDoCrm` (CRM, supabase-js) de fato leem `organizations.locale` e
 * mandam ao cliente a frase desse idioma — sem isto, o texto em espanhol
 * existiria e nenhum cliente o receberia.
 *
 * E a outra metade do contrato: a leitura do idioma que FALHA não cancela o
 * aviso. Idioma é enfeite comparado a avisar o cliente de que uma pessoa vem;
 * sem idioma, a frase sai em português, como antes.
 *
 * Medido numa loja em espanhol (26/09/2026): o cliente irritado recebeu "Esse
 * caso é melhor resolvido por uma pessoa…" no meio do pedido.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const corpoDoMotor = vi.hoisted(() => ({ valor: null as string | null }));
const enviarPeloCrm = vi.fn();

vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({
  runBeforeSend: vi.fn(async (args: { body: string }) => {
    corpoDoMotor.valor = args.body;
    return { status: "sent", outcome: { kind: "sent" }, trace: [] };
  }),
}));
vi.mock("@/lib/escalacao/disponibilidade", () => ({
  expectativaDeAtendimento: vi.fn(async () => ({ quem: null, frase: "" })),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: (...args: unknown[]) => enviarPeloCrm(...args),
}));
vi.mock("@/lib/escalacao/atendentes", () => ({
  carregarRosterDeAtendimento: vi.fn(async () => []),
  podeAssumirAgora: vi.fn(() => false),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { avisarLeadDaEscalacao } from "@/lib/agent-engine/agent/aviso-de-escalacao";
import { avisarLeadDoCrm } from "@/lib/ai/handoff/aviso-ao-lead";
import { motivoDoAviso, textoDoAviso } from "@/lib/escalacao/aviso-ao-lead";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/** `pg.Pool` de mentira: só a leitura do idioma importa aqui. */
function poolComIdioma(locale: string | null | Error) {
  return {
    query: vi.fn(async (sql: string) => {
      if (/from organizations/.test(sql)) {
        if (locale instanceof Error) throw locale;
        return { rows: [{ locale }] };
      }
      return { rows: [] };
    }),
  };
}

function avisaPeloMotor(pool: ReturnType<typeof poolComIdioma>) {
  return avisarLeadDaEscalacao(
    pool as never,
    { tenantId: ORG, leadId: LEAD, conversationId: CONVERSA, channelSessionId: "sessao", jobId: "job" },
    {
      motivo: "pediu_humano",
      channel: {} as never,
      optedOutThisTurn: false,
      now: new Date("2026-09-26T15:00:00Z"),
      log: log as never,
    },
  );
}

/** Cliente supabase-js de mentira: só `organizations.locale` é lido por ele. */
function adminComIdioma(locale: string | null | Error) {
  return {
    from: (tabela: string) => {
      if (tabela !== "organizations") throw new Error(`tabela inesperada: ${tabela}`);
      if (locale instanceof Error) throw locale;
      const cadeia = {
        select: () => cadeia,
        eq: () => cadeia,
        maybeSingle: async () => ({ data: { locale }, error: null }),
      };
      return cadeia;
    },
  };
}

function avisaPeloCrm(admin: ReturnType<typeof adminComIdioma>) {
  return avisarLeadDoCrm(admin as never, {
    organizationId: ORG,
    conversationId: CONVERSA,
    contactId: LEAD,
    reason: "requested_human",
  });
}

function corpoEnviadoPeloCrm(): string {
  const chamada = enviarPeloCrm.mock.calls.at(-1);
  return (chamada?.[2] as { body: string }).body;
}

beforeEach(() => {
  corpoDoMotor.valor = null;
  enviarPeloCrm.mockReset();
  enviarPeloCrm.mockResolvedValue({ status: "sent", error_code: null });
});

describe("motor de conversa (`avisarLeadDaEscalacao`)", () => {
  it("organização em espanhol: o cliente recebe a frase em espanhol", async () => {
    const desfecho = await avisaPeloMotor(poolComIdioma("es"));
    expect(desfecho).toEqual({ avisado: true });
    expect(corpoDoMotor.valor).toBe(textoDoAviso("pediu_humano", null, LEAD, "es"));
    expect(corpoDoMotor.valor).not.toBe(textoDoAviso("pediu_humano", null, LEAD));
  });

  it("organização em português: a frase de sempre", async () => {
    await avisaPeloMotor(poolComIdioma("pt-BR"));
    expect(corpoDoMotor.valor).toBe(textoDoAviso("pediu_humano", null, LEAD));
  });

  it("leitura do idioma que falha não cancela o aviso: sai em português", async () => {
    const desfecho = await avisaPeloMotor(poolComIdioma(new Error("conexão caiu")));
    expect(desfecho).toEqual({ avisado: true });
    expect(corpoDoMotor.valor).toBe(textoDoAviso("pediu_humano", null, LEAD));
  });
});

describe("lado do CRM (`avisarLeadDoCrm`)", () => {
  // Sem atendente cadastrado (o roster de mentira é vazio): o fecho é o de
  // "sem equipe", nos dois idiomas.
  const SEM_EQUIPE = { total: 0, disponiveis: 0 };

  it("organização em espanhol: o cliente recebe a frase em espanhol", async () => {
    const desfecho = await avisaPeloCrm(adminComIdioma("es"));
    expect(desfecho).toEqual({ avisado: true });
    expect(corpoEnviadoPeloCrm()).toBe(
      textoDoAviso(motivoDoAviso("requested_human"), SEM_EQUIPE, LEAD, "es"),
    );
  });

  it("leitura do idioma que falha não cancela o aviso: sai em português", async () => {
    const desfecho = await avisaPeloCrm(adminComIdioma(new Error("PostgREST fora")));
    expect(desfecho).toEqual({ avisado: true });
    expect(enviarPeloCrm).toHaveBeenCalledTimes(1);
    expect(corpoEnviadoPeloCrm()).toBe(textoDoAviso(motivoDoAviso("requested_human"), SEM_EQUIPE, LEAD));
  });
});
