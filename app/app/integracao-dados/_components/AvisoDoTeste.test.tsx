import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));

import {
  AVISO_ESCRITA,
  AVISO_LEITURA_AMPLA,
  AVISO_ROLE,
  AVISO_SEM_CONFERIR,
} from "@/lib/external-db/dialetos/mysql/grants";

import { AvisoDoTeste } from "./AvisoDoTeste";

describe("AvisoDoTeste", () => {
  it("sem aviso, não renderiza nada", () => {
    const { container } = render(<AvisoDoTeste aviso={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("cada frase conhecida vira uma linha própria, na ordem do servidor", () => {
    render(<AvisoDoTeste aviso={`${AVISO_ESCRITA} ${AVISO_LEITURA_AMPLA}`} />);
    expect(screen.getByText(AVISO_ESCRITA)).toBeTruthy();
    expect(screen.getByText(AVISO_LEITURA_AMPLA)).toBeTruthy();
    expect(screen.queryByText(AVISO_ROLE)).toBeNull();
    expect(screen.queryByText(AVISO_SEM_CONFERIR)).toBeNull();
  });

  it("as quatro frases juntas aparecem as quatro", () => {
    render(<AvisoDoTeste aviso={[AVISO_ESCRITA, AVISO_LEITURA_AMPLA, AVISO_ROLE, AVISO_SEM_CONFERIR].join(" ")} />);
    for (const frase of [AVISO_ESCRITA, AVISO_LEITURA_AMPLA, AVISO_ROLE, AVISO_SEM_CONFERIR]) {
      expect(screen.getByText(frase)).toBeTruthy();
    }
  });

  it("texto que não é nenhuma frase conhecida aparece como veio (nunca some em silêncio)", () => {
    render(<AvisoDoTeste aviso="algo que o servidor disse" />);
    expect(screen.getByText("algo que o servidor disse")).toBeTruthy();
  });
});
