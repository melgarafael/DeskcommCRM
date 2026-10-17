/**
 * O CAMPO É DO CONTATO OU DO NEGÓCIO (issue #2791).
 *
 * A definição mora no funil (`crm_pipelines.settings.fields[]`), mas o VALOR
 * tem dois donos: campo do negócio é gravado em `crm_leads.custom_fields` e
 * aparece no card e no dossiê; campo do contato é gravado em
 * `contacts.custom_fields` e aparece só na ficha do contato. Antes desta
 * propriedade o operador via os MESMOS campos nos dois lugares, digitava num e
 * o card não lia.
 *
 * Este teste prova os dois sentidos sobre os componentes REAIS: a lista que a
 * ficha do contato recebe não traz campo do negócio, e a lista que o card
 * recebe não traz campo do contato. A fiação — qual escopo cada tela pede — é
 * lida da fonte, porque é onde a decisão foi tomada.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { camposDoFunil, camposPorEscopo } from "@/lib/leads/campos-do-funil";

vi.mock("@/hooks/auth/AuthProvider", () => ({ useActiveOrg: () => ({ country: null }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { CustomFieldsEditor } from "@/components/contacts/CustomFieldsEditor";

const RAIZ = process.cwd();
const fonte = (arquivo: string) => readFileSync(join(RAIZ, arquivo), "utf8");

/** Um funil com os três estados: campo do contato, do negócio e sem escopo. */
const SETTINGS = {
  fields: [
    { key: "cor_favorita", label: "Cor favorita", type: "text", escopo: "contato" },
    { key: "prazo_do_negocio", label: "Prazo do negócio", type: "date", escopo: "negocio" },
    { key: "endereco_de_sempre", label: "Endereço de sempre", type: "text" },
  ],
};

afterEach(cleanup);

describe("o campo de contato não vaza para o card (issue #2791)", () => {
  it("a ficha do contato mostra o campo do contato e NÃO os do negócio", () => {
    render(
      <CustomFieldsEditor
        mode="contact"
        fields={camposPorEscopo(camposDoFunil(SETTINGS), "contato")}
        value={{}}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("Cor favorita")).toBeTruthy();
    expect(screen.queryByText("Prazo do negócio")).toBeNull();
    // Sem escopo é do NEGÓCIO — o comportamento de sempre: não entra na ficha.
    expect(screen.queryByText("Endereço de sempre")).toBeNull();
  });

  it("o card/dossiê mostra os campos do negócio (com e sem escopo) e NÃO o do contato", () => {
    render(
      <CustomFieldsEditor
        mode="lead"
        fields={camposPorEscopo(camposDoFunil(SETTINGS), "negocio")}
        value={{}}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("Prazo do negócio")).toBeTruthy();
    expect(screen.getByText("Endereço de sempre")).toBeTruthy();
    expect(screen.queryByText("Cor favorita")).toBeNull();
  });
});

describe("a fiação: cada tela pede o escopo certo (issue #2791)", () => {
  it("a ficha do contato filtra por `contato`", () => {
    const arquivo = fonte("app/app/contacts/[id]/_client.tsx");
    expect(arquivo).toContain('camposPorEscopo(');
    expect(arquivo).toContain('"contato"');
  });

  it("o card do quadro, o calendário e o resumo da inbox filtram por `negocio`", () => {
    for (const arquivo of [
      "components/kanban/KanbanBoard.tsx",
      "components/kanban/CalendarioDoFunil.tsx",
      "app/api/v1/contacts/[id]/crm-summary/route.ts",
    ]) {
      const texto = fonte(arquivo);
      expect(texto).toContain("camposPorEscopo(");
      expect(texto).toContain('"negocio"');
    }
  });
});
