// O TOTAL DA COLUNA DO FUNIL SAI NA MOEDA DOS LEADS, NÃO SEMPRE EM REAL.
//
// `StageColumn` tinha a sexta cópia do formatador de dinheiro do produto —
// `formatBRL`, com locale e moeda escritos em duro:
//
//     new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", ... })
//
// e a moeda em duro é justamente o que a cópia escondia. Numa organização que
// opera em peso ou dólar o número do topo da coluna estava certo e o símbolo
// mentia — `R$ 250` para R$ nenhum. É o mesmo defeito que o catálogo de
// produtos já tinha pago (`tests/unit/catalogo-preco-na-moeda-da-loja.test.tsx`)
// e pelo qual `formatCents` existe.
//
// Reverter para um formatador local com `"BRL"` dentro faz este arquivo ficar
// vermelho.

import { render, screen } from "@testing-library/react";
import { DragDropContext } from "@hello-pangea/dnd";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
// O CARTÃO não é o assunto: ele arrasta react-query, AuthProvider e as
// mutações de ganhar/perder atrás de si. O que se mede aqui é a FAIXA DE
// TOTAL no topo da coluna, que não depende de nada disso.
vi.mock("@/components/kanban/KanbanCard", () => ({
  KanbanCard: ({ lead }: { lead: { id: string } }) => <div data-testid={`cartao-${lead.id}`} />,
}));

import { StageColumn } from "@/components/kanban/StageColumn";
import type { Lead } from "@/lib/types/leads";
import type { Stage } from "@/lib/kanban/types";

/** Os espaços que o `Intl` emite são NBSP (U+00A0) ou narrow NBSP (U+202F). */
const semNbsp = (s: string) => s.replace(/[  ]/g, " ");

const etapa = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  pipeline_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Em negociação",
  position: 1,
  color: null,
} as unknown as Stage;

function lead(over: Partial<Lead>): Lead {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pipeline_id: etapa.pipeline_id,
    stage_id: etapa.id,
    title: "Negócio",
    description: null,
    contact_id: null,
    value_cents: 24990,
    currency: "BRL",
    owner_user_id: null,
    owner_agent_id: null,
    owner_kind: null,
    status: "open",
    tags: [],
    position_in_stage: 1000,
    created_at: "2026-09-01T12:00:00Z",
    updated_at: "2026-09-01T12:00:00Z",
    ...over,
  } as unknown as Lead;
}

function montar(leads: Lead[], stage: Stage = etapa) {
  return render(
    <DragDropContext onDragEnd={() => {}}>
      <StageColumn stage={stage} leads={leads} pipelineId={etapa.pipeline_id} />
    </DragDropContext>,
  );
}

describe("total da coluna do funil", () => {
  it("escreve o total na moeda dos leads da coluna", () => {
    montar([lead({ id: "l1", currency: "MXN", value_cents: 24990 })]);

    const total = screen.getByText((texto) => semNbsp(texto).includes("249.90"));
    expect(semNbsp(total.textContent ?? "")).toBe("$249.90");
    // O controle que separa "respeita a moeda" de "mudou de formatador":
    // em peso não pode sobrar nada de real na tela.
    expect(document.body.textContent).not.toContain("R$");
  });

  it("em real continua saindo em real", () => {
    montar([lead({ id: "l2", currency: "BRL", value_cents: 24990 })]);

    const total = screen.getByText((texto) => semNbsp(texto).includes("249,90"));
    expect(semNbsp(total.textContent ?? "")).toBe("R$ 249,90");
  });

  it("⭐ em guarani soma certo: dois pedidos de ₲125.000 dão ₲250.000, não Gs. 25.000.000", () => {
    // O negócio guarda ×100 em QUALQUER moeda (12.500.000 = ₲125.000); o PYG não
    // tem subunidade, e passar a soma direto a `formatCents` a mostrava cem vezes
    // maior — medido numa instalação real. Ver `formatValorDoNegocio`.
    montar([
      lead({ id: "p1", currency: "PYG", value_cents: 12_500_000 }),
      lead({ id: "p2", currency: "PYG", value_cents: 12_500_000 }),
    ]);

    const total = screen.getByText((texto) => semNbsp(texto).includes("Gs."));
    expect(semNbsp(total.textContent ?? "")).toBe("Gs. 250.000");
  });

  it("⭐ em guarani o ponderado da etapa calibrada usa a mesma régua do total", () => {
    // A linha "ponderado" (#1535) também soma `value_cents` (×100). Com
    // `formatCents` ela sairia "Gs. 12.500.000" ao lado de um total certo.
    montar(
      [
        lead({ id: "g1", currency: "PYG", value_cents: 12_500_000 }),
        lead({ id: "g2", currency: "PYG", value_cents: 12_500_000 }),
      ],
      { ...etapa, win_probability: 50 } as Stage,
    );

    const ponderado = screen.getByText((texto) => semNbsp(texto).includes("ponderado"));
    expect(semNbsp(ponderado.textContent ?? "")).toBe("· ponderado Gs. 125.000");
    expect(semNbsp(ponderado.parentElement?.textContent ?? "")).toBe(
      "Gs. 250.000· ponderado Gs. 125.000",
    );
  });

  it("a moeda vem do primeiro lead COM valor, ignorando os sem valor", () => {
    montar([
      lead({ id: "l3", currency: "BRL", value_cents: null }),
      lead({ id: "l4", currency: "USD", value_cents: 10000 }),
    ]);

    const total = screen.getByText((texto) => semNbsp(texto).includes("100.00"));
    expect(semNbsp(total.textContent ?? "")).toBe("$100.00");
  });
});
