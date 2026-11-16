/**
 * A DURAÇÃO TAMBÉM MANDA NO PATCH (#4450) — a SEGUNDA porta do mesmo campo.
 *
 * ─── O que a #3709 fechou, e o que ela deixou aberto ───────────────────────
 *
 * A duração escolhida entrou na MARCAÇÃO (`MarcarInput.duration_minutes`, POST)
 * e o PATCH ficou sem o campo: `AlterarInput` tem dez campos e nenhum deles é a
 * duração. O PATCH preservava o comprimento do bloco que já existia — o que é
 * certo para remarcar e errado para quem só quer corrigir o tempo. Medido antes
 * desta fatia: 1 de 2 caminhos de escrita aceitava duração; mudar o tempo de um
 * compromisso de 90 minutos custava DELETE + POST + N PATCH, e o histórico
 * (timeline, `id`, espelho no Google) era refeito no meio.
 *
 * ─── As três coisas que este arquivo NÃO deixa regredir ────────────────────
 *
 * 1. a duração nova é ACEITA e o fim do bloco é recalculado a partir do início
 *    que o compromisso já tem — sem tocar no início;
 * 2. cliente antigo que NÃO manda duração continua sem zerar o bloco: o `ends_at`
 *    nem aparece no patch (é o caminho de hoje, byte a byte);
 * 3. a régua é a MESMA da criação — 5…1440 (`agenda_duracao_invalida`) e, num
 *    serviço, recusa nomeada (`agenda_duracao_do_servico`), porque ali o
 *    comprimento é o da agenda publicada.
 *
 * A conferência de horário livre é a metade que faz a duração valer: aceitar o
 * número sem pedir o tempo livre de verdade marcaria 90 minutos em cima de um
 * bloco de 30. Por isso o dublê de `horariosLivresDaOrg` guarda a duração que a
 * régua recebeu, e o caso 1 a confere.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { HandlerCtx } from "@/lib/api/handlers/types";

const { horariosLivresDaOrg } = vi.hoisted(() => ({ horariosLivresDaOrg: vi.fn() }));

vi.mock("@/lib/agenda/consulta", async (original) => {
  const real = await original<typeof import("@/lib/agenda/consulta")>();
  return {
    ...real,
    horariosLivresDaOrg,
    // Quem confere sobreposição é o encaixe; aqui o que se mede é a régua do
    // tempo, e um dublê vazio mantém o caminho do gerente (encaixe) sem banco.
    coletaOQueOcupa: vi.fn(async () => ({ ok: true, ocupados: [] })),
  };
});

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn(() => true) }));

const { alterarAgendamentoHandler } = await import("@/app/api/v1/agenda/agendamentos/_handler");
const { ApiError } = await import("@/lib/api/types");

const ORG = "aaaaaaaa-2222-4000-8000-00000000000a";
const AGENDAMENTO = "ffffffff-2222-4000-8000-00000000000f";
const TIPO = "cccccccc-2222-4000-8000-00000000000c";

/** Quinta, 12/11/2026, 10:00 em São Paulo (13:00Z) — bloco de 30 minutos. */
const INICIO = "2026-11-12T13:00:00.000Z";
const FIM_30 = "2026-11-12T13:30:00.000Z";

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: "bbbbbbbb-2222-4000-8000-00000000000b", role: "manager" },
  requestId: "req-4450",
} as unknown as HandlerCtx;

let patchGravado: Record<string, unknown> | null;

/** Cadeia tolerante: todo filtro devolve a si mesma e o `await` devolve a linha. */
function cadeia(linha: Record<string, unknown> | null) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "in", "is", "not", "order", "limit", "gte", "lte", "lt", "gt", "update", "insert", "upsert", "delete"]) {
    c[m] = () => c;
  }
  c.maybeSingle = async () => ({ data: linha, error: null });
  c.single = async () => ({ data: linha, error: null });
  c.then = (resolve: (v: unknown) => unknown) => resolve({ data: linha ? [linha] : [], error: null });
  return c;
}

function clienteCom(
  sobre: { tipoDurationMin?: number; duracaoDoBlocoMin?: number; servico?: boolean; occurrence?: string | null } = {},
) {
  const minutosDoBloco = sobre.duracaoDoBlocoMin ?? 30;
  const linha = {
    id: AGENDAMENTO,
    revision: 1,
    event_type_id: TIPO,
    owner_user_id: "dddddddd-2222-4000-8000-00000000000d",
    contact_id: null,
    starts_at: INICIO,
    ends_at: new Date(Date.parse(INICIO) + minutosDoBloco * 60_000).toISOString(),
    status: "confirmed",
    time_zone: "America/Sao_Paulo",
    service_occurrence_id: sobre.occurrence ?? null,
    service_block: null,
    outcome_source_kind: null,
    outcome_message_id: null,
    outcome_recorded_at: null,
  };
  const tipo = {
    id: TIPO,
    duration_minutes: sobre.tipoDurationMin ?? 30,
    service_enabled: sobre.servico ?? false,
  };
  return {
    from: (tabela: string) => {
      if (tabela === "calendar_appointments") return { select: () => cadeia(linha) };
      if (tabela === "calendar_event_types") return { select: () => cadeia(tipo) };
      return { select: () => cadeia(null), insert: () => cadeia(null), update: () => cadeia(null) };
    },
    rpc: async (nome: string, args: Record<string, unknown>) => {
      if (nome !== "fn_appointment_change") return { data: null, error: null };
      patchGravado = args.p_patch as Record<string, unknown>;
      return { data: { ...linha, ...patchGravado, revision: 2 }, error: null };
    },
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  patchGravado = null;
  horariosLivresDaOrg.mockReset();
  horariosLivresDaOrg.mockResolvedValue({
    ok: true,
    publicouHorarios: true,
    fusoDaRegra: "America/Sao_Paulo",
    slots: [{ inicio: new Date(INICIO), fim: new Date(FIM_30) }],
  });
});

describe("o PATCH aceita a duração escolhida (#4450)", () => {
  it("⭐ a duração nova vira o FIM do bloco, a partir do início que já existe", async () => {
    await alterarAgendamentoHandler(clienteCom(), ctx, { id: AGENDAMENTO, duration_minutes: 90 });

    expect(patchGravado).not.toBeNull();
    // 10:00 + 90 min = 11:30 em São Paulo (14:30Z).
    expect(patchGravado).toMatchObject({ ends_at: "2026-11-12T14:30:00.000Z" });
    // O INÍCIO não é reescrito: quem só mudou o tempo não remarcou nada.
    expect(patchGravado).not.toHaveProperty("starts_at");
  });

  it("⭐ a conferência de horário livre usa a duração NOVA, não a do molde", async () => {
    await alterarAgendamentoHandler(clienteCom({ tipoDurationMin: 30 }), ctx, {
      id: AGENDAMENTO,
      duration_minutes: 90,
    });

    expect(horariosLivresDaOrg).toHaveBeenCalledTimes(1);
    const parametros = horariosLivresDaOrg.mock.calls[0]?.[2] as { duracaoMin: number };
    expect(parametros.duracaoMin).toBe(90);
  });

  it("remarcar E mudar a duração no mesmo PATCH: o fim sai do início novo", async () => {
    const novoInicio = "2026-11-13T13:00:00.000Z";

    await alterarAgendamentoHandler(clienteCom(), ctx, {
      id: AGENDAMENTO,
      starts_at: novoInicio,
      duration_minutes: 45,
    });

    expect(patchGravado).toMatchObject({
      starts_at: novoInicio,
      ends_at: "2026-11-13T13:45:00.000Z",
    });
  });

  it("⭐ RETROCOMPATÍVEL: PATCH sem duração não zera o bloco que já existe", async () => {
    // O cliente antigo (tela de antes, integração por token) não conhece o campo.
    // Se o handler tratasse "ausente" como "volte ao molde", um bloco de 30
    // viraria 30 de novo... e um de 90 voltaria a 30 no primeiro salvamento.
    await alterarAgendamentoHandler(clienteCom({ tipoDurationMin: 30 }), ctx, {
      id: AGENDAMENTO,
      notes: "cliente confirmou por telefone",
    });

    expect(patchGravado).toMatchObject({ notes: "cliente confirmou por telefone" });
    expect(patchGravado).not.toHaveProperty("ends_at");
    expect(patchGravado).not.toHaveProperty("starts_at");
  });

  it("⭐ RETROCOMPATÍVEL: remarcar sem duração PRESERVA o comprimento do bloco", async () => {
    // Bloco de 90 minutos (o molde do tipo é 30) mudando de dia: o fim tem de
    // continuar sendo início + 90. Sem duração no pedido, nada de 30.
    await alterarAgendamentoHandler(clienteCom({ tipoDurationMin: 30, duracaoDoBlocoMin: 90 }), ctx, {
      id: AGENDAMENTO,
      starts_at: "2026-11-14T13:00:00.000Z",
    });

    expect(patchGravado).toMatchObject({
      starts_at: "2026-11-14T13:00:00.000Z",
      ends_at: "2026-11-14T14:30:00.000Z",
    });
  });

  it("duração fora de 5…1440 é recusada com o código da criação, e nada é gravado", async () => {
    for (const invalida of [3, 0, 1441, 30.5]) {
      const erro = await alterarAgendamentoHandler(clienteCom(), ctx, {
        id: AGENDAMENTO,
        duration_minutes: invalida,
      }).catch((e: unknown) => e);

      expect(erro).toBeInstanceOf(ApiError);
      expect((erro as InstanceType<typeof ApiError>).code).toBe("agenda_duracao_invalida");
    }
    expect(patchGravado).toBeNull();
    // A recusa é antes da régua de horário: valor inválido não vira consulta.
    expect(horariosLivresDaOrg).not.toHaveBeenCalled();
  });

  it("num SERVIÇO a duração não muda pelo compromisso — recusa nomeada", async () => {
    const erro = await alterarAgendamentoHandler(
      clienteCom({ servico: true, occurrence: "99999999-2222-4000-8000-000000000009" }),
      ctx,
      { id: AGENDAMENTO, duration_minutes: 45 },
    ).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as InstanceType<typeof ApiError>).code).toBe("agenda_duracao_do_servico");
    expect(patchGravado).toBeNull();
  });
});