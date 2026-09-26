/**
 * O AVISO DE COMPROMISSO TRAZ O ESSENCIAL (#1612) — horário, situação, tipo,
 * local, negócios — e NÃO traz o responsável sem opt-in.
 *
 * ## Onde a sonda olha
 *
 * No EFEITO: o corpo que chega a `event_log` pelo `emit_event`, montado por
 * `payloadDoAviso` dentro de `fecharOLaco`. O teste puro de
 * `payloadDoAviso` (lib/agenda/aviso-do-compromisso.test.ts) prova a FORMA;
 * este arquivo prova que o laço de fato o usa — uma função pura certa ligada
 * no lugar errado deixa a issue aberta com o teste verde.
 *
 * ## Os três critérios de aceite, na ordem em que a issue os escreveu
 *
 * 1. `appointment.created` com início, fim, fuso, situação, tipo e local;
 * 2. marcar falta emite `appointment.no_show` — E UMA VEZ SÓ;
 * 3. o responsável não aparece no corpo (nem como `owner`, nem como
 *    `owner_user_id`): o opt-in mora na ação `call_webhook`
 *    (`lib/automation/actions/call-webhook.test.ts`), então o payload que
 *    guarda o evento já tem de nascer limpo.
 *
 * ## O dublê
 *
 * O mesmo desenho de `agenda-gatilho-leva-o-tipo-real.test.ts`: o cliente da
 * SESSÃO, que recusa INSERT em `event_log` (issue #877) — o evento só nasce
 * por `emit_event`, e é esse caminho que a sonda escuta.
 *
 * ## Comando
 *
 *     npx vitest run tests/unit/agenda-aviso-de-compromisso.test.ts
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
const { marcarAgendamentoHandler, alterarAgendamentoHandler } = await import(
  "@/app/api/v1/agenda/agendamentos/_handler"
);

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const USUARIO = "bbbbbbbb-0000-4000-8000-00000000000b";
const TIPO = "cccccccc-0000-4000-8000-00000000000c";
const CONTATO = "dddddddd-0000-4000-8000-00000000000d";
const AGENDAMENTO = "ffffffff-0000-4000-8000-00000000000f";
const LEAD = "eeeeeeee-0000-4000-8000-00000000000e";

/** No passado: o desfecho (compareceu/faltou) só cabe em compromisso iniciado. */
const HORARIO = "2026-09-02T13:00:00.000Z";
const FIM = "2026-09-02T13:30:00.000Z";
const MEET = "https://meet.example.com/sala-2";
const NOME_DO_TIPO = "Limpeza de pele";
const SLUG_DO_TIPO = "limpeza-de-pele";

type Linha = Record<string, unknown>;

interface Banco {
  tipo: Linha | null;
  contato: Linha | null;
  agendamento: Linha | null;
  criado: Linha | null;
  vinculos: Linha[];
  inserido: Record<string, Linha[]>;
  emitidos: Linha[];
}

let banco: Banco;

function dadoDaTabela(tabela: string): unknown {
  switch (tabela) {
    case "calendar_event_types":
      return banco.tipo;
    case "contacts":
      return banco.contato;
    case "calendar_appointments":
      return banco.agendamento;
    case "crm_lead_links":
      return banco.vinculos;
    // Sem negócio ABERTO para o contato: o aviso sai com os vínculos do
    // compromisso, e é deles que este arquivo quer falar.
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
    // Leitura em LISTA: ocupação da agenda (`coletaOQueOcupa`) e os vínculos
    // do compromisso pedem array. Compromisso vazio na lista — os `maybeSingle`
    // é que devolvem a linha.
    cadeia.then = (r: (v: unknown) => unknown) =>
      r(tabela === "calendar_appointments" ? { data: [], error: null } : resposta());
    return cadeia;
  };

  return {
    from: (tabela: string) => ({
      select: () => leitura(tabela),
      insert: (linha: Linha) => {
        if (tabela === "event_log") {
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
        // A escrita PERSISTE, como no Postgres: o aviso lê a linha DEPOIS da
        // gravação, e um dublê que devolve o patch sem gravá-lo mentiria sobre
        // a situação — foi exatamente o defeito que este bloco pegou.
        const patch = args.p_patch as Linha;
        banco.agendamento = { ...(banco.agendamento ?? {}), ...patch, revision: 2 };
        return { data: banco.agendamento, error: null };
      }
      if (fn === "emit_event") {
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

function gatilhos(): Linha[] {
  return banco.emitidos.filter((l) => l.p_entity_kind === ENTIDADE_DO_AGENDAMENTO);
}

function oGatilho(): { event_type: string; payload: Linha } {
  expect(
    gatilhos(),
    "o aviso não foi emitido: quem acompanha compromisso por webhook não fica sabendo de nada",
  ).toHaveLength(1);
  const linha = gatilhos()[0]!;
  return { event_type: linha.p_event_type as string, payload: linha.p_payload as Linha };
}

function coletaOk(): ResultadoDaConsulta {
  const inicio = new Date(HORARIO);
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

beforeEach(() => {
  vi.clearAllMocks();
  banco = {
    tipo: {
      id: TIPO,
      slug: SLUG_DO_TIPO,
      name: NOME_DO_TIPO,
      is_active: true,
      duration_minutes: 30,
      default_owner_user_id: USUARIO,
      requires_confirmation: false,
      location_kind: "in_person",
      location_details: "Sala 2 — Rua das Flores, 100",
    },
    contato: { id: CONTATO },
    agendamento: {
      id: AGENDAMENTO,
      event_type_id: TIPO,
      owner_user_id: USUARIO,
      contact_id: CONTATO,
      starts_at: HORARIO,
      ends_at: FIM,
      status: "confirmed",
      time_zone: "America/Sao_Paulo",
      location_kind: "in_person",
      location_details: "Sala 2 — Rua das Flores, 100",
      meeting_url: MEET,
    },
    criado: {
      id: AGENDAMENTO,
      starts_at: HORARIO,
      ends_at: FIM,
      status: "confirmed",
      time_zone: "America/Sao_Paulo",
    },
    // O compromisso JÁ está ligado a um negócio — é de lá que `lead_ids` sai.
    vinculos: [{ lead_id: LEAD }],
    inserido: {},
    emitidos: [],
  };
  vi.mocked(horariosLivresDaOrg).mockImplementation(async () => coletaOk());
});

describe("o aviso de compromisso (#1612)", () => {
  it("appointment.created traz início, fim, fuso, situação, tipo e local", async () => {
    await marcarAgendamentoHandler(cliente(), ctx, {
      event_type_id: TIPO,
      starts_at: HORARIO,
      contact_id: CONTATO,
    });

    const { event_type, payload } = oGatilho();
    expect(event_type).toBe("appointment.created");
    expect(payload).toMatchObject({
      appointment_id: AGENDAMENTO,
      contact_id: CONTATO,
      // O fuso É `time_zone` — a issue pede "fuso", e duplicar a chave criaria
      // dois nomes para o mesmo dado.
      time_zone: "America/Sao_Paulo",
      transicao: "confirmed",
      inicio: HORARIO,
      fim: FIM,
      situacao: "confirmed",
      tipo: { slug: SLUG_DO_TIPO, nome: NOME_DO_TIPO },
      local: { tipo: "in_person" },
      lead_ids: [LEAD],
    });
    // O endereço e o link estão na linha do compromisso e NÃO podem ir para o
    // event_log, que o redact de LGPD não alcança: quem os manda para fora é o
    // `call_webhook`, lendo a linha atual.
    expect(payload.local).toEqual({ tipo: "in_person" });
    expect(payload).not.toHaveProperty("meeting_url");
    expect(JSON.stringify(payload)).not.toContain("Rua das Flores");
    // O nome que as condições de regra existentes leem continua no lugar.
    expect(payload.event_type_name).toBe(NOME_DO_TIPO);
  });

  it("sem opt-in, o responsável NÃO aparece no corpo", async () => {
    await marcarAgendamentoHandler(cliente(), ctx, {
      event_type_id: TIPO,
      starts_at: HORARIO,
      contact_id: CONTATO,
    });

    const { payload } = oGatilho();
    // Nem o id cru, nem um objeto `owner`: o opt-in é da AÇÃO `call_webhook`,
    // então o evento guardado tem de nascer limpo — quem relê o event_log
    // depois não pode virar uma porta de vazamento por acidente.
    expect(payload).not.toHaveProperty("owner");
    expect(payload).not.toHaveProperty("owner_user_id");
    expect(payload).not.toHaveProperty("responsavel");
  });

  it("marcar falta emite appointment.no_show — e uma vez só", async () => {
    const cliente1 = cliente();
    await alterarAgendamentoHandler(cliente1, ctx, { id: AGENDAMENTO, status: "no_show" });

    const primeiro = oGatilho();
    expect(primeiro.event_type).toBe("appointment.no_show");
    expect(primeiro.payload.situacao).toBe("no_show");
    expect(primeiro.payload.transicao).toBe("no_show");

    // A escrita do RPC já gravou `no_show` no dublê (como o Postgres faz), então
    // esta segunda chamada é EXATAMENTE o caso do "de novo": o status não mudou,
    // não há transição, e não nasce segundo aviso.
    await alterarAgendamentoHandler(cliente(), ctx, { id: AGENDAMENTO, status: "no_show" });

    expect(
      gatilhos(),
      "o mesmo desfecho foi anunciado duas vezes: o receptor contaria a mesma falta por dois avisos",
    ).toHaveLength(1);
  });

  it("marcar comparecimento emite appointment.completed com a situação certa", async () => {
    await alterarAgendamentoHandler(cliente(), ctx, { id: AGENDAMENTO, status: "completed" });

    const { event_type, payload } = oGatilho();
    expect(event_type).toBe("appointment.completed");
    expect(payload.situacao).toBe("completed");
    // O horário continua no corpo: é o comparecimento DE um horário, não de
    // uma linha qualquer.
    expect(payload.inicio).toBe(HORARIO);
  });
});
