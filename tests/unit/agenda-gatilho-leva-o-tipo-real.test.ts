/**
 * O GATILHO DE AUTOMAÇÃO LEVA O TIPO DE ATENDIMENTO DE VERDADE — nos QUATRO.
 *
 * ## O defeito que esta cerca fecha
 *
 * O editor de regras (`app/app/webhooks/_components/RuleEditor.tsx`) oferece,
 * para os quatro gatilhos de agenda, a condição **"Tipo de atendimento contém
 * …"**, lida de `event.event_type_name` no payload do evento. É a única
 * condição por onde uma regra distingue "Limpeza de pele" de "Avaliação": a
 * linha do compromisso guarda `event_type_id`, um uuid que ninguém digita.
 *
 * Três dos quatro emissores mandavam `nomeDoTipo: "Agendamento"` CRAVADO
 * (`alterar` para confirmado e remarcado, `cancelar` para cancelado). Só
 * `marcar` mandava o nome real, porque já tinha a linha do tipo em mãos. O
 * efeito não é erro: a regra aparece na tela, o operador a salva, o horário é
 * confirmado — e nada roda, porque `"Agendamento"` não contém "Limpeza".
 * Controle decorativo é pior que controle ausente: a pessoa acredita que
 * configurou.
 *
 * ## Onde a sonda olha
 *
 * No EFEITO: o evento que chega a `event_log` pelo dublê do Supabase. Não na
 * chamada de `fecharOLaco`, não em `gatilhoDaTransicao` — a função pura já tem
 * cerca própria (`lib/agenda/laco.gatilho.test.ts`) e decidir o gatilho certo
 * não prova que o payload dele serve para alguma coisa.
 *
 * ## O dublê é o cliente da SESSÃO, e recusa o INSERT como a RLS recusa
 *
 * Issue #877. A versão anterior deste dublê ACEITAVA `insert` em `event_log`, e
 * era por isso que os quatro casos ficavam verdes com o gatilho morrendo em
 * produção: pela tela o handler recebe o cliente da sessão, `event_log` não tem
 * policy permissiva de INSERT para `authenticated`, e toda marcação e
 * confirmação registrava `new row violates row-level security policy for table
 * "event_log"` — medido na QA do lote 8. O evento só chega por `emit_event`, e
 * é esse o único caminho que o dublê deixa passar.
 *
 * ## Por que os QUATRO, e não um
 *
 * Porque as irmãs não se parecem por fora: `marcar` estava CERTO e os outros
 * três errados, e um caso feliz sobre `marcar` deixaria o arquivo verde com o
 * defeito inteiro de pé. O caso `appointment.created` está aqui como controle —
 * ele é o que prova que a sonda enxerga quando o nome chega.
 *
 * ## Comando
 *
 *     npx vitest run tests/unit/agenda-gatilho-leva-o-tipo-real.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ResultadoDaConsulta } from "@/lib/agenda/consulta";
import { ENTIDADE_DO_AGENDAMENTO } from "@/lib/agenda/tipos";
import type { HandlerCtx } from "@/lib/api/handlers/types";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));

vi.mock("@/lib/agenda/consulta", async (original) => {
  const real = await original<typeof import("@/lib/agenda/consulta")>();
  return { ...real, horariosLivresDaOrg: vi.fn() };
});

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { horariosLivresDaOrg } = await import("@/lib/agenda/consulta");
const { logger } = await import("@/lib/logger");
const { marcarAgendamentoHandler, alterarAgendamentoHandler, cancelarAgendamentoHandler } =
  await import("@/app/api/v1/agenda/agendamentos/_handler");

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const USUARIO = "bbbbbbbb-0000-4000-8000-00000000000b";
const TIPO = "cccccccc-0000-4000-8000-00000000000c";
const CONTATO = "dddddddd-0000-4000-8000-00000000000d";
const AGENDAMENTO = "ffffffff-0000-4000-8000-00000000000f";

const HORARIO = "2026-09-02T13:00:00.000Z";
const OUTRO_HORARIO = "2026-09-02T15:00:00.000Z";

/**
 * O nome precisa ser um que NENHUM literal plausível produziria por acaso — e
 * que uma condição real usaria: é assim que o estúdio separa a regra de limpeza
 * da regra de avaliação.
 */
const NOME_DO_TIPO = "Limpeza de pele";

type Linha = Record<string, unknown>;

interface Banco {
  tipo: Linha | null;
  contato: Linha | null;
  agendamento: Linha | null;
  criado: Linha | null;
  inserido: Record<string, Linha[]>;
  /** O que chegou a `event_log` pelo único caminho que a RLS deixa: `emit_event`. */
  emitidos: Linha[];
  /** Quando preenchido, `emit_event` devolve este erro — o banco recusou. */
  recusaDoEmit: { message: string } | null;
}

let banco: Banco;
let horarioOfertado: string;

function coletaOk(): ResultadoDaConsulta {
  const inicio = new Date(horarioOfertado);
  return {
    ok: true,
    slots: [{ inicio, fim: new Date(inicio.getTime() + 30 * 60_000) }],
    fusoDaRegra: "America/Sao_Paulo",
    publicouHorarios: true,
    fusoSuposto: false,
    fontesDefasadas: [],
    agendaExternaNuncaLida: false,
    googleCoberturaParcial: false,
  };
}

function dadoDaTabela(tabela: string): unknown {
  switch (tabela) {
    case "calendar_event_types":
      return banco.tipo;
    case "contacts":
      return banco.contato;
    case "calendar_appointments":
      return banco.agendamento;
    // Sem negócio aberto: o gatilho de automação NÃO depende de haver negócio, e
    // deixar a timeline fora mantém este arquivo sobre uma coisa só.
    case "crm_leads":
      return [];
    default:
      return null;
  }
}

function cliente(): SupabaseClient {
  const leitura = (tabela: string) => {
    const cadeia: Record<string, unknown> = {};
    for (const m of ["eq", "neq", "in", "is", "not", "or", "gte", "lte", "lt", "gt", "order", "limit"]) {
      cadeia[m] = () => cadeia;
    }
    const resposta = () => ({ data: dadoDaTabela(tabela), error: null });
    cadeia.maybeSingle = async () => resposta();
    cadeia.single = async () => resposta();
    // Leitura em LISTA de `calendar_appointments` é a ocupação que o encaixe de
    // uma pessoa confere (`coletaOQueOcupa`) — e lista é array, nunca a linha
    // solta que `maybeSingle` devolve. Agenda vazia: este arquivo não é sobre
    // sobreposição (essa mora em `pessoa-marca-fora-da-grade.test.ts`).
    cadeia.then = (r: (v: unknown) => unknown) =>
      r(tabela === "calendar_appointments" ? { data: [], error: null } : resposta());
    return cadeia;
  };

  return {
    from: (tabela: string) => ({
      select: () => leitura(tabela),
      insert: (linha: Linha) => {
        if (tabela === "event_log") {
          // O que o Postgres responde ao cliente da sessão: não há policy
          // permissiva de INSERT em `event_log` para `authenticated`.
          const recusa = {
            data: null,
            error: {
              code: "42501",
              message: 'new row violates row-level security policy for table "event_log"',
            },
          };
          return {
            select: () => ({ single: async () => recusa, maybeSingle: async () => recusa }),
            then: (r: (v: unknown) => unknown) => r(recusa),
          };
        }
        (banco.inserido[tabela] ??= []).push(linha);
        const resposta = { data: banco.criado ?? linha, error: null };
        return {
          select: () => ({ single: async () => resposta, maybeSingle: async () => resposta }),
          then: (r: (v: unknown) => unknown) => r(resposta),
        };
      },
      update: (patch: Linha) => {
        const cadeia: Record<string, unknown> = {};
        const resposta = () => ({ data: { ...(banco.agendamento ?? {}), ...patch }, error: null });
        for (const m of ["eq", "in"]) cadeia[m] = () => cadeia;
        cadeia.select = () => cadeia;
        cadeia.single = async () => resposta();
        cadeia.then = (r: (v: unknown) => unknown) => r(resposta());
        return cadeia;
      },
    }),
    rpc: async (fn: string, args: Linha) => {
      if (fn === "fn_appointment_change") {
        return { data: { ...banco.agendamento, ...(args.p_patch as Linha), revision: 2 }, error: null };
      }
      if (fn === "emit_event") {
        if (banco.recusaDoEmit) return { data: null, error: banco.recusaDoEmit };
        banco.emitidos.push(args);
        return { data: "evento-1", error: null };
      }
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;
}

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: USUARIO, role: "admin" },
  requestId: "req-1",
};

/** Os gatilhos de agenda que chegaram ao `event_log`. */
function gatilhos(): Linha[] {
  return banco.emitidos.filter((l) => l.p_entity_kind === ENTIDADE_DO_AGENDAMENTO);
}

/** O único gatilho da rodada — e a asserção de que houve exatamente um. */
function oGatilho(): { event_type: string; payload: Linha; organizacao: unknown } {
  expect(
    gatilhos(),
    "a transição não emitiu gatilho nenhum: o motor de regras não fica sabendo do compromisso e nenhuma automação de agenda roda — sem erro e sem log",
  ).toHaveLength(1);
  const linha = gatilhos()[0]!;
  return {
    event_type: linha.p_event_type as string,
    payload: linha.p_payload as Linha,
    organizacao: linha.p_organization_id,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  horarioOfertado = HORARIO;
  banco = {
    tipo: {
      id: TIPO,
      name: NOME_DO_TIPO,
      is_active: true,
      duration_minutes: 30,
      default_owner_user_id: USUARIO,
      requires_confirmation: false,
      location_kind: "in_person",
      location_details: null,
    },
    contato: { id: CONTATO },
    agendamento: {
      id: AGENDAMENTO,
      event_type_id: TIPO,
      owner_user_id: USUARIO,
      contact_id: CONTATO,
      starts_at: HORARIO,
      status: "confirmed",
      time_zone: "America/Sao_Paulo",
    },
    criado: {
      id: AGENDAMENTO,
      starts_at: HORARIO,
      ends_at: "2026-09-02T13:30:00.000Z",
      status: "confirmed",
      time_zone: "America/Sao_Paulo",
    },
    inserido: {},
    emitidos: [],
    recusaDoEmit: null,
  };
  vi.mocked(horariosLivresDaOrg).mockImplementation(async () => coletaOk());
});

describe("os quatro gatilhos de agenda levam o tipo de atendimento real", () => {
  it("appointment.created — o controle: aqui o nome SEMPRE chegou", async () => {
    await marcarAgendamentoHandler(cliente(), ctx, {
      event_type_id: TIPO,
      starts_at: HORARIO,
      contact_id: CONTATO,
    });

    const { event_type, payload } = oGatilho();
    expect(event_type).toBe("appointment.created");
    expect(
      payload.event_type_name,
      "nem o caminho que já estava certo leva o nome: a sonda está olhando para o lugar errado, e os outros três casos deste arquivo não valem nada",
    ).toBe(NOME_DO_TIPO);
  });

  it("appointment.confirmed — a regra de 'avise que confirmou' só serve se souber DE QUÊ", async () => {
    banco.agendamento!.status = "pending";

    await alterarAgendamentoHandler(cliente(), ctx, { id: AGENDAMENTO, status: "confirmed" });

    const { event_type, payload } = oGatilho();
    expect(event_type).toBe("appointment.confirmed");
    expect(
      payload.event_type_name,
      "a confirmação anuncia um nome genérico: a condição 'Tipo de atendimento contém …' que o editor de regras oferece nunca casa, e o operador que a configurou acha que configurou",
    ).toBe(NOME_DO_TIPO);
  });

  it("appointment.rescheduled — remarcar também diz do que é o horário", async () => {
    horarioOfertado = OUTRO_HORARIO;

    await alterarAgendamentoHandler(cliente(), ctx, { id: AGENDAMENTO, starts_at: OUTRO_HORARIO });

    const { event_type, payload } = oGatilho();
    expect(event_type).toBe("appointment.rescheduled");
    expect(
      payload.event_type_name,
      "a remarcação anuncia um nome genérico: quem quis avisar só a cliente de um tipo específico recebe uma regra que não dispara nunca",
    ).toBe(NOME_DO_TIPO);
  });

  it("appointment.cancelled — e cancelar é onde mais se quer filtrar por tipo", async () => {
    await cancelarAgendamentoHandler(cliente(), ctx, { id: AGENDAMENTO, reason: "cliente pediu" });

    const { event_type, payload } = oGatilho();
    expect(event_type).toBe("appointment.cancelled");
    expect(
      payload.event_type_name,
      "o cancelamento anuncia um nome genérico: a regra de recuperação por tipo de atendimento não roda, e o horário vago não vira nada",
    ).toBe(NOME_DO_TIPO);
  });

  it("o tipo APAGADO cai no genérico em vez de derrubar o cancelamento", async () => {
    // O par de vacuidade dos quatro acima: prova que o nome vem da LEITURA, e
    // não de um valor que o dublê devolveria de qualquer jeito. E congela a
    // decisão: perder o tipo não pode desfazer um cancelamento já gravado.
    banco.tipo = null;

    await cancelarAgendamentoHandler(cliente(), ctx, { id: AGENDAMENTO, reason: "cliente pediu" });

    expect(oGatilho().payload.event_type_name).toBe("Agendamento");
    expect(
      banco.emitidos,
      "o cancelamento caiu junto com a leitura do tipo: um compromisso fica sem desmarcar porque uma linha de catálogo sumiu",
    ).not.toHaveLength(0);
  });
});

/**
 * Issue #877 — o gatilho atravessa a RLS pela tela.
 *
 * Os casos acima já rodam com o cliente da sessão recusando o INSERT; estes
 * dois dizem, cada um, a metade da propriedade que eles não nomeiam.
 */
describe("pela tela, o gatilho chega apesar da RLS de event_log", () => {
  it("confirmar pela tela emite pelo emit_event, com a organização do CONTEXTO", async () => {
    banco.agendamento!.status = "pending";

    await alterarAgendamentoHandler(cliente(), ctx, { id: AGENDAMENTO, status: "confirmed" });

    const { event_type, organizacao } = oGatilho();
    expect(event_type).toBe("appointment.confirmed");
    expect(
      organizacao,
      "o evento saiu sem a organização do contexto autenticado: emit_event cairia na primeira organização do usuário, ou em nenhuma",
    ).toBe(ORG);
  });

  it("emit_event recusado não desfaz a marcação — e deixa rastro no log", async () => {
    banco.recusaDoEmit = { message: "caller_not_authorized_for_org" };

    const criado = await marcarAgendamentoHandler(cliente(), ctx, {
      event_type_id: TIPO,
      starts_at: HORARIO,
      contact_id: CONTATO,
    });

    expect(criado, "falhar em emitir derrubou um compromisso já gravado").toBeTruthy();
    expect(logger.error).toHaveBeenCalledWith(
      "[agenda] gatilho de automação não foi emitido",
      expect.objectContaining({ error: "caller_not_authorized_for_org", organization_id: ORG }),
    );
  });
});
