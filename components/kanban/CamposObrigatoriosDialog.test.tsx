/**
 * O DIÁLOGO DO ARRASTO QUANDO A ETAPA VENCE A CONDIÇÃO (#3036).
 *
 * O caso que este teste trava: um campo escondido pela condição de exibição e
 * exigido pela etapa de destino chega no 422 `required_fields_missing`. Sem a
 * frase, o diálogo pediria um campo que a ficha do negócio esconde — o bloqueio
 * sem explicação que a composição das duas réguas existe para evitar.
 *
 * O controle é o outro lado: campo exigido só pela condição (ou pela etapa, sem
 * condição) NÃO ganha a frase. Ela fala de um conflito, e inventá-lo onde não há
 * ensinaria a pessoa a duvidar do aviso.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CamposObrigatoriosDialog } from "./CamposObrigatoriosDialog";
import type { RecusaDeCampos } from "@/hooks/kanban/useMoveCard";

vi.mock("@/hooks/i18n/useT", () => ({
  useT: () => (texto: string) => texto,
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useMoedaDaOrgAtiva: () => "BRL",
}));
vi.mock("@/components/kanban/FileUploadCustomField", () => ({
  FileUploadCustomField: () => null,
}));

afterEach(cleanup);

const FRASE =
  "A etapa de destino exige este campo, mesmo que a condição de exibição o esconda — por isso ele aparece aqui.";

function recusa(faltando: RecusaDeCampos["faltando"]): RecusaDeCampos {
  return { args: { leadId: "lead-1", stageId: "etapa-1" } as RecusaDeCampos["args"], faltando };
}

describe("CamposObrigatoriosDialog — o campo que a etapa exige apesar da condição", () => {
  it("campo marcado como exigido pela etapa aparece com a explicação", () => {
    render(
      <CamposObrigatoriosDialog
        open
        onOpenChange={vi.fn()}
        recusa={recusa([
          {
            chave: "condicao_pagamento",
            rotulo: "Condição de pagamento",
            tipo: "text",
            exigido_pela_etapa: true,
          },
        ])}
        onConfirmar={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Condição de pagamento")).toBeTruthy();
    expect(screen.getByText(FRASE)).toBeTruthy();
  });

  it("campo comum não ganha a frase (controle)", () => {
    render(
      <CamposObrigatoriosDialog
        open
        onOpenChange={vi.fn()}
        recusa={recusa([{ chave: "concorrente", rotulo: "Concorrente", tipo: "text" }])}
        onConfirmar={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Concorrente")).toBeTruthy();
    expect(screen.queryByText(FRASE)).toBeNull();
  });
});
