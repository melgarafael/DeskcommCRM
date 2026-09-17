/**
 * Quem pode marcar FORA da grade de horários — e o que ninguém pode.
 *
 * A grade (início da jornada + múltiplos da duração) é o que o sistema OFERECE.
 * Uma pessoa da equipe precisa marcar o que combinou por fora dela: o cliente
 * que só pode 10:30, o encaixe, o atendimento que começa mais cedo. A IA não —
 * ela oferece o que a agenda publicou, e escolher horário que ninguém publicou é
 * decisão de quem responde pelo negócio. Integração por token também não.
 *
 * O encaixe dispensa as regras da GRADE (expediente, exceção de data, buffer,
 * aviso mínimo, janela de reserva). NÃO dispensa a OCUPAÇÃO REAL: outro
 * agendamento que ocupa o horário e evento do Google Agenda selecionado.
 *
 * ## Por que os casos passam pelo HANDLER, e não pelas funções
 *
 * A primeira versão deste arquivo testava `podeMarcarForaDaGrade` e a consulta
 * de sobreposição isoladas, conferindo a FORMA da query num dublê. Medido: com
 * `const foraDaGrade = true` no handler — a IA marcando fora da grade —, os 58
 * arquivos de agenda ficaram verdes. E a forma conferida era a de uma consulta
 * que olhava só `calendar_appointments`: o encaixe marcava em cima do Google, e
 * nada aqui podia ver.
 *
 * Então os casos chamam `marcarAgendamentoHandler` e `alterarAgendamentoHandler`
 * de verdade, com a coleta de verdade (`horariosLivresDaOrg`, `coletaOQueOcupa`,
 * o motor de horários livres). O que é de mentira é só o transporte: um banco em
 * memória que APLICA os filtros (`eq`, `neq`, `lt`, `gt`, `gte`, `lte`) — um
 * dublê que os ignorasse deixaria "outro responsável" e "o próprio compromisso"
 * barrarem por acidente, ou não barrarem por acidente. Método que o dublê não
 * conhece estoura, em vez de devolver vazio.
 *
 * ## A metade GRADE da coleta única
 *
 * A grade (IA) e o encaixe (pessoa) leem a mesma `coletaOQueOcupa`, mas por
 * caminhos diferentes: o encaixe a chama direto; a grade a recebe dentro de
 * `horariosLivresDaOrg` e a entrega ao motor. Os casos do encaixe não enxergam o
 * caminho da grade — medido pelo revisor do lote 8: com `ocupados: []` na
 * chamada do motor, ou sem o filtro de dono do Google na coleta, a suíte seguia
 * verde. Por isso a IA também é conferida aqui, NA grade, contra o que ocupa.
 *
 * ## Comando
 *
 *     npx vitest run tests/unit/pessoa-marca-fora-da-grade.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor, HandlerCtx } from "@/lib/api/handlers/types";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));

const { alterarAgendamentoHandler, marcarAgendamentoHandler, podeMarcarForaDaGrade } = await import(
  "@/app/api/v1/agenda/agendamentos/_handler"
);

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const DONO = "bbbbbbbb-0000-4000-8000-00000000000b";
const OUTRO_DONO = "bbbbbbbb-0000-4000-8000-0000000000bb";
const TIPO = "cccccccc-0000-4000-8000-00000000000c";
const CONEXAO = "eeeeeeee-0000-4000-8000-00000000000e";
const MEU_COMPROMISSO = "ffffffff-0000-4000-8000-00000000000f";

const PESSOA: Actor = { type: "user", id: DONO, role: "admin" };
const AGENTE: Actor = { type: "ai_agent", id: "run-1", role: "agent" };
const TOKEN: Actor = { type: "api_token", id: "tok-1", role: "admin" };
const WEBHOOK: Actor = { type: "webhook_source", id: "src-1" };

/**
 * Segunda, 05/10/2026, 09:00 em São Paulo. O relógio é fixo porque a grade
 * desconta aviso mínimo e janela de reserva a partir de AGORA — com o relógio
 * real, o arquivo mudaria de resposta sozinho com o passar dos dias.
 */
const AGORA = new Date("2026-10-05T12:00:00.000Z");

// Quarta, 07/10/2026 (dow 3). São Paulo é UTC-3: 10:00 local = 13:00Z.
const NA_GRADE = "2026-10-07T13:00:00.000Z"; // 10:00 — a grade é de hora em hora
const FORA_DA_GRADE = "2026-10-07T13:30:00.000Z"; // 10:30 — o encaixe
const FIM_DO_ENCAIXE = "2026-10-07T14:30:00.000Z";

type Linha = Record<string, unknown>;

function lerCampo(linha: Linha, coluna: string): unknown {
  // `calendar_connections.user_id` filtra pelo embed, como o PostgREST faz.
  return coluna.split(".").reduce<unknown>((valor, chave) => (valor as Linha | null)?.[chave], linha);
}

function instante(valor: unknown): number {
  return new Date(String(valor)).getTime();
}

interface Banco {
  tabelas: Record<string, Linha[]>;
  client: SupabaseClient;
}

/**
 * O que a SESSÃO de quem pergunta enxerga.
 *
 * `"tudo"` é o dono ou um `manager`. `"atendente"` é um `agent` olhando a agenda
 * de OUTRA pessoa: a RLS de `calendar_connections` esconde a conexão, e com ela
 * some a linha do evento que chega por `calendar_connections!inner` (medido no
 * Postgres: dono 1, gerente 1, atendente 0 — issue #879). As RPCs
 * `fn_agenda_*_google_do_dono` são `security definer` e respondem igual para os
 * dois olhares; quem prova isso no banco de verdade é
 * `tests/invariants/agenda-ocupacao-google-do-dono.test.ts`.
 */
type Olhar = "tudo" | "atendente";
const ESCONDIDAS_DO_ATENDENTE = new Set(["calendar_connections", "calendar_selected_external_events"]);

function bancoEmMemoria(tabelas: Record<string, Linha[]>, olhar: Olhar = "tudo"): Banco {
  const leitura = (tabela: string) => {
    const filtros: Array<(linha: Linha) => boolean> = [];
    const visiveis = () => (olhar === "atendente" && ESCONDIDAS_DO_ATENDENTE.has(tabela) ? [] : (tabelas[tabela] ?? []));
    const linhas = () => visiveis().filter((linha) => filtros.every((f) => f(linha)));
    const cadeia = {
      eq: (c: string, v: unknown) => (filtros.push((l) => lerCampo(l, c) === v), cadeia),
      neq: (c: string, v: unknown) => (filtros.push((l) => lerCampo(l, c) !== v), cadeia),
      lt: (c: string, v: unknown) => (filtros.push((l) => instante(lerCampo(l, c)) < instante(v)), cadeia),
      gt: (c: string, v: unknown) => (filtros.push((l) => instante(lerCampo(l, c)) > instante(v)), cadeia),
      gte: (c: string, v: unknown) => (filtros.push((l) => instante(lerCampo(l, c)) >= instante(v)), cadeia),
      lte: (c: string, v: unknown) => (filtros.push((l) => instante(lerCampo(l, c)) <= instante(v)), cadeia),
      maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
        Promise.resolve({ data: linhas(), error: null }).then(ok, falha),
    };
    return cadeia;
  };

  const client = {
    from: (tabela: string) => ({
      select: () => leitura(tabela),
      insert: (linha: Linha) => {
        const gravada = { id: `novo-${(tabelas[tabela] ?? []).length + 1}`, ...linha };
        (tabelas[tabela] ??= []).push(gravada);
        const resposta = { data: gravada, error: null };
        return {
          select: () => ({ single: async () => resposta }),
          then: (ok: (v: unknown) => unknown) => Promise.resolve(resposta).then(ok),
        };
      },
    }),
    rpc: async (fn: string, args: Linha) => {
      if (fn === "fn_google_coverage") return { data: false, error: null };
      // As duas da migration 0260 leem a tabela INTEIRA — independem do olhar —
      // e aplicam o que o corpo SQL aplica: organização, dono e cruzamento estrito.
      if (fn === "fn_agenda_ocupacao_google_do_dono") {
        const ocupam = (tabelas.calendar_selected_external_events ?? []).filter((l) => {
          const conexao = l.calendar_connections as Linha;
          return (
            l.organization_id === args.p_org &&
            conexao.user_id === args.p_owner &&
            instante(l.starts_at) < instante(args.p_ate) &&
            instante(l.ends_at) > instante(args.p_de)
          );
        });
        return {
          data: ocupam.map((l) => ({
            starts_at: l.starts_at,
            ends_at: l.ends_at,
            transparency: l.transparency,
            status: l.status,
            connection_status: (l.calendar_connections as Linha).status,
          })),
          error: null,
        };
      }
      if (fn === "fn_agenda_conexoes_google_do_dono") {
        const doDono = (tabelas.calendar_connections ?? []).filter(
          (l) => l.organization_id === args.p_org && l.user_id === args.p_owner,
        );
        return { data: doDono.map((l) => ({ status: l.status, last_sync_at: l.last_sync_at })), error: null };
      }
      if (fn === "fn_appointment_change") {
        const linha = (tabelas.calendar_appointments ?? []).find((l) => l.id === args.p_id);
        if (!linha) return { data: null, error: { code: "P0002", message: "não achou" } };
        Object.assign(linha, args.p_patch as Linha, { revision: Number(linha.revision) + 1 });
        return { data: { ...linha }, error: null };
      }
      // O gatilho de automação da Agenda sai por aqui (issue #877). Este arquivo
      // não é sobre ele — quem o vigia é `agenda-gatilho-leva-o-tipo-real`.
      if (fn === "emit_event") return { data: null, error: null };
      throw new Error(`[dublê] rpc não prevista: ${fn}`);
    },
  } as unknown as SupabaseClient;

  return { tabelas, client };
}

/** Um compromisso do CRM na agenda — por padrão do mesmo dono, confirmado. */
function agendamento(inicio: string, fim: string, extra: Linha = {}): Linha {
  return {
    id: `ag-${inicio}-${String(extra.status ?? "confirmed")}-${String(extra.owner_user_id ?? DONO)}`,
    organization_id: ORG,
    event_type_id: TIPO,
    owner_user_id: DONO,
    contact_id: null,
    starts_at: inicio,
    ends_at: fim,
    status: "confirmed",
    time_zone: "America/Sao_Paulo",
    revision: 1,
    ...extra,
  };
}

/** Uma linha de `calendar_selected_external_events`, com o embed da conexão — por padrão do mesmo dono. */
function eventoDoGoogle(inicio: string, fim: string, dono: string = DONO): Linha {
  return {
    organization_id: ORG,
    connection_id: CONEXAO,
    starts_at: inicio,
    ends_at: fim,
    transparency: "opaque",
    status: "confirmed",
    calendar_connections: { user_id: dono, status: "healthy" },
  };
}

function agenda(
  args: {
    agendamentos?: Linha[];
    eventosDoGoogle?: Linha[];
    olhar?: Olhar;
    /** Fim da jornada de quarta. Padrão 18:00; a noite em fuso negativo pede mais. */
    fimDaJornada?: string;
    /** Dias (`YYYY-MM-DD`, local) bloqueados por inteiro. */
    diasBloqueados?: string[];
  } = {},
): Banco {
  return bancoEmMemoria({
    calendar_event_types: [
      {
        id: TIPO,
        organization_id: ORG,
        name: "Avaliação",
        is_active: true,
        duration_minutes: 60,
        buffer_before_minutes: 0,
        buffer_after_minutes: 0,
        minimum_notice_minutes: 120,
        slot_interval_minutes: null,
        booking_window_days: 30,
        default_owner_user_id: DONO,
        requires_confirmation: false,
        location_kind: "in_person",
        location_details: null,
      },
    ],
    attendant_availability: [
      {
        organization_id: ORG,
        user_id: DONO,
        schedule: {
          timezone: "America/Sao_Paulo",
          windows: [{ dow: 3, start: "09:00", end: args.fimDaJornada ?? "18:00" }],
        },
      },
    ],
    calendar_availability_exceptions: (args.diasBloqueados ?? []).map((dia) => ({
      organization_id: ORG,
      user_id: DONO,
      exception_date: dia,
      is_unavailable: true,
      // Dia inteiro é 0…1440 (`ExcecaoDeData`); `null` aqui viraria NaN no motor.
      start_minute: 0,
      end_minute: 1440,
    })),
    calendar_connections: [
      { organization_id: ORG, user_id: DONO, status: "healthy", last_sync_at: AGORA.toISOString() },
    ],
    calendar_appointments: args.agendamentos ?? [],
    calendar_selected_external_events: args.eventosDoGoogle ?? [],
  }, args.olhar);
}

function ctx(actor: Actor): HandlerCtx {
  return { organization_id: ORG, actor, requestId: "req-1" };
}

const RECUSA = { status: 422, code: "agenda_horario_indisponivel" };

/** Os compromissos que o handler CRIOU nesta rodada (os semeados têm id `ag-…`). */
function criados(banco: Banco): Linha[] {
  return (banco.tabelas.calendar_appointments ?? []).filter((l) => String(l.id).startsWith("novo-"));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AGORA);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("quem marca fora da grade", () => {
  it("uma PESSOA pode — é o encaixe que ela combinou com a cliente", () => {
    expect(podeMarcarForaDaGrade(PESSOA)).toBe(true);
  });

  it("a IA, o token de servidor e o webhook NÃO podem", () => {
    expect(podeMarcarForaDaGrade(AGENTE)).toBe(false);
    expect(podeMarcarForaDaGrade(TOKEN)).toBe(false);
    expect(podeMarcarForaDaGrade(WEBHOOK)).toBe(false);
  });
});

describe("marcar — a regra no ponto de uso", () => {
  it("CONTROLE: a IA marca NA grade quando a agenda está livre", async () => {
    // Sem este caso, a recusa do próximo poderia vir de jornada mal lida, fuso
    // errado ou dublê quebrado — e pareceria a regra funcionando.
    const banco = agenda();
    await marcarAgendamentoHandler(banco.client, ctx(AGENTE), { event_type_id: TIPO, starts_at: NA_GRADE });
    expect(criados(banco), "a IA não conseguiu marcar nem o horário que a grade oferece").toHaveLength(1);
  });

  it("a IA fora da grade é RECUSADA — mesmo com a agenda livre", async () => {
    const banco = agenda();
    await expect(
      marcarAgendamentoHandler(banco.client, ctx(AGENTE), { event_type_id: TIPO, starts_at: FORA_DA_GRADE }),
    ).rejects.toMatchObject(RECUSA);
    expect(criados(banco), "a IA marcou num horário que a agenda nunca ofereceu").toHaveLength(0);
  });

  it("o token de servidor fora da grade é RECUSADO — integração não escolhe encaixe", async () => {
    const banco = agenda();
    await expect(
      marcarAgendamentoHandler(banco.client, ctx(TOKEN), { event_type_id: TIPO, starts_at: FORA_DA_GRADE }),
    ).rejects.toMatchObject(RECUSA);
    expect(criados(banco)).toHaveLength(0);
  });

  it("a pessoa fora da grade, em horário livre, MARCA", async () => {
    const banco = agenda();
    await marcarAgendamentoHandler(banco.client, ctx(PESSOA), { event_type_id: TIPO, starts_at: FORA_DA_GRADE });
    expect(criados(banco), "a pessoa não conseguiu marcar o encaixe").toHaveLength(1);
    expect(criados(banco)[0]).toMatchObject({ starts_at: FORA_DA_GRADE, ends_at: FIM_DO_ENCAIXE });
  });

  it("a pessoa marca até FORA DO EXPEDIENTE — o encaixe dispensa as regras da grade", async () => {
    // Quarta 20:00 em São Paulo; a jornada termina às 18:00.
    const banco = agenda();
    await marcarAgendamentoHandler(banco.client, ctx(PESSOA), {
      event_type_id: TIPO,
      starts_at: "2026-10-07T23:00:00.000Z",
    });
    expect(criados(banco), "o encaixe ainda respeita o expediente — a pessoa não consegue marcar depois do horário").toHaveLength(1);
  });

  it("o que NÃO ocupa não barra o encaixe: encostado, cancelado, falta, outro responsável", async () => {
    const banco = agenda({
      agendamentos: [
        // Termina exatamente quando o encaixe começa: encostar não é cruzar.
        agendamento("2026-10-07T12:30:00.000Z", FORA_DA_GRADE),
        agendamento(FORA_DA_GRADE, FIM_DO_ENCAIXE, { status: "cancelled" }),
        agendamento(FORA_DA_GRADE, FIM_DO_ENCAIXE, { status: "no_show" }),
        agendamento(FORA_DA_GRADE, FIM_DO_ENCAIXE, { owner_user_id: OUTRO_DONO }),
      ],
    });
    await marcarAgendamentoHandler(banco.client, ctx(PESSOA), { event_type_id: TIPO, starts_at: FORA_DA_GRADE });
    expect(
      criados(banco),
      "o encaixe foi recusado por algo que não ocupa o horário — cancelado/falta liberam, e a agenda de outra pessoa não é a deste dono",
    ).toHaveLength(1);
  });

  it("a pessoa fora da grade em cima de OUTRO AGENDAMENTO é RECUSADA", async () => {
    const banco = agenda({ agendamentos: [agendamento(NA_GRADE, "2026-10-07T14:00:00.000Z")] });
    await expect(
      marcarAgendamentoHandler(banco.client, ctx(PESSOA), { event_type_id: TIPO, starts_at: FORA_DA_GRADE }),
    ).rejects.toMatchObject(RECUSA);
    expect(criados(banco), "duas pessoas na mesma cadeira: o encaixe passou por cima de um compromisso").toHaveLength(0);
  });

  it("a pessoa fora da grade em cima de um evento do GOOGLE AGENDA é RECUSADA", async () => {
    // O defeito que este arquivo existe para fechar: a grade escondia este
    // horário (ela lê o Google), e o encaixe marcava nele (lia só o CRM).
    const banco = agenda({ eventosDoGoogle: [eventoDoGoogle(NA_GRADE, "2026-10-07T14:00:00.000Z")] });
    await expect(
      marcarAgendamentoHandler(banco.client, ctx(PESSOA), { event_type_id: TIPO, starts_at: FORA_DA_GRADE }),
    ).rejects.toMatchObject(RECUSA);
    expect(
      criados(banco),
      "o encaixe marcou em cima de um compromisso do Google Agenda que a grade estava escondendo",
    ).toHaveLength(0);
  });
});

describe("a grade (IA) — a mesma coleta que o encaixe lê", () => {
  // Todos NA grade e dentro do expediente: a única razão para recusar é o que
  // ocupa. O CONTROLE de "marcar — a regra no ponto de uso" prova que, com a
  // agenda livre, este mesmo pedido passa.

  it("a IA NA grade em cima de um evento do GOOGLE do mesmo responsável é RECUSADA", async () => {
    const banco = agenda({ eventosDoGoogle: [eventoDoGoogle(NA_GRADE, "2026-10-07T14:00:00.000Z")] });
    await expect(
      marcarAgendamentoHandler(banco.client, ctx(AGENTE), { event_type_id: TIPO, starts_at: NA_GRADE }),
    ).rejects.toMatchObject(RECUSA);
    expect(
      criados(banco),
      "a IA marcou em cima do Google Agenda do responsável — a grade não recebeu o que a coleta trouxe",
    ).toHaveLength(0);
  });

  it("a IA NA grade com evento do Google de OUTRO responsável MARCA — a agenda dele não é a deste dono", async () => {
    const banco = agenda({
      eventosDoGoogle: [eventoDoGoogle(NA_GRADE, "2026-10-07T14:00:00.000Z", OUTRO_DONO)],
    });
    await marcarAgendamentoHandler(banco.client, ctx(AGENTE), { event_type_id: TIPO, starts_at: NA_GRADE });
    expect(
      criados(banco),
      "o Google de outra pessoa ocupou a agenda deste responsável — a coleta perdeu o filtro de dono",
    ).toHaveLength(1);
  });

  it("a IA NA grade em cima de OUTRO AGENDAMENTO é RECUSADA", async () => {
    const banco = agenda({ agendamentos: [agendamento(NA_GRADE, "2026-10-07T14:00:00.000Z")] });
    await expect(
      marcarAgendamentoHandler(banco.client, ctx(AGENTE), { event_type_id: TIPO, starts_at: NA_GRADE }),
    ).rejects.toMatchObject(RECUSA);
    expect(criados(banco), "a IA marcou em cima de um compromisso que já existe").toHaveLength(0);
  });
});

describe("o Google do DONO vale para quem não enxerga a conexão dele (issue #879)", () => {
  // Um `agent` marcando na agenda de outra pessoa: a sessão dele não vê a
  // conexão do Google do dono. A ocupação é da AGENDA, não do olhar — pelos dois
  // caminhos que leem `coletaOQueOcupa`.
  const ATENDENTE: Actor = { type: "user", id: "bbbbbbbb-0000-4000-8000-0000000000a7", role: "agent" };

  it("CONTROLE: com o olhar do atendente e sem Google, o encaixe MARCA — o olhar sozinho não barra", async () => {
    const banco = agenda({ olhar: "atendente" });
    await marcarAgendamentoHandler(banco.client, ctx(ATENDENTE), { event_type_id: TIPO, starts_at: FORA_DA_GRADE });
    expect(criados(banco)).toHaveLength(1);
  });

  it("o ENCAIXE do atendente em cima do Google do dono é RECUSADO", async () => {
    const banco = agenda({
      olhar: "atendente",
      eventosDoGoogle: [eventoDoGoogle(NA_GRADE, "2026-10-07T14:00:00.000Z")],
    });
    await expect(
      marcarAgendamentoHandler(banco.client, ctx(ATENDENTE), { event_type_id: TIPO, starts_at: FORA_DA_GRADE }),
    ).rejects.toMatchObject(RECUSA);
    expect(
      criados(banco),
      "o atendente marcou em cima do Google do dono — a coleta leu a ocupação com o olhar de quem pergunta",
    ).toHaveLength(0);
  });

  it("a GRADE, com um client que não enxerga a conexão, também RECUSA o horário do Google do dono", async () => {
    const banco = agenda({
      olhar: "atendente",
      eventosDoGoogle: [eventoDoGoogle(NA_GRADE, "2026-10-07T14:00:00.000Z")],
    });
    await expect(
      marcarAgendamentoHandler(banco.client, ctx(AGENTE), { event_type_id: TIPO, starts_at: NA_GRADE }),
    ).rejects.toMatchObject(RECUSA);
    expect(criados(banco), "a grade ofereceu o horário do Google do dono a quem não enxerga a conexão").toHaveLength(0);
  });
});

describe("a exceção de data é do dia LOCAL — a noite em fuso negativo (issue #878)", () => {
  // Quarta 07/10, 21:00 em São Paulo = 00:00Z de quinta 08/10. A jornada vai até
  // 23:00 para 21:00 ser um horário da grade; quem barra é o dia bloqueado.
  const NOITE = "2026-10-08T00:00:00.000Z";

  it("CONTROLE: sem bloqueio, a IA marca às 21:00 da quarta", async () => {
    const banco = agenda({ fimDaJornada: "23:00" });
    await marcarAgendamentoHandler(banco.client, ctx(AGENTE), { event_type_id: TIPO, starts_at: NOITE });
    expect(criados(banco), "a grade não oferece 21:00 nem sem bloqueio — o caso abaixo não provaria nada").toHaveLength(1);
  });

  it("a IA às 21:00 de um dia BLOQUEADO é RECUSADA — a exceção é buscada no dia local, não no UTC", async () => {
    const banco = agenda({ fimDaJornada: "23:00", diasBloqueados: ["2026-10-07"] });
    await expect(
      marcarAgendamentoHandler(banco.client, ctx(AGENTE), { event_type_id: TIPO, starts_at: NOITE }),
    ).rejects.toMatchObject(RECUSA);
    expect(criados(banco), "a IA marcou às 21:00 de um dia bloqueado: a coleta procurou a exceção no dia UTC").toHaveLength(0);
  });

  it("a PESSOA às 21:00 do dia bloqueado MARCA — o encaixe dispensa a exceção de data, de propósito", async () => {
    const banco = agenda({ fimDaJornada: "23:00", diasBloqueados: ["2026-10-07"] });
    await marcarAgendamentoHandler(banco.client, ctx(PESSOA), { event_type_id: TIPO, starts_at: NOITE });
    expect(criados(banco)).toHaveLength(1);
  });
});

describe("remarcar — a mesma regra", () => {
  const MEU_INICIO = NA_GRADE;
  const MEU_FIM = "2026-10-07T14:00:00.000Z";

  function meu(): Linha {
    return { ...agendamento(MEU_INICIO, MEU_FIM), id: MEU_COMPROMISSO };
  }

  function horarioDoMeu(banco: Banco): unknown {
    return banco.tabelas.calendar_appointments!.find((l) => l.id === MEU_COMPROMISSO)!.starts_at;
  }

  it("a IA remarcar para fora da grade é RECUSADO", async () => {
    const banco = agenda({ agendamentos: [meu()] });
    await expect(
      alterarAgendamentoHandler(banco.client, ctx(AGENTE), { id: MEU_COMPROMISSO, starts_at: "2026-10-07T16:30:00.000Z" }),
    ).rejects.toMatchObject(RECUSA);
    expect(horarioDoMeu(banco)).toBe(MEU_INICIO);
  });

  it("a pessoa move o encaixe para perto DELE MESMO — o próprio compromisso não é conflito", async () => {
    const banco = agenda({ agendamentos: [meu()] });
    await alterarAgendamentoHandler(banco.client, ctx(PESSOA), { id: MEU_COMPROMISSO, starts_at: FORA_DA_GRADE });
    expect(
      horarioDoMeu(banco),
      "o compromisso se viu como conflito ao ser movido 30 minutos: o encaixe nasce possível e fica preso",
    ).toBe(FORA_DA_GRADE);
  });

  it("a pessoa remarcar para cima de OUTRO AGENDAMENTO é RECUSADO", async () => {
    const banco = agenda({
      agendamentos: [meu(), agendamento("2026-10-07T17:00:00.000Z", "2026-10-07T18:00:00.000Z")],
    });
    await expect(
      alterarAgendamentoHandler(banco.client, ctx(PESSOA), { id: MEU_COMPROMISSO, starts_at: "2026-10-07T16:30:00.000Z" }),
    ).rejects.toMatchObject(RECUSA);
    expect(horarioDoMeu(banco)).toBe(MEU_INICIO);
  });

  it("a pessoa remarcar para cima de um evento do GOOGLE AGENDA é RECUSADO", async () => {
    const banco = agenda({
      agendamentos: [meu()],
      eventosDoGoogle: [eventoDoGoogle("2026-10-07T17:00:00.000Z", "2026-10-07T18:00:00.000Z")],
    });
    await expect(
      alterarAgendamentoHandler(banco.client, ctx(PESSOA), { id: MEU_COMPROMISSO, starts_at: "2026-10-07T16:30:00.000Z" }),
    ).rejects.toMatchObject(RECUSA);
    expect(horarioDoMeu(banco)).toBe(MEU_INICIO);
  });
});
