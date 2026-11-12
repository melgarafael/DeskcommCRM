// @vitest-environment node
/**
 * A ligação perdida como GATILHO de automação (#4365).
 *
 * O cliente pediu: quem ligou e não foi atendido recebe uma mensagem no
 * WhatsApp em até um minuto — e as réguas de envio que já existem NÃO podem ser
 * furadas por causa do gatilho novo.
 *
 * Dois blocos:
 *
 *   1. CATÁLOGO — o gatilho `voice_call.missed` está na fonte única
 *      (`ENTIDADE_ESPERADA_POR_GATILHO`), chega ao handler do motor (que assina
 *      exatamente essa lista), passa no schema da regra e diz que a entidade é
 *      o CONTATO (é ele que a ação de WhatsApp precisa no contexto).
 *   2. MOTOR — o evento real que o worker de voz publica dispara a regra UMA
 *      vez pelo executor de verdade (`send_whatsapp_message`), e os controles
 *      provam que o caminho novo não abre porta: contato BLOQUEADO, contato
 *      PESSOAL e JANELA FECHADA continuam barrando o envio.
 *
 * Só o TRANSPORTE é dublado (`sendMessageHandler`) e a leitura de fronteira do
 * atendimento: o que se mede é a decisão de enviar, que é onde moram as regras.
 *
 * SABOTAGEM: tirar `"voice_call.missed": "contact"` de
 * `ENTIDADE_ESPERADA_POR_GATILHO` deixa o bloco 1 vermelho (e o handler para de
 * assinar o evento); o bloco 2 continua provando o resto.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Linha = Record<string, unknown>;

const enviados = vi.hoisted(() => [] as Linha[]);

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/automation/throttle", async () => {
  const real = await vi.importActual<typeof import("@/lib/automation/throttle")>(
    "@/lib/automation/throttle",
  );
  return {
    ...real,
    checkDailyLimit: async () => ({ allowed: true }),
    espacarEnvio: async () => undefined,
  };
});
vi.mock("@/lib/atendimento/origem-automacao", () => ({
  serviceForAutomation: async () => ({ conversation_id: "conversa-da-ligacao" }),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: async (_admin: unknown, _req: unknown, payload: Linha) => {
    enviados.push(payload);
    return { id: `msg-${enviados.length}`, status: "sent" };
  },
}));

import "@/lib/automation/actions/register-all";
import { getAction } from "@/lib/automation/actions";
import { runAutomationForEvent } from "@/lib/automation/engine";
import { automationRulesHandler } from "@/lib/automation/engine.handler";
import type { EventRow } from "@/lib/event-log/dispatcher";
import {
  ENTIDADE_ESPERADA_POR_GATILHO,
  TRIGGER_EVENTS,
  createAutomationRuleSchema,
} from "@/lib/schemas/webhooks";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CANAL = "33333333-3333-4333-8333-333333333333";
const REGRA = "77777777-7777-4777-8777-7777777777a1";
const CONVERSA = "conversa-da-ligacao";

type Filtro = { coluna: string; op: "eq" | "in" | "gt" | "gte"; valor: unknown };

function casa(linha: Linha, filtro: Filtro): boolean {
  const valor = linha[filtro.coluna];
  if (filtro.op === "eq") return valor === filtro.valor;
  if (filtro.op === "in") return (filtro.valor as unknown[]).includes(valor);
  return typeof valor === "string" && typeof filtro.valor === "string" && valor >= filtro.valor;
}

/** Dublê mínimo do PostgREST: o recorte que o motor e a ação usam. */
function bancoFalso(tabelas: Record<string, Linha[]>) {
  function consulta(tabela: string) {
    const filtros: Filtro[] = [];
    let limite: number | null = null;
    let inserindo: Linha | null = null;
    let atualizando: Linha | null = null;
    let chaveUnica: string[] | null = null;
    let ignorarDuplicada = false;
    const guardadas = () => (tabelas[tabela] ??= []);
    const casadas = () => guardadas().filter((l) => filtros.every((f) => casa(l, f)));
    async function executar() {
      if (inserindo) {
        const jaExiste =
          chaveUnica !== null && guardadas().some((l) => chaveUnica!.every((c) => l[c] === inserindo![c]));
        if (jaExiste && ignorarDuplicada) return { data: [], error: null };
        const linha = { id: `run-${guardadas().length + 1}`, created_at: new Date().toISOString(), ...inserindo };
        guardadas().push(linha);
        return { data: [linha], error: null };
      }
      if (atualizando) {
        for (const linha of casadas()) Object.assign(linha, atualizando);
        return { data: casadas(), error: null };
      }
      const linhas = casadas();
      return { data: limite === null ? linhas : linhas.slice(0, limite), error: null };
    }
    const q = {
      select: () => q,
      insert: (linha: Linha, opcoes?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
        inserindo = linha;
        chaveUnica = opcoes?.onConflict ? opcoes.onConflict.split(",").map((c) => c.trim()) : null;
        ignorarDuplicada = opcoes?.ignoreDuplicates === true;
        return q;
      },
      upsert: (linha: Linha, opcoes?: { onConflict?: string; ignoreDuplicates?: boolean }) =>
        q.insert(linha, { ignoreDuplicates: true, ...opcoes }),
      update: (linha: Linha) => {
        atualizando = linha;
        return q;
      },
      order: () => q,
      limit: (n: number) => {
        limite = n;
        return q;
      },
      eq: (c: string, v: unknown) => {
        filtros.push({ coluna: c, op: "eq", valor: v });
        return q;
      },
      in: (c: string, v: unknown[]) => {
        filtros.push({ coluna: c, op: "in", valor: v });
        return q;
      },
      gt: (c: string, v: unknown) => {
        filtros.push({ coluna: c, op: "gt", valor: v });
        return q;
      },
      gte: (c: string, v: unknown) => {
        filtros.push({ coluna: c, op: "gte", valor: v });
        return q;
      },
      maybeSingle: async () => {
        const r = await executar();
        const linhas = (r.data ?? []) as Linha[];
        return { data: linhas[0] ?? null, error: null };
      },
      single: async () => {
        const r = await executar();
        const linhas = (r.data ?? []) as Linha[];
        return { data: linhas[0] ?? null, error: null };
      },
      then: (ok: (r: { data: Linha[]; error: null }) => unknown) => executar().then(ok),
    };
    return q;
  }
  return { cliente: { from: consulta } as unknown as SupabaseClient, tabelas };
}

function contato(extra: Linha = {}): Linha {
  return {
    id: CONTATO,
    organization_id: ORG,
    name: "Maria da Silva",
    phone_number: "+5527992759009",
    is_blocked: false,
    is_personal: false,
    ...extra,
  };
}

function regra(extra: Linha = {}): Linha {
  return {
    id: REGRA,
    organization_id: ORG,
    trigger_event: "voice_call.missed",
    is_active: true,
    name: "Aviso de ligação perdida",
    conditions: [],
    actions: [
      {
        type: "send_whatsapp_message",
        config: { channel_session_id: CANAL, template: "Oi {{contact.name}}, vi que você ligou. Como posso ajudar?" },
      },
    ],
    trigger_config: {},
    ...extra,
  };
}

function mundo(opcoes: { contato?: Linha; knobs?: Linha | null; regra?: Linha } = {}) {
  return bancoFalso({
    organizations: [{ id: ORG, locale: "pt-BR", timezone: "America/Sao_Paulo" }],
    contacts: [opcoes.contato ?? contato()],
    automation_rules: [opcoes.regra ?? regra()],
    automation_rule_runs: [],
    crm_leads: [],
    conversations: [{ id: CONVERSA, organization_id: ORG, contact_id: CONTATO, channel_session_id: CANAL }],
    calendar_appointments: [],
    channel_sessions: [{ id: CANAL, organization_id: ORG, daily_message_limit: 300 }],
    channel_session_warmup: [],
    channel_knobs: opcoes.knobs === null ? [] : [opcoes.knobs ?? {
      organization_id: ORG,
      channel_session_id: CANAL,
      window_start_hour: 7,
      window_end_hour: 22,
      allow_sunday: true,
      timezone: "America/Sao_Paulo",
    }],
    pending_messages: [],
  });
}

let evento = 0;
/** O evento EXATO que o worker de voz publica depois desta entrega. */
function ligacaoPerdida(contactId: string = CONTATO): EventRow {
  evento += 1;
  return {
    id: `00000000-0000-4000-8000-00000000000${evento}`,
    organization_id: ORG,
    event_type: "voice_call.missed",
    entity_kind: "contact",
    entity_id: contactId,
    payload: { contact_id: contactId, call_id: "chamada-1", peer_phone: "+5527992759009" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

beforeEach(() => {
  enviados.length = 0;
  evento = 0;
  // Relógio fixo DENTRO da janela 7h–22h do número (15:00Z = 12:00 em São
  // Paulo). Com o relógio real, o CI que roda de madrugada caía em
  // "fora_da_janela_de_envio" e os casos do motor viravam "retry"/"postponed"
  // (medido em 12/11/2026, 01h BRT, nos PRs #4404 e #4420). O caso que quer a
  // janela FECHADA continua fixando o próprio horário.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T15:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("catálogo: 'Ligação perdida' é um gatilho de primeira classe", () => {
  it("está na fonte única, com a entidade CONTATO", () => {
    expect(TRIGGER_EVENTS).toContain("voice_call.missed");
    expect(ENTIDADE_ESPERADA_POR_GATILHO["voice_call.missed"]).toBe("contact");
  });

  it("o handler do motor assina o evento (sem isso a regra salva e nada roda)", () => {
    expect(automationRulesHandler.events).toContain("voice_call.missed");
  });

  it("o schema da regra aceita o gatilho com a ação que já existe", () => {
    const resultado = createAutomationRuleSchema.safeParse({
      name: "Ligação perdida → WhatsApp",
      trigger_event: "voice_call.missed",
      conditions: [],
      actions: [
        {
          type: "send_whatsapp_message",
          config: { channel_session_id: CANAL, template: "Oi! Vi que você ligou." },
        },
      ],
    });
    expect(resultado.success, JSON.stringify(resultado.error?.issues)).toBe(true);
  });
});

describe("motor: a ligação perdida manda UMA mensagem pelo caminho de sempre", () => {
  it("dispara a regra e envia uma vez, com o contato no contexto", async () => {
    // RELÓGIO PRESO DENTRO DA JANELA (#4365). O motor adia pela janela do
    // NÚMERO (7h–22h em São Paulo), e este caso rodava com o relógio de
    // verdade: às 23h o disparo saía `retry` — decidir esperar está CORRETO —,
    // e o teste reprovava por causa da HORA em que a CI rodou, não do produto.
    // 15:00Z = 12:00 em São Paulo, meio da janela.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T15:00:00Z"));
    const { cliente } = mundo();

    const resultado = await runAutomationForEvent(cliente, ligacaoPerdida());

    expect(resultado.status).toBe("ok");
    expect(enviados).toHaveLength(1);
    expect(enviados[0]).toMatchObject({
      conversation_id: CONVERSA,
      type: "text",
      body: "Oi Maria da Silva, vi que você ligou. Como posso ajudar?",
    });
  });

  it("CONTROLE: contato BLOQUEADO continua barrando o envio", async () => {
    // O CONTROLE VALE MAIS FORA DA JANELA (#4365): é aí que o adiamento aparece
    // e engolia o bloqueio. 08:00Z = 05:00 em São Paulo — janela fechada. O
    // contato bloqueado tem de sair `skipped/contact_blocked` mesmo assim: não
    // há envio possível para esperar a janela abrir.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T08:00:00Z"));
    const { cliente, tabelas } = mundo({ contato: contato({ is_blocked: true }) });

    await runAutomationForEvent(cliente, ligacaoPerdida());

    expect(enviados).toHaveLength(0);
    const run = (tabelas.automation_rule_runs ?? [])[0];
    expect((run?.actions_result as Linha[] | undefined)?.[0]).toMatchObject({
      type: "send_whatsapp_message",
      status: "skipped",
      detail: { reason: "contact_blocked" },
    });
  });

  it("CONTROLE: contato PESSOAL continua sem rodar regra nenhuma", async () => {
    const { cliente, tabelas } = mundo({ contato: contato({ is_personal: true }) });

    const resultado = await runAutomationForEvent(cliente, ligacaoPerdida());

    expect(resultado).toMatchObject({ status: "skipped", detail: "contato_pessoal" });
    expect(enviados).toHaveLength(0);
    expect(tabelas.automation_rule_runs ?? []).toHaveLength(0);
  });

  it("CONTROLE: janela do canal FECHADA adia o evento e não envia", async () => {
    // 08:00Z = 05:00 em São Paulo — fora da janela 7h–22h do número.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T08:00:00Z"));
    const { cliente, tabelas } = mundo();

    await runAutomationForEvent(cliente, ligacaoPerdida());

    expect(enviados).toHaveLength(0);
    const run = (tabelas.automation_rule_runs ?? [])[0];
    expect(run?.status).toBe("adiado");
    expect((run?.actions_result as Linha[] | undefined)?.[0]).toMatchObject({
      status: "postponed",
      detail: { reason: "fora_da_janela_de_envio" },
    });
  });
});

describe("o executor usado é o de sempre", () => {
  it("send_whatsapp_message é a ação registrada para o gatilho novo", () => {
    expect(getAction("send_whatsapp_message")).toBeTruthy();
  });
});
