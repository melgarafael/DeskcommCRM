/**
 * #3974 — o editor reabre com a opção "Enviar com a conversa atribuída" como
 * ela está NO BANCO.
 *
 * O defeito, medido pela tela (prova do #4053): a página montava o
 * `initialData` com uma lista de colunas própria, sem `send_when_assigned`. O
 * `useFollowupFlow` não refaz a leitura por cima do `initialData`, então o
 * switch reabria DESLIGADO com o banco LIGADO — e o primeiro clique em
 * "desligar" mandava `true`.
 *
 * O dublê do banco PROJETA as colunas pedidas no `select`: coluna que a página
 * não pede não chega, como no PostgREST. Um dublê que devolvesse a linha
 * inteira passaria com a página quebrada.
 */
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { FollowupFlowDetailRow } from "@/hooks/followup/useFollowupFlow";

const ORG = "00000000-0000-4000-8000-000000000001";
const ID = "00000000-0000-4000-8000-0000000000f1";

const LINHA_NO_BANCO: Record<string, unknown> = {
  id: ID,
  organization_id: ORG,
  name: "Retomada",
  status: "draft",
  active_version_id: null,
  draft_graph: { nodes: [], edges: [] },
  handoff_policy: "pause",
  send_when_assigned: true,
  trigger_config: {},
  surface: "followup",
  created_at: "2026-11-05T00:00:00.000Z",
  updated_at: "2026-11-05T00:00:00.000Z",
};

function projetar(colunas: string, linha: Record<string, unknown>) {
  return Object.fromEntries(colunas.split(",").map((c) => c.trim()).map((c) => [c, linha[c]]));
}

function supabaseFake() {
  return {
    from(tabela: string) {
      let colunas = "*";
      const diferentes: Array<[string, unknown]> = [];
      const chain = {
        select(c: string) {
          colunas = c;
          return chain;
        },
        eq: () => chain,
        neq: (c: string, v: unknown) => {
          diferentes.push([c, v]);
          return chain;
        },
        order: () => chain,
        maybeSingle: async () => ({
          data:
            tabela === "followup_flow_pointers" && diferentes.every(([c, v]) => LINHA_NO_BANCO[c] !== v)
              ? projetar(colunas, LINHA_NO_BANCO)
              : null,
          error: null,
        }),
        then: (ok: (r: { data: unknown[]; error: null }) => unknown) => ok({ data: [], error: null }),
      };
      return chain;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => supabaseFake() }));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: async () => ({ id: "u1" }),
  resolveActiveOrg: async () => ({ orgId: ORG, role: "manager" }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: (p: string) => {
    throw new Error(`redirect ${p}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/hooks/followup/useFollowupFlow", () => {
  const mutacao = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    useDeleteFollowupFlow: mutacao,
    useDisableFollowupFlow: mutacao,
    usePublishFollowupFlow: mutacao,
    useRenameFollowupFlow: mutacao,
    useRollbackFollowupFlow: mutacao,
    useSaveFollowupFlowDraft: mutacao,
    useUpdateHandoffPolicy: mutacao,
    useUpdateSendWhenAssigned: mutacao,
  };
});
vi.mock("./_components/TriggerConfigControl", () => ({ TriggerConfigControl: () => null }));
// O canvas (XYFlow) não renderiza em jsdom; a barra é quem mostra a opção, e
// ela recebe o MESMO `initialData` que a página entregaria ao construtor.
vi.mock("./_components/FlowBuilder", async () => {
  const { PublishBar } = await import("./_components/PublishBar");
  return {
    FlowBuilder: ({ flowId, initialData }: { flowId: string; initialData: FollowupFlowDetailRow }) => (
      <PublishBar
        flowId={flowId}
        flow={initialData}
        graph={{ nodes: [], edges: [] }}
        dirty={false}
        selection={null}
        onDeleteSelection={() => {}}
        onSaved={() => {}}
        onPublishErrors={() => {}}
        onPublishSuccess={() => {}}
        canAutoFit={false}
      />
    ),
  };
});

import FollowupFlowBuilderPage from "./page";

describe("editor de follow-up — reabrir mostra a opção como está no banco", () => {
  it("fluxo com send_when_assigned=true abre com o switch LIGADO", async () => {
    const pagina = (await FollowupFlowBuilderPage({ params: Promise.resolve({ id: ID }) })) as ReactElement;
    render(pagina);

    expect(screen.getByTestId("send-when-assigned")).toHaveAttribute("aria-checked", "true");
  });

  it("roteiro de atendimento não abre no editor de follow-up", async () => {
    LINHA_NO_BANCO.surface = "atendimento";
    try {
      await expect(FollowupFlowBuilderPage({ params: Promise.resolve({ id: ID }) })).rejects.toThrow("notFound");
    } finally {
      LINHA_NO_BANCO.surface = "followup";
    }
  });
});
