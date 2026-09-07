import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { HandlerCtx } from "@/lib/api/handlers/types";

/**
 * NÃO SE REGISTRA O DESFECHO DE UM COMPROMISSO QUE AINDA NÃO ACONTECEU.
 *
 * ─── O buraco, e por que ele deixou de ser barato ──────────────────────────
 *
 * `alterarAgendamentoHandler` aceitava `completed` e `no_show` em qualquer
 * compromisso vivo. Nada comparava `starts_at` com o relógio — medido: a
 * palavra `now` não aparecia em nenhuma guarda de status do arquivo.
 *
 * Enquanto só gente escrevia isso pela tela o buraco custava pouco, porque os
 * botões "Realizado" e "Faltou" moram no histórico e ninguém rola até um
 * compromisso de terça que vem para clicar em "faltou". Deixou de custar pouco
 * quando `crm_set_appointment_outcome` pôs a mesma escrita na mão de um modelo,
 * que não escolhe por onde clicou — escolhe por texto, a partir de uma conversa
 * onde o paciente disse "não vou poder ir amanhã".
 *
 * ─── O dano do `no_show` prematuro é físico, não é registro errado ─────────
 *
 * `no_show` está em `LIBERAM_O_HORARIO` (`lib/agenda/ocupados.ts`): registrar
 * falta DEVOLVE ao pool um horário que a pessoa ainda espera. Outro paciente
 * marca em cima, e os dois chegam na mesma hora — e o primeiro tinha razão.
 *
 * `completed` prematuro faz outro estrago: grava `appointment_completed` na
 * timeline e some com os botões da tela, tirando de quem atendeu a chance de
 * registrar o que de fato aconteceu.
 *
 * ─── Onde a guarda mora, e por que não é na ferramenta ─────────────────────
 *
 * No HANDLER. A regra não é sobre quem chama: marcar como realizado o que não
 * começou é errado pela tela, pela API e pela IA. Uma guarda na ferramenta
 * deixaria a rota `PATCH` aberta com a mesma aparência de protegida.
 *
 * ─── O relógio deste arquivo ───────────────────────────────────────────────
 *
 * Os instantes são RELATIVOS a `Date.now()` — "daqui a um dia", "ontem" —, e não
 * datas fixas. Uma data fixa vira passado sozinha com o calendário, e o caso do
 * futuro deixaria de medir o futuro sem ninguém tocar em nada.
 */
vi.mock("@/lib/agenda/consulta", async (original) => {
  const real = await original<typeof import("@/lib/agenda/consulta")>();
  return { ...real, horariosLivresDaOrg: vi.fn() };
});

const { alterarAgendamentoHandler } = await import("@/app/api/v1/agenda/agendamentos/_handler");
const { ApiError } = await import("@/lib/api/types");

const ORG = "aaaaaaaa-1111-4000-8000-00000000000a";
const AGENDAMENTO = "ffffffff-1111-4000-8000-00000000000f";

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: "bbbbbbbb-1111-4000-8000-00000000000b", role: "manager" },
  requestId: "req-1",
} as unknown as HandlerCtx;

const DIA = 86_400_000;
let atualizado: Record<string, unknown> | null;

/** Dublê mínimo: só o que `exigeAgendamento` lê e o que o update grava. */
function clienteCom(startsAt: string, status: string): SupabaseClient {
  const linha = {
    id: AGENDAMENTO,
    revision: 1,
    event_type_id: "cccccccc-1111-4000-8000-00000000000c",
    owner_user_id: "dddddddd-1111-4000-8000-00000000000d",
    contact_id: "eeeeeeee-1111-4000-8000-00000000000e",
    starts_at: startsAt,
    status,
    time_zone: "America/Sao_Paulo",
  };
  const leitura = () => {
    const cadeia: Record<string, unknown> = {};
    for (const m of ["eq", "order", "limit", "in", "is", "not"]) cadeia[m] = () => cadeia;
    cadeia.maybeSingle = async () => ({ data: linha, error: null });
    cadeia.single = async () => ({ data: linha, error: null });
    return cadeia;
  };
  return {
    from: () => ({
      select: () => leitura(),
      update: (mudanca: Record<string, unknown>) => {
        atualizado = mudanca;
        const cadeia: Record<string, unknown> = {};
        for (const m of ["eq"]) cadeia[m] = () => cadeia;
        cadeia.select = () => cadeia;
        cadeia.single = async () => ({ data: { ...linha, ...mudanca }, error: null });
        return cadeia;
      },
      insert: () => ({ select: () => ({ single: async () => ({ data: {}, error: null }) }) }),
    }),
    rpc: async (name:string,args:Record<string,unknown>) => {
      if(name!=="fn_appointment_change") return {data:null,error:null};
      expect(args.p_org).toBe(ORG);expect(args.p_id).toBe(AGENDAMENTO);expect(args.p_revision).toBe(1);
      atualizado=args.p_patch as Record<string,unknown>;
      return {data:{...linha,...atualizado,revision:2},error:null};
    },
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  atualizado = null;
});

describe("desfecho de compromisso futuro é recusado", () => {
  for (const desfecho of ["completed", "no_show"] as const) {
    it(`\`${desfecho}\` num compromisso de amanhã é recusado, e nada é gravado`, async () => {
      const amanha = new Date(Date.now() + DIA).toISOString();

      const erro = await alterarAgendamentoHandler(
        clienteCom(amanha, "confirmed"),
        ctx,
        { id: AGENDAMENTO, status: desfecho },
      ).catch((e: unknown) => e);

      expect(erro).toBeInstanceOf(ApiError);
      expect((erro as InstanceType<typeof ApiError>).code).toBe("agenda_ainda_nao_aconteceu");
      // A recusa tem de ser ANTES do update: uma que só reclamasse depois de
      // gravar teria liberado o horário do mesmo jeito.
      expect(atualizado).toBeNull();
    });
  }

  it("o MESMO desfecho, num compromisso de ontem, é aceito — a guarda não vira muro", async () => {
    // O controle. Sem ele, uma guarda que recusasse SEMPRE satisfaria os casos
    // acima e quebraria o registro de falta, que é trabalho legítimo da recepção.
    const ontem = new Date(Date.now() - DIA).toISOString();

    await alterarAgendamentoHandler(clienteCom(ontem, "confirmed"), ctx, {
      id: AGENDAMENTO,
      status: "no_show",
    });

    expect(atualizado).toMatchObject({ status: "no_show" });
  });

  it("CONFIRMAR um compromisso futuro segue liberado — é o caso normal", async () => {
    // A guarda é sobre DESFECHO, não sobre status. Confirmar antes da hora é
    // exatamente o que se espera de quem combinou com o cliente; se a guarda
    // pegasse `confirmed` junto, ela quebraria o fluxo que veio destravar.
    const amanha = new Date(Date.now() + DIA).toISOString();

    await alterarAgendamentoHandler(clienteCom(amanha, "pending"), ctx, {
      id: AGENDAMENTO,
      status: "confirmed",
    });

    expect(atualizado).toMatchObject({ status: "confirmed" });
  });
});
