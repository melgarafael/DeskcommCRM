/**
 * O GATILHO POR DATA SÓ USA CAMPO DO NEGÓCIO — achado na prova do #2852
 * (@webtecnica, refs #2791).
 *
 * Um campo DATA de escopo `contato` (ex.: "Nascimento") aparecia como opção de
 * "Campo de data" no editor de regras e no Designer. A varredura
 * `lead-date-field-due` lê `crm_leads.custom_fields`, e o valor desse campo mora
 * em `contacts.custom_fields`: a regra era salva e nunca disparava. O caso
 * `a varredura só lê o NEGÓCIO` em `data-do-funil-avisa-a-regra-certa.test.ts`
 * mede a varredura; este arquivo mede as duas portas de entrada:
 *
 *  1. os seletores (RuleEditor e PainelDoGatilho do Designer, montados de
 *     verdade) não oferecem o campo do contato;
 *  2. o servidor (POST e PATCH de `/api/v1/automation-rules`) recusa a regra
 *     que chega assim pela API — ou antiga, regravada ou religada.
 *
 *     pnpm vitest run tests/unit/gatilho-por-data-so-campos-do-negocio.test.tsx
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextRequest } from "next/server";

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

const FUNIL = "ffffffff-0000-4000-8000-00000000000f";
const ORG = "22222222-2222-4222-8222-222222222222";
const REGRA = "33333333-3333-4333-8333-333333333333";

const SETTINGS = {
  fields: [
    { key: "nascimento", label: "Nascimento", type: "date", escopo: "contato" },
    { key: "entrega", label: "Entrega", type: "date", escopo: "negocio" },
    { key: "casamento", label: "Casamento", type: "date" },
  ],
};

const h = vi.hoisted(() => ({
  gravada: null as Record<string, unknown> | null,
  escreveu: false,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() },
}));
vi.mock("@/hooks/webhooks/useAutomationRules", () => ({
  useCreateAutomationRule: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useUpdateAutomationRule: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/webhooks/useWebhookSources", () => ({
  useWebhookSources: () => ({ data: { data: [] } }),
  usePipelines: () => ({
    data: { data: [{ id: FUNIL, name: "Ateliê", is_default: true, settings: SETTINGS }] },
  }),
  usePipelineStages: () => ({ data: undefined }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: () => true }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptRuleActionSecrets: async (_admin: unknown, actions: unknown) => actions,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", idioma: "pt-BR" },
    org: { orgId: ORG, role: "manager" },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      const linha = () =>
        tabela === "crm_pipelines" ? { settings: SETTINGS } : { id: REGRA, ...(h.gravada ?? {}) };
      const cadeia = {
        select: () => cadeia,
        eq: () => cadeia,
        insert: () => {
          h.escreveu = true;
          return cadeia;
        },
        update: () => {
          h.escreveu = true;
          return cadeia;
        },
        maybeSingle: async () => ({ data: linha(), error: null }),
        single: async () => ({ data: linha(), error: null }),
      };
      return cadeia;
    },
  }),
}));

import { RuleEditor } from "@/app/app/webhooks/_components/RuleEditor";
import { PainelDoGatilho } from "@/app/app/webhooks/automacoes/[id]/_components/PainelDaCaixa";
import { POST } from "@/app/api/v1/automation-rules/route";
import { PATCH } from "@/app/api/v1/automation-rules/[id]/route";
import type { AutomationRuleRow } from "@/hooks/webhooks/useAutomationRules";
import { GATILHO_DE_DATA_DO_FUNIL } from "@/lib/automation/gatilho-de-data-do-funil";
import { MENSAGEM_CAMPO_DE_DATA_DO_CONTATO } from "@/lib/automation/campo-do-gatilho-de-data";

const ACOES = [{ type: "add_tag", config: { tags: ["aviso"] } }];

function comCliente(ui: React.ReactNode) {
  const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={cliente}>{ui}</QueryClientProvider>);
}

async function opcoesDoCombobox(combobox: HTMLElement): Promise<string[]> {
  fireEvent.click(combobox);
  const lista = await screen.findByRole("listbox");
  return within(lista)
    .getAllByRole("option")
    .map((o) => o.textContent ?? "");
}

describe("os seletores de 'Campo de data' não oferecem campo do contato", () => {
  it("⭐ RuleEditor: Entrega e Casamento, nunca Nascimento", async () => {
    const regra: AutomationRuleRow = {
      id: REGRA,
      organization_id: ORG,
      name: "Avisar a entrega",
      trigger_event: GATILHO_DE_DATA_DO_FUNIL,
      conditions: [],
      actions: ACOES,
      trigger_config: { pipeline_id: FUNIL, campo: "entrega", dias: 3 },
      is_active: false,
      last_run_at: null,
      run_count: 0,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      last_change_actor_kind: null,
      last_change_at: null,
    };
    comCliente(<RuleEditor open onOpenChange={vi.fn()} rule={regra} />);

    const combobox = (await screen.findAllByRole("combobox")).find((c) =>
      (c.textContent ?? "").includes("Entrega"),
    );
    expect(combobox, "o select do campo de data não apareceu com o campo gravado").toBeDefined();
    const opcoes = await opcoesDoCombobox(combobox!);

    expect(opcoes).toEqual(["Entrega", "Casamento"]);
  });

  it("⭐ Designer (PainelDoGatilho): Entrega e Casamento, nunca Nascimento", async () => {
    comCliente(
      <PainelDoGatilho
        dados={{
          kind: "gatilho",
          evento: GATILHO_DE_DATA_DO_FUNIL,
          tela: {
            fonte: null,
            data: { pipeline_id: FUNIL, campo: "", dias: "3" },
            tempo: { dias: "7", direcao: "da_equipe", proteger_pela_agenda: false },
          },
        }}
        onEvento={vi.fn()}
        onTela={vi.fn()}
      />,
    );

    const opcoes = await opcoesDoCombobox(screen.getByRole("combobox", { name: "Campo de data" }));

    expect(opcoes).toEqual(["Entrega", "Casamento"]);
  });
});

describe("o servidor recusa o gatilho por data num campo do contato", () => {
  beforeEach(() => {
    h.gravada = null;
    h.escreveu = false;
  });

  function criar(campo: string) {
    return POST(
      new NextRequest("https://crm.exemplo/api/v1/automation-rules", {
        method: "POST",
        body: JSON.stringify({
          name: "Aniversário",
          trigger_event: GATILHO_DE_DATA_DO_FUNIL,
          conditions: [],
          actions: ACOES,
          trigger_config: { pipeline_id: FUNIL, campo, dias: 0 },
        }),
      }),
    );
  }

  function atualizar(corpo: unknown) {
    return PATCH(
      new NextRequest(`https://crm.exemplo/api/v1/automation-rules/${REGRA}`, {
        method: "PATCH",
        body: JSON.stringify(corpo),
      }),
      { params: Promise.resolve({ id: REGRA }) },
    );
  }

  it("⭐ POST com campo do contato: 422 com a frase legível, nada gravado", async () => {
    const res = await criar("nascimento");
    const corpo = (await res.json()) as { error: { message: string } };

    expect(res.status).toBe(422);
    expect(corpo.error.message).toBe(MENSAGEM_CAMPO_DE_DATA_DO_CONTATO);
    expect(h.escreveu).toBe(false);
  });

  it("controle: POST com campo do negócio (declarado ou sem escopo) passa", async () => {
    expect((await criar("entrega")).status).toBe(201);
    expect((await criar("casamento")).status).toBe(201);
  });

  it("⭐ PATCH: religar regra antiga apontada para o contato é recusado", async () => {
    h.gravada = {
      trigger_event: GATILHO_DE_DATA_DO_FUNIL,
      trigger_config: { pipeline_id: FUNIL, campo: "nascimento", dias: 0 },
      actions: ACOES,
    };
    const res = await atualizar({ is_active: true });

    expect(res.status).toBe(422);
    expect(h.escreveu).toBe(false);
  });

  it("⭐ PATCH: trocar o campo para um do contato é recusado", async () => {
    h.gravada = {
      trigger_event: GATILHO_DE_DATA_DO_FUNIL,
      trigger_config: { pipeline_id: FUNIL, campo: "entrega", dias: 0 },
      actions: ACOES,
    };
    const res = await atualizar({ trigger_config: { pipeline_id: FUNIL, campo: "nascimento", dias: 0 } });

    expect(res.status).toBe(422);
    expect(h.escreveu).toBe(false);
  });

  it("controle: desligar a regra antiga não é barrado", async () => {
    h.gravada = {
      trigger_event: GATILHO_DE_DATA_DO_FUNIL,
      trigger_config: { pipeline_id: FUNIL, campo: "nascimento", dias: 0 },
      actions: ACOES,
    };
    const res = await atualizar({ is_active: false });

    expect(res.status).toBe(200);
    expect(h.escreveu).toBe(true);
  });
});
