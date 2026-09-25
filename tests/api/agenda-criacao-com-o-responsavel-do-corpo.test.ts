import { beforeEach, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));

/**
 * A GRADE E A OCUPAÇÃO SÃO AQUI UM DADO, não o objeto do teste: o que este
 * arquivo mede é o PORTÃO DO RESPONSÁVEL na criação, e `horariosLivresDaOrg`
 * ficaria no caminho pedindo organização, jornada e regra de antecedência.
 * Trocar as duas funções de `@/lib/agenda/consulta` (e só elas) deixa o
 * caminho andar até o INSERT, que é onde a decisão tem de aparecer.
 */
const consulta = vi.hoisted(() => ({
  horarios: vi.fn(async () => ({
    ok: true,
    publicouHorarios: true,
    fusoDaRegra: "America/Sao_Paulo",
    slots: [
      {
        inicio: new Date("2026-09-21T13:00:00.000Z"),
        fim: new Date("2026-09-21T13:30:00.000Z"),
      },
    ],
  })),
  ocupacao: vi.fn(async () => ({ ok: true, ocupados: [] })),
}));
vi.mock("@/lib/agenda/consulta", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  horariosLivresDaOrg: consulta.horarios,
  coletaOQueOcupa: consulta.ocupacao,
}));

import { marcarAgendamentoHandler } from "@/app/api/v1/agenda/agendamentos/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A CRIAÇÃO COM O RESPONSÁVEL NO CORPO — o desenho FINAL, declarado no PR.
 *
 * A mudança (alterar/cancelar) recorta por DONO DO COMPROMISSO que já existe. A
 * criação não tem compromisso ainda, e é por isso que ela tem desenho PRÓPRIO —
 * o que segue é a decisão fechada do mantenedor, e ela está escrita igual no
 * corpo do PR e no comentário de `marcarAgendamentoHandler`:
 *
 *   BLOQUEIA apenas quando as TRÊS coisas são verdade ao mesmo tempo:
 *     (a) a opção `agenda_da_equipe.colegas_podem_mexer` está DESLIGADA;
 *     (b) quem pede é `agent` (abaixo de `manager`);
 *     (c) o `owner_user_id` veio EXPLÍCITO no corpo do pedido e é de OUTRA
 *         pessoa.
 *
 *   NÃO BLOQUEIA o responsável HERDADO de `calendar_event_types.default_owner_user_id`:
 *   quando o campo não vem no corpo, quem escolheu o dono foi a CONFIGURAÇÃO DA
 *   ORGANIZAÇÃO (o tipo criado por ela), não o Atendente. Recusar aqui seria a
 *   rota recusando o que a própria organização configurou — e quebraria o uso
 *   normal de um tipo com responsável padrão.
 *
 *   Com a opção LIGADA (o padrão), a criação não muda EM NADA: nem o dono
 *   explícito é recortado.
 *
 *   `ai_agent` e integração NÃO entram na regra: não existe "agenda própria" de
 *   robô, e o escopo delas fica declarado no PR — inventar recorte por dono aqui
 *   seria mudar o que ninguém decidiu.
 *
 * O que se mede é COMPORTAMENTO: se a linha chegou ao INSERT (e com que dono) ou
 * se a recusa veio antes de qualquer escrita.
 */

const ORG = "00000000-0000-4000-8000-000000000001";
const DONO = "00000000-0000-4000-8000-0000000000aa";
const OUTRO = "00000000-0000-4000-8000-0000000000bb";
const TIPO = "00000000-0000-4000-8000-0000000000dd";
const INICIO = "2026-09-21T13:00:00.000Z";

const tipoDe = (donoPadrao: string | null) => ({
  id: TIPO,
  name: "Consulta",
  is_active: true,
  duration_minutes: 30,
  default_owner_user_id: donoPadrao,
  requires_confirmation: false,
  location_kind: "none",
  location_details: null,
});

/**
 * O cliente falso registra TODA chamada e guarda o que foi inserido: é assim que
 * o teste prova que a recusa acontece ANTES da escrita (nada em `inseridos`), e
 * que a criação que PASSA grava o dono que devia gravar.
 */
function sbDeTeste(
  tipo: Record<string, unknown>,
  opcaoLigada: boolean | null,
  chamadas: string[],
  inseridos: Record<string, unknown>[],
) {
  const criado = {
    id: "00000000-0000-4000-8000-0000000000ee",
    starts_at: INICIO,
    ends_at: "2026-09-21T13:30:00.000Z",
    status: "confirmed",
    time_zone: "America/Sao_Paulo",
    revision: 1,
    meeting_state: "none",
    meeting_url: null,
  };
  const api = {
    from(tabela: string) {
      chamadas.push(`from:${tabela}`);
      const q = {
        select: () => q,
        eq: () => q,
        is: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({
          data: tabela === "calendar_event_types" ? tipo : null,
          error: null,
        }),
        single: async () => ({ data: criado, error: null }),
        insert: (linha: Record<string, unknown>) => {
          chamadas.push(`inserir:${tabela}`);
          inseridos.push(linha);
          return q;
        },
        update: () => {
          chamadas.push(`atualizar:${tabela}`);
          return q;
        },
        delete: () => q,
      };
      return q;
    },
    async rpc(nome: string) {
      chamadas.push(`rpc:${nome}`);
      if (nome === "fn_colegas_podem_mexer_na_agenda") return { data: opcaoLigada, error: null };
      return { data: null, error: null };
    },
  };
  return api as unknown as SupabaseClient;
}

const ctxDe = (papel: string, quem = DONO): HandlerCtx =>
  ({
    organization_id: ORG,
    requestId: "req-978",
    actor: { type: "user", id: quem, role: papel },
  }) as unknown as HandlerCtx;

const ctxDaIA = (): HandlerCtx =>
  ({
    organization_id: ORG,
    requestId: "req-978",
    actor: { type: "ai_agent", id: "run-1", role: "agent" },
  }) as unknown as HandlerCtx;

const pedido = { event_type_id: TIPO, starts_at: INICIO } as const;

beforeEach(() => {
  vi.resetAllMocks();
  consulta.horarios.mockResolvedValue({
    ok: true,
    publicouHorarios: true,
    fusoDaRegra: "America/Sao_Paulo",
    slots: [
      { inicio: new Date(INICIO), fim: new Date("2026-09-21T13:30:00.000Z") },
    ],
  });
  consulta.ocupacao.mockResolvedValue({ ok: true, ocupados: [] });
});

it("Atendente com o responsável de OUTRO no corpo, opção desligada: recusa SEM escrita", async () => {
  const chamadas: string[] = [];
  const inseridos: Record<string, unknown>[] = [];
  const sb = sbDeTeste(tipoDe(null), false, chamadas, inseridos);

  await expect(
    marcarAgendamentoHandler(sb, ctxDe("agent", DONO), { ...pedido, owner_user_id: OUTRO }),
  ).rejects.toMatchObject({ status: 403, code: "appointment_do_colega" });

  // A prova que importa: nada foi inserido e nada foi auditado.
  expect(inseridos).toHaveLength(0);
  expect(chamadas).not.toContain("inserir:calendar_appointments");
  expect(deps.audit).not.toHaveBeenCalled();
});

it("Atendente com o responsável HERDADO do tipo (de um colega), opção desligada: recusa SEM escrita", async () => {
  // O PEDIDO TEXTUAL DO MANTENEDOR NO FIO DA #978 (16/09): "escolher o tipo de
  // outra pessoa não pode virar atalho". Com a opção desligada, o responsável
  // PADRÃO do tipo escreve na agenda de um colega tanto quanto o `owner_user_id`
  // do corpo — então os dois caminhos recusam, e a régua é o `donoId` resolvido.
  const chamadas: string[] = [];
  const inseridos: Record<string, unknown>[] = [];
  const sb = sbDeTeste(tipoDe(OUTRO), false, chamadas, inseridos);

  await expect(marcarAgendamentoHandler(sb, ctxDe("agent", DONO), pedido)).rejects.toMatchObject({
    status: 403,
    code: "appointment_do_colega",
  });

  expect(inseridos).toHaveLength(0);
  expect(chamadas).not.toContain("inserir:calendar_appointments");
  expect(deps.audit).not.toHaveBeenCalled();
});

it("Atendente marcando para SI, opção desligada: passa", async () => {
  const chamadas: string[] = [];
  const inseridos: Record<string, unknown>[] = [];
  const sb = sbDeTeste(tipoDe(null), false, chamadas, inseridos);

  await marcarAgendamentoHandler(sb, ctxDe("agent", DONO), { ...pedido, owner_user_id: DONO });

  expect(inseridos).toHaveLength(1);
  expect(inseridos[0]).toMatchObject({ owner_user_id: DONO });
});

it("Atendente com o responsável de OUTRO no corpo, opção LIGADA: passa como sempre", async () => {
  const chamadas: string[] = [];
  const inseridos: Record<string, unknown>[] = [];
  const sb = sbDeTeste(tipoDe(null), true, chamadas, inseridos);

  await marcarAgendamentoHandler(sb, ctxDe("agent", DONO), { ...pedido, owner_user_id: OUTRO });

  expect(inseridos).toHaveLength(1);
  expect(inseridos[0]).toMatchObject({ owner_user_id: OUTRO });
});

it("Gerente com o responsável de um colega no corpo, opção desligada: passa", async () => {
  const chamadas: string[] = [];
  const inseridos: Record<string, unknown>[] = [];
  const sb = sbDeTeste(tipoDe(null), false, chamadas, inseridos);

  await marcarAgendamentoHandler(sb, ctxDe("manager", DONO), { ...pedido, owner_user_id: OUTRO });

  expect(inseridos).toHaveLength(1);
  expect(inseridos[0]).toMatchObject({ owner_user_id: OUTRO });
});

it("IA marcando para um colega, opção desligada: passa (não é Atendente)", async () => {
  const chamadas: string[] = [];
  const inseridos: Record<string, unknown>[] = [];
  const sb = sbDeTeste(tipoDe(null), false, chamadas, inseridos);

  await marcarAgendamentoHandler(sb, ctxDaIA(), { ...pedido, owner_user_id: OUTRO });

  expect(inseridos).toHaveLength(1);
  expect(inseridos[0]).toMatchObject({ owner_user_id: OUTRO });
});

it("Tipo sem responsável e sem responsável no corpo: 422 (a falta vem antes da regra do colega)", async () => {
  const chamadas: string[] = [];
  const inseridos: Record<string, unknown>[] = [];
  const sb = sbDeTeste(tipoDe(null), false, chamadas, inseridos);

  await expect(marcarAgendamentoHandler(sb, ctxDe("agent", DONO), pedido)).rejects.toMatchObject({
    status: 422,
    code: "agenda_sem_responsavel",
  });

  expect(inseridos).toHaveLength(0);
});
