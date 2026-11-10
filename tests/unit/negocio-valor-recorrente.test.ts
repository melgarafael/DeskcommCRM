/**
 * O NEGÓCIO GUARDA O VALOR ÚNICO **E** O RECORRENTE — fatia 1 da issue #3602.
 *
 * ─── A dor que estes casos fixam ────────────────────────────────────────────
 *
 * Muito do que se vende aqui é setup + mensalidade. O negócio guardava um valor
 * só (`crm_leads.value_cents`), então quem põe R$ 3.000 de implantação e R$ 500
 * por mês tinha duas saídas ruins: gravar só o setup (o contrato parece 6×
 * menor do que é) ou somar tudo num número (ninguém sabe quanto entra todo mês).
 *
 * A fatia 1 NÃO soma nada e NÃO muda o que existe: `value_cents` continua sendo
 * o valor único (setup, implantação, matrícula) e ganha dois vizinhos —
 * `recurring_value_cents` + `recurring_period` (mensal, na v1) e
 * `recurring_months` (duração; nulo = sem prazo). Negócio de valor único
 * continua idêntico em TODAS as telas.
 *
 * ─── O que cada bloco prova ─────────────────────────────────────────────────
 *
 * 1. o SCHEMA aceita os dois juntos e recusa recorrente negativo (o valor
 *    mensal é dinheiro: `nonnegative` é a régua do `value_cents`);
 * 2. o HANDLER grava os dois no INSERT e no PATCH, sem somar, e limpa
 *    periodicidade/duração quando o recorrente volta a nulo;
 * 3. o CARD e o PAINEL LATERAL mostram os dois (R$ 3.000 + R$ 500/mês), e o
 *    negócio só com valor único continua com a linha de sempre;
 * 4. a ÚLTIMA COMPRA (negócio ganho) mostra a mensalidade da mesma forma;
 * 5. o MCP/agente devolve os campos novos quando eles existem.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* ── dublês de infraestrutura (mesmo molde do teste de auditoria do #1755) ── */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: () => "movido",
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));
vi.mock("@/lib/atendimento/origem", () => ({ observeServiceOrigin: async () => "humano" }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: async () => ({ error: null }) }),
}));
vi.mock("@/lib/mcp/conferencia-de-campos", () => ({
  conferirCamposPersonalizados: vi.fn(async () => ({ custom_fields: undefined, recusados: [] })),
}));

/* O card é drag-and-drop e tem slots que leem hooks: aqui interessa a linha do
 * VALOR, que é do próprio card. Os vizinhos entram como nulos para o render não
 * depender de rede. */
// A lateral do atendimento renderiza o diálogo de módulos (#3008), que usa os
// três componentes do pacote; o dublê precisa cobrir os três, não só o do card.
vi.mock("@hello-pangea/dnd", () => ({
  DragDropContext: ({ children }: { children: unknown }) => children,
  Droppable: ({ children }: { children: (p: unknown) => unknown }) =>
    children({ innerRef: () => undefined, droppableProps: {}, placeholder: null }),
  Draggable: ({ children }: { children: (p: unknown, s: unknown) => unknown }) =>
    children({ innerRef: () => undefined, draggableProps: {}, dragHandleProps: {} }, { isDragging: false }),
}));
vi.mock("@/components/kanban/KanbanCardActions", () => ({ KanbanCardActions: () => null }));
vi.mock("@/components/kanban/NextActionSlot", () => ({ NextActionSlot: () => null }));
vi.mock("@/components/kanban/ReactivationSlot", () => ({ ReactivationSlot: () => null }));
vi.mock("@/components/kanban/ConversaSlot", () => ({ ConversaSlot: () => null }));
vi.mock("@/components/kanban/ScoreSlot", () => ({ ScoreSlot: () => null }));
vi.mock("@/components/kanban/OwnerBadge", () => ({ OwnerBadge: () => null }));
vi.mock("@/components/kanban/ContatoNoCard", () => ({ ContatoNoCard: () => null }));
vi.mock("@/components/kanban/TarefasNoCard", () => ({ TarefasNoCard: () => null }));

import { createLeadHandler, updateLeadHandler } from "@/app/api/v1/leads/_handler";
import { KanbanCard } from "@/components/kanban/KanbanCard";
import { CRMSidePanel } from "@/components/inbox/CRMSidePanel";
import { UltimasCompras } from "@/components/contacts/UltimasCompras";
import { buildCardInput } from "@/lib/kanban/card-state";
import { montarCompras, type LeadGanhoRow } from "@/lib/leads/compras-do-contato";
import {
  PERIODICIDADE_PADRAO,
  lerRecorrenciaDoFormulario,
  recorrenciaParaGravar,
  rotuloDaRecorrencia,
} from "@/lib/leads/valor-recorrente";
import { crmUpdateLead } from "@/lib/mcp/tools/leads";
import { createLeadSchema, updateLeadSchema } from "@/lib/schemas/leads";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { Lead } from "@/lib/types/leads";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PIPELINE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ETAPA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LEAD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/** O negócio da issue: R$ 3.000 de setup e R$ 500 por mês, 12 meses. */
const SETUP = 300000;
const MENSALIDADE = 50000;

/* ────────────────────────── 1. o schema ────────────────────────── */

describe("o schema aceita valor único E recorrente, sem somar", () => {
  it("guarda os dois separados — 3000 de setup + 500/mês não viram 3500", () => {
    const parsed = createLeadSchema.parse({
      pipeline_id: PIPELINE,
      stage_id: ETAPA,
      title: "Clínica Vida Odonto — implantação + gestão",
      value_cents: SETUP,
      recurring_value_cents: MENSALIDADE,
      recurring_period: PERIODICIDADE_PADRAO,
      recurring_months: 12,
    });

    expect(parsed.value_cents).toBe(SETUP);
    expect(parsed.recurring_value_cents).toBe(MENSALIDADE);
    expect(parsed.recurring_period).toBe("monthly");
    expect(parsed.recurring_months).toBe(12);
    // CONTROLE: a soma é o defeito que a fatia existe para não repetir.
    expect(parsed.value_cents).not.toBe(SETUP + MENSALIDADE);
  });

  it("recusa valor recorrente NEGATIVO — mensalidade é dinheiro", () => {
    const recusa = createLeadSchema.safeParse({
      pipeline_id: PIPELINE,
      stage_id: ETAPA,
      title: "Negócio com mensalidade negativa",
      recurring_value_cents: -1,
    });
    expect(recusa.success, "o schema aceitou recorrente negativo").toBe(false);

    const noPatch = updateLeadSchema.safeParse({ recurring_value_cents: -500 });
    expect(noPatch.success, "o PATCH aceitou recorrente negativo").toBe(false);
  });

  it("recusa periodicidade que a v1 não conhece e duração zero", () => {
    const base = { pipeline_id: PIPELINE, stage_id: ETAPA, title: "Negócio" };
    expect(createLeadSchema.safeParse({ ...base, recurring_period: "yearly" }).success).toBe(false);
    expect(createLeadSchema.safeParse({ ...base, recurring_months: 0 }).success).toBe(false);
  });

  it("retrocompatível: sem os campos novos, nada aparece e o valor único segue igual", () => {
    const parsed = createLeadSchema.parse({
      pipeline_id: PIPELINE,
      stage_id: ETAPA,
      title: "Negócio só com setup",
      value_cents: SETUP,
    });
    expect(parsed.value_cents).toBe(SETUP);
    expect(parsed.recurring_value_cents).toBeUndefined();
    expect(parsed.recurring_period).toBeUndefined();
    expect(parsed.recurring_months).toBeUndefined();

    // O PATCH de hoje (só valor) continua válido.
    expect(updateLeadSchema.safeParse({ value_cents: SETUP }).success).toBe(true);
    // E o PATCH consegue LIMPAR o recorrente (nulo explícito).
    expect(updateLeadSchema.safeParse({ recurring_value_cents: null }).success).toBe(true);
  });
});

/* ────────────────────────── 2. a régua pura ────────────────────────── */

describe("a régua do recorrente (pura)", () => {
  it("recorrente sem periodicidade nasce MENSAL, e nulo limpa o trio inteiro", () => {
    expect(recorrenciaParaGravar({ recurring_value_cents: MENSALIDADE })).toEqual({
      recurring_value_cents: MENSALIDADE,
      recurring_period: "monthly",
      recurring_months: null,
    });
    expect(recorrenciaParaGravar({ recurring_value_cents: null, recurring_months: 12 })).toEqual({
      recurring_value_cents: null,
      recurring_period: null,
      recurring_months: null,
    });
  });

  it("lê o que a pessoa digita na moeda da organização (a régua dos 3 formulários)", () => {
    // "1.500,00" em BRL é mil e quinhentos — não 1,50. A vírgula é decimal e o
    // ponto é milhar quando a moeda tem centavos (#3331).
    expect(lerRecorrenciaDoFormulario("1.500,00", "12", "BRL")).toEqual({
      ok: true,
      trio: { recurring_value_cents: 150000, recurring_period: "monthly", recurring_months: 12 },
    });
    // Campo vazio = negócio sem recorrência, e o trio inteiro vai nulo.
    expect(lerRecorrenciaDoFormulario("  ", "", "BRL")).toEqual({
      ok: true,
      trio: { recurring_value_cents: null, recurring_period: null, recurring_months: null },
    });
    // Duração sem mensalidade é RECUSA (o banco não aceita o órfão), e texto
    // que não é número inteiro também — nada de "12 meses" virar 12 calado.
    expect(lerRecorrenciaDoFormulario("", "12", "BRL")).toEqual({
      ok: false,
      campo: "valor",
      motivo: "duracao_sem_mensalidade",
    });
    expect(lerRecorrenciaDoFormulario("500,00", "12 meses", "BRL")).toEqual({
      ok: false,
      campo: "meses",
      motivo: "duracao_invalida",
    });
    expect(lerRecorrenciaDoFormulario("500,00", "0", "BRL")).toEqual({
      ok: false,
      campo: "meses",
      motivo: "duracao_invalida",
    });
  });

  it("escreve o rótulo de quem vende por mês e não inventa um para quem não tem", () => {
    const rotulo = rotuloDaRecorrencia(MENSALIDADE, "monthly", "BRL", { semCentavos: true });
    expect(rotulo).toMatch(/500\/mês$/);
    expect(rotulo).toMatch(/^R\$\s*500\/mês$/);
    expect(rotuloDaRecorrencia(null, null, "BRL")).toBeNull();
  });
});

/* ──────────────── 3. o handler grava os dois (INSERT/PATCH) ──────────────── */

/** Banco falso do create: responde por tabela e guarda a linha inserida. */
function supabaseDaCriacao() {
  const inseridos: Record<string, unknown>[] = [];
  const cadeia = (tabela: string) => {
    const resposta = () => {
      if (tabela === "crm_stages") {
        return { data: { id: ETAPA, pipeline_id: PIPELINE, organization_id: ORG }, error: null };
      }
      if (tabela === "organizations") return { data: { currency: "BRL" }, error: null };
      return { data: null, error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      is: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: async () => resposta(),
      single: async () => ({ data: { ...inseridos.at(-1), id: LEAD }, error: null }),
      insert: (linha: Record<string, unknown>) => {
        inseridos.push(linha);
        return q;
      },
    };
    return q;
  };
  return { cliente: { from: (t: string) => cadeia(t) } as never, inseridos };
}

/** Banco falso do update: lê o estado, grava o patch e guarda o que foi enviado. */
function supabaseDaEdicao(estado: Record<string, unknown>) {
  const banco: Record<string, unknown> = { ...estado };
  const atualizacoes: Record<string, unknown>[] = [];
  const from = (tabela: string) => {
    if (tabela !== "crm_leads") throw new Error(`tabela inesperada: ${tabela}`);
    return {
      select: () => {
        const leitura: Record<string, unknown> = {};
        leitura.eq = () => leitura;
        leitura.maybeSingle = async () => ({ data: { ...banco }, error: null });
        return leitura;
      },
      update: (valores: Record<string, unknown>) => {
        atualizacoes.push(valores);
        const escrita: Record<string, unknown> = {};
        escrita.eq = () => escrita;
        escrita.select = () => escrita;
        escrita.maybeSingle = async () => {
          Object.assign(banco, valores);
          return { data: { ...banco }, error: null };
        };
        return escrita;
      },
    };
  };
  return {
    cliente: {
      from,
      rpc: () => ({ then: (fn: (r: { error: null }) => void) => Promise.resolve(fn({ error: null })) }),
    } as never,
    banco,
    atualizacoes,
  };
}

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: "11111111-1111-4111-8111-111111111111" },
  requestId: "req-3602",
  idioma: "pt-BR",
};

const EXISTENTE = {
  id: LEAD,
  organization_id: ORG,
  contact_id: null,
  pipeline_id: PIPELINE,
  stage_id: ETAPA,
  status: "open",
  title: "Clínica Vida Odonto",
  description: null,
  value_cents: SETUP,
  currency: "BRL",
  expected_close_date: null,
  owner_user_id: null,
  owner_agent_id: null,
  owner_kind: null,
  tags: [],
  custom_fields: {},
  recurring_value_cents: null,
  recurring_period: null,
  recurring_months: null,
  updated_at: "2026-10-01T12:00:00.000Z",
};

describe("o handler grava o valor único e o recorrente, sem somar", () => {
  beforeEach(() => vi.clearAllMocks());

  it("criação: INSERT carrega os dois valores e a periodicidade", async () => {
    const db = supabaseDaCriacao();
    await createLeadHandler(db.cliente, ctx, {
      pipeline_id: PIPELINE,
      stage_id: ETAPA,
      title: "Clínica Vida Odonto — implantação + gestão",
      value_cents: SETUP,
      recurring_value_cents: MENSALIDADE,
      recurring_period: PERIODICIDADE_PADRAO,
      recurring_months: 12,
      source: "manual",
      tags: [],
    });

    const linha = db.inseridos.at(-1)!;
    expect(linha.value_cents).toBe(SETUP);
    expect(linha.recurring_value_cents).toBe(MENSALIDADE);
    expect(linha.recurring_period).toBe("monthly");
    expect(linha.recurring_months).toBe(12);
    // CONTROLE: o `value_cents` NÃO recebeu a soma.
    expect(linha.value_cents).not.toBe(SETUP + MENSALIDADE);
  });

  it("criação sem recorrente continua idêntica à de hoje (colunas nulas)", async () => {
    const db = supabaseDaCriacao();
    await createLeadHandler(db.cliente, ctx, {
      pipeline_id: PIPELINE,
      stage_id: ETAPA,
      title: "Negócio só com setup",
      value_cents: SETUP,
      source: "manual",
      tags: [],
    });

    const linha = db.inseridos.at(-1)!;
    expect(linha.value_cents).toBe(SETUP);
    expect(linha.recurring_value_cents).toBeNull();
    expect(linha.recurring_period).toBeNull();
    expect(linha.recurring_months).toBeNull();
  });

  it("edição: o PATCH leva o recorrente e não toca no valor único", async () => {
    const db = supabaseDaEdicao(EXISTENTE);
    await updateLeadHandler(db.cliente, ctx, LEAD, {
      recurring_value_cents: MENSALIDADE,
      recurring_months: 6,
    });

    const patch = db.atualizacoes.at(-1)!;
    expect(patch.recurring_value_cents).toBe(MENSALIDADE);
    expect(patch.recurring_period).toBe("monthly");
    expect(patch.recurring_months).toBe(6);
    expect(patch).not.toHaveProperty("value_cents");
    expect(db.banco.value_cents).toBe(SETUP);
  });

  it("edição: recorrente nulo limpa periodicidade e duração (sem órfão no banco)", async () => {
    const db = supabaseDaEdicao({
      ...EXISTENTE,
      recurring_value_cents: MENSALIDADE,
      recurring_period: "monthly",
      recurring_months: 12,
    });
    await updateLeadHandler(db.cliente, ctx, LEAD, { recurring_value_cents: null });

    const patch = db.atualizacoes.at(-1)!;
    expect(patch.recurring_value_cents).toBeNull();
    expect(patch.recurring_period).toBeNull();
    expect(patch.recurring_months).toBeNull();
  });

  it("edição parcial: mandar só a duração não apaga a mensalidade gravada", async () => {
    const db = supabaseDaEdicao({
      ...EXISTENTE,
      recurring_value_cents: MENSALIDADE,
      recurring_period: "monthly",
      recurring_months: 12,
    });
    await updateLeadHandler(db.cliente, ctx, LEAD, { recurring_months: 24 });

    expect(db.banco.recurring_value_cents).toBe(MENSALIDADE);
    expect(db.banco.recurring_period).toBe("monthly");
    expect(db.banco.recurring_months).toBe(24);
  });

  it("edição parcial: mandar só a mensalidade não apaga a duração gravada", async () => {
    const db = supabaseDaEdicao({
      ...EXISTENTE,
      recurring_value_cents: MENSALIDADE,
      recurring_period: "monthly",
      recurring_months: 12,
    });
    await updateLeadHandler(db.cliente, ctx, LEAD, { recurring_value_cents: 60000 });

    expect(db.banco.recurring_value_cents).toBe(60000);
    expect(db.banco.recurring_months).toBe(12);
  });
});

/* ──────────── 4. o card e o painel lateral mostram os DOIS ──────────── */

function lead(extra: Partial<Lead> = {}): Lead {
  return {
    id: LEAD,
    organization_id: ORG,
    pipeline_id: PIPELINE,
    stage_id: ETAPA,
    contact_id: null,
    title: "Clínica Vida Odonto",
    description: null,
    status: "open",
    lost_reason: null,
    position_in_stage: 1000,
    value_cents: SETUP,
    currency: "BRL",
    owner_user_id: null,
    owner_kind: null,
    owner_agent_id: null,
    expected_close_date: null,
    tags: [],
    custom_fields: {},
    stage_changed_at: "2026-10-01T12:00:00.000Z",
    created_at: "2026-10-01T12:00:00.000Z",
    updated_at: "2026-10-01T12:00:00.000Z",
    ...(extra as object),
  } as unknown as Lead;
}

describe("o card do funil", () => {
  function montarCard(l: Lead) {
    const card = buildCardInput(l, { stageName: "Negociação", ownerNames: new Map() });
    // `createElement` e não JSX: este arquivo é `.ts` porque o comando do gate o
    // nomeia assim (`tests/unit/negocio-valor-recorrente.test.ts`) — a precedente
    // de teste de componente em `.ts` é `agenda-travessia-api-hook.test.ts`.
    return render(createElement(KanbanCard, { card, lead: l, index: 0, pipelineId: PIPELINE }));
  }

  it("mostra R$ 3.000 + R$ 500/mês — os dois, não a soma", () => {
    const comRecorrente = lead({
      recurring_value_cents: MENSALIDADE,
      recurring_period: "monthly",
      recurring_months: 12,
    });
    montarCard(comRecorrente);
    const valor = screen.getByTestId("card-valor");
    expect(valor).toHaveTextContent(/3\.000/);
    expect(valor).toHaveTextContent(/500\/mês/);
    // CONTROLE: 3.500 é a soma que a fatia não faz.
    expect(valor).not.toHaveTextContent(/3\.500/);
  });

  it("negócio só com valor único continua com a linha de hoje", () => {
    montarCard(lead());
    const valor = screen.getByTestId("card-valor");
    expect(valor).toHaveTextContent(/3\.000/);
    expect(valor).not.toHaveTextContent(/mês/);
  });
});

describe("o painel lateral do atendimento", () => {
  const CONTACT_ID = "c0000000-0000-4000-8000-000000000001";
  const get = vi.hoisted(() => vi.fn());

  vi.mock("@/lib/api/client", () => ({
    apiClient: { get: (...a: unknown[]) => get(...a), post: vi.fn(), patch: vi.fn() },
  }));
  vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({ useDefaultPipeline: () => ({ data: null, isError: false }) }));
  vi.mock("@/hooks/inbox/useConversationTags", () => ({
    useUpdateConversationTags: () => ({ mutate: vi.fn(), isPending: false }),
    useConversationTagVocabulary: () => ({ data: [] }),
  }));
  vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({ useContactTagVocabulary: () => ({ data: [] }) }));
  vi.mock("@/hooks/contacts/useUpdateContact", () => ({ useUpdateContact: () => ({ mutate: vi.fn(), isPending: false }) }));
  vi.mock("@/hooks/contacts/useContact", () => ({
    useContact: () => ({
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
      data: {
        data: {
          id: CONTACT_ID,
          name: "Joana Prado",
          display_name: null,
          email: null,
          phone_number: null,
          birthdate: null,
          tags: [],
          source: "manual",
          source_metadata: {},
          custom_fields: {},
          created_at: "2026-01-01T10:00:00Z",
          last_activity_at: null,
          first_service_at: null,
          is_blocked: false,
          is_personal: false,
          is_anonymized: false,
          ai_opt_out: false,
          address_book_name: null,
          anonymized_at: null,
          conversa: null,
        },
      },
    }),
  }));
  vi.mock("@/hooks/auth/AuthProvider", () => ({
    useAuth: () => ({
      user: { is_platform_admin: false, support: null },
      activeOrg: { orgId: "org-1", role: "agent", cliente_pela_agenda: false },
    }),
  }));
  vi.mock("@/hooks/contacts/useHierarquiaDoAnuncio", () => ({ useHierarquiaDoAnuncio: () => ({ data: null }) }));
  vi.mock("@/hooks/contacts/useUnblockContact", () => ({ useUnblockContact: () => ({ mutate: vi.fn(), isPending: false }) }));
  vi.mock("@/hooks/contacts/usePersonalContact", () => ({
    useMarkPersonalContact: () => ({ mutate: vi.fn(), isPending: false }),
    useUnmarkPersonalContact: () => ({ mutate: vi.fn(), isPending: false }),
  }));
  vi.mock("@/hooks/contacts/useAlwaysHumanContact", () => ({
    useMarkAlwaysHumanContact: () => ({ mutate: vi.fn(), isPending: false }),
    useUnmarkAlwaysHumanContact: () => ({ mutate: vi.fn(), isPending: false }),
  }));
  vi.mock("@/components/contacts/CartaoDaCarteira", () => ({ CartaoDaCarteira: () => null }));
  vi.mock("@/components/contacts/PropostasDeDado", () => ({ PropostasDeDado: () => null }));
  vi.mock("@/components/contacts/RoteirosDoContato", () => ({ RoteirosDoContato: () => null }));
  vi.mock("@/components/kanban/ConversaNoDossie", () => ({ ConversaNoDossie: () => null }));
  vi.mock("@/components/contacts/TimelineView", () => ({ TimelineView: () => null }));
  vi.mock("@/components/contacts/EditContactDialog", () => ({ EditContactDialog: () => null }));
  vi.mock("@/components/contacts/AnonymizeDialog", () => ({ AnonymizeDialog: () => null }));
  vi.mock("@/components/modulos/FichasDoModulo", () => ({ FichasDoModulo: () => null }));
  vi.mock("@/components/voice/DialButton", () => ({ DialButton: () => null }));

  const conversa = {
    id: "cv-1",
    organization_id: "org-1",
    contact_id: CONTACT_ID,
    tags: [],
    contacts: { id: CONTACT_ID, display_name: "Fulana", name: null, phone_number: "5511999", tags: [] },
  } as unknown as React.ComponentProps<typeof CRMSidePanel>["conversation"];

  const linhaDoLead = (id: string, extra: Record<string, unknown>) => ({
    id,
    title: "Clínica Vida Odonto",
    status: "open",
    value_cents: SETUP,
    currency: "BRL",
    updated_at: "2026-10-01T12:00:00.000Z",
    pipeline_id: PIPELINE,
    custom_fields: {},
    field_defs: [],
    funil_nome: "Clínica",
    etapa_nome: "Negociação",
    ...extra,
  });

  beforeEach(() => {
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (String(url).includes("/compras")) return Promise.resolve({ data: { compras: [] } });
      if (String(url).includes("/crm-summary")) {
        return Promise.resolve({
          data: {
            leads: [
              linhaDoLead("l-recorrente", {
                recurring_value_cents: MENSALIDADE,
                recurring_period: "monthly",
                recurring_months: 12,
              }),
              linhaDoLead("l-unico", { title: "Negócio só com setup", value_cents: 120000 }),
            ],
            orders: [],
            activities: [],
            demandas: [],
          },
        });
      }
      return Promise.resolve({ data: { leads: [], orders: [], activities: [], demandas: [] } });
    });
  });

  it("a lista de negócios mostra os dois valores, e o de valor único fica como era", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(createElement(QueryClientProvider, { client: qc }, createElement(CRMSidePanel, { conversation: conversa })));

    await waitFor(() => expect(screen.getByTestId("inbox-lead-l-recorrente")).toBeTruthy());
    const comRecorrente = screen.getByTestId("inbox-lead-l-recorrente");
    expect(comRecorrente).toHaveTextContent(/3\.000/);
    // O painel mostra CENTAVOS como o resto do dossiê ("R$ 500,00/mês"); o card
    // é quem abre mão deles, porque a linha dele tem altura fixa.
    expect(comRecorrente).toHaveTextContent(/500,00\/mês/);

    const soUnico = screen.getByTestId("inbox-lead-l-unico");
    expect(soUnico).toHaveTextContent(/1\.200/);
    expect(soUnico).not.toHaveTextContent(/mês/);
  });
});

/* ─────────────────── 5. a última compra e o MCP ─────────────────── */

describe("a última compra do contato", () => {
  const ganho: LeadGanhoRow = {
    id: "l-ganho",
    pipeline_id: PIPELINE,
    title: "Implantação + gestão",
    status: "won",
    value_cents: SETUP,
    currency: "BRL",
    closed_at: "2026-10-01T12:00:00.000Z",
    custom_fields: {},
    recurring_value_cents: MENSALIDADE,
    recurring_period: "monthly",
    recurring_months: 12,
  } as LeadGanhoRow;

  const compras = montarCompras([ganho]);

  it("mostra o setup e a mensalidade na mesma linha", () => {
    expect(compras[0]!.recurring_value_cents).toBe(MENSALIDADE);

    render(createElement(UltimasCompras, { compras }));
    const linha = screen.getByTestId("compra-l-ganho");
    expect(linha).toHaveTextContent(/3\.000/);
    expect(linha).toHaveTextContent(/500,00\/mês/);
  });
});

describe("o agente pelo MCP", () => {
  beforeEach(() => vi.clearAllMocks());

  it("grava o recorrente e devolve os campos novos no lead", async () => {
    const db = supabaseDaEdicao(EXISTENTE);
    const mcpCtx = {
      supabase: db.cliente,
      organizationId: ORG,
      actor: { type: "agent", id: "agente-1" },
      requestId: "req-mcp-3602",
      idioma: "pt-BR",
    } as never;

    const resposta = (await crmUpdateLead.handler(
      { lead_id: LEAD, recurring_value_cents: MENSALIDADE, recurring_period: PERIODICIDADE_PADRAO },
      mcpCtx,
    )) as { lead: Record<string, unknown> };

    expect(db.atualizacoes.at(-1)!.recurring_value_cents).toBe(MENSALIDADE);
    expect(resposta.lead.recurring_value_cents).toBe(MENSALIDADE);
    expect(resposta.lead.recurring_period).toBe("monthly");
  });

  it("CONTROLE: negócio sem recorrente devolve null — não inventa mensalidade", async () => {
    const db = supabaseDaEdicao(EXISTENTE);
    const mcpCtx = {
      supabase: db.cliente,
      organizationId: ORG,
      actor: { type: "agent", id: "agente-1" },
      requestId: "req-mcp-3602b",
      idioma: "pt-BR",
    } as never;

    const resposta = (await crmUpdateLead.handler(
      { lead_id: LEAD, title: "Clínica Vida Odonto (renomeado)" },
      mcpCtx,
    )) as { lead: Record<string, unknown> };

    expect(resposta.lead.recurring_value_cents).toBeNull();
  });
});
