import { useState } from "react";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BasesDoAgente } from "@/app/app/ai/agents/[id]/_components/BasesDoAgente";
import type { MaterialDoAcervo } from "@/app/app/ai/agents/[id]/_components/BasesDoAgente";

/**
 * MATERIAL ARQUIVADO E MESMO ASSIM MARCADO (issue #774).
 *
 * Furar isto TRAVA o agente: o id arquivado continua em
 * `knowledge_source_ids`, o salvar recusa a versão com "Um dos materiais
 * marcados não existe mais, ou foi arquivado" e o dono não tem onde desmarcar —
 * a seção recebia o acervo já filtrado por `is_active` e o id marcado não tinha
 * caixinha nenhuma. O vínculo material-agente NÃO pode impedir o arquivamento;
 * quem arquiva está certo. Por isso:
 *
 *  - arquivado E marcado APARECE, com selo e com o desmarcar a um clique;
 *  - arquivado E NÃO marcado continua fora da lista;
 *  - arquivado não conta como material do assistente em nenhum aviso.
 *
 * A coluna `is_active` só chega para quem está marcado e fora da lista viva (a
 * página busca por `.in("id", ...)` nesse caso); por isso AUSENTE é material
 * vivo, nunca arquivado.
 */
function material(parcial: Partial<MaterialDoAcervo> & { id: string }): MaterialDoAcervo {
  return {
    name: parcial.id,
    source_type: "text",
    chunks_count: 3,
    last_index_status: "ready",
    ...parcial,
  };
}

const VIVO = material({ id: "mat-vivo", name: "Política de troca" });
const ARQUIVADO = material({
  id: "mat-arquivado",
  name: "Tabela de preços antiga",
  is_active: false,
});

/** Bancada com estado de verdade: desmarcar tem que refletir na tela. */
function Bancada({ materiais, iniciais }: { materiais: MaterialDoAcervo[]; iniciais: string[] }) {
  const [value, setValue] = useState(iniciais);
  return <BasesDoAgente materiais={materiais} value={value} onChange={setValue} />;
}

describe("material arquivado marcado no agente", () => {
  it("arquivado e marcado continua na lista, com selo de arquivado", () => {
    render(<Bancada materiais={[VIVO, ARQUIVADO]} iniciais={[ARQUIVADO.id]} />);

    expect(screen.getByTestId(`base-${ARQUIVADO.id}`)).toBeChecked();
    expect(screen.getByTestId(`base-${ARQUIVADO.id}-arquivado`)).toBeInTheDocument();
  });

  it("desmarcar pela caixinha destrava o salvamento", () => {
    render(<Bancada materiais={[VIVO, ARQUIVADO]} iniciais={[VIVO.id, ARQUIVADO.id]} />);

    expect(screen.getByTestId("agente-base-arquivada-marcada")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`base-${ARQUIVADO.id}`));

    // Desmarcado, ele sai da lista — é a mesma régua do "arquivado que ninguém marcou".
    expect(screen.queryByTestId(`base-${ARQUIVADO.id}`)).toBeNull();
    expect(screen.getByTestId(`base-${VIVO.id}`)).toBeChecked();
    expect(screen.queryByTestId("agente-base-arquivada-marcada")).toBeNull();
  });

  it("o atalho de desmarcar limpa a marcação do arquivado sem perder o resto", () => {
    render(<Bancada materiais={[VIVO, ARQUIVADO]} iniciais={[VIVO.id, ARQUIVADO.id]} />);

    fireEvent.click(screen.getByTestId("agente-base-arquivada-desmarcar"));

    expect(screen.getByTestId(`base-${VIVO.id}`)).toBeChecked();
    // Só o arquivado sai: a marcação do vivo fica onde estava.
    expect(screen.queryByTestId(`base-${ARQUIVADO.id}`)).toBeNull();
    expect(screen.queryByTestId("agente-base-arquivada-marcada")).toBeNull();
  });

  it("arquivado que ninguém marcou não entra na lista", () => {
    render(<Bancada materiais={[VIVO, ARQUIVADO]} iniciais={[VIVO.id]} />);

    expect(screen.getByTestId(`base-${VIVO.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`base-${ARQUIVADO.id}`)).toBeNull();
  });

  it("acervo só de arquivado não vira acervo todo de fora", () => {
    render(<Bancada materiais={[ARQUIVADO]} iniciais={[]} />);

    expect(screen.getByTestId("agente-sem-acervo")).toBeInTheDocument();
    expect(screen.queryByTestId("agente-acervo-de-fora")).toBeNull();
  });

  it("material vivo (sem a coluna) continua marcável e sem selo", () => {
    render(<Bancada materiais={[VIVO]} iniciais={[]} />);

    expect(screen.getByTestId(`base-${VIVO.id}`)).not.toBeChecked();
    expect(screen.queryByTestId(`base-${VIVO.id}-arquivado`)).toBeNull();

    expect(screen.getByTestId("agente-sem-base-marcada")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`base-${VIVO.id}`));

    expect(screen.getByTestId(`base-${VIVO.id}`)).toBeChecked();
    // O aviso é do estado "nada marcado" — ele sai quando a marcação entra.
    expect(screen.queryByTestId("agente-sem-base-marcada")).toBeNull();
  });
});
