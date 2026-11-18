/**
 * O FUNIL ARQUIVADO É ABRÍVEL — E ABRIR NÃO É ESCREVER (issue #1298, item 1).
 *
 * Medido em `main@a7c8b4119`, renderizando esta tela: na gaveta "Funis
 * arquivados" o nome do funil sai num `<span>` (sem `href`), enquanto na lista
 * viva sai num `Link` para `/app/pipelines/<id>`. Quem tem dois funis
 * arquivados e precisa escolher entre "tirar do arquivo" e "excluir de vez"
 * decide SEM poder olhar o que tem dentro — o único caminho era desarquivar,
 * abrir e arquivar de novo: três escritas e duas linhas de auditoria para uma
 * leitura, e a segunda escrita é a que se esquece.
 *
 * O `it` abaixo cai se o link sumir: ele é o contrato do gesto de leitura.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FunisClient, type FunilDaLista } from "@/app/app/kanban/_client";

const mocks = vi.hoisted(() => ({
  criar: vi.fn(),
  editar: vi.fn(),
  arquivar: vi.fn(),
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({
    orgId: "org-1",
    name: "Clínica",
    role: "admin",
    cliente_pela_agenda: false,
  }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/hooks/pipelines/usePipelines", () => ({
  useCriarFunil: () => ({ isPending: false, mutate: mocks.criar }),
  useEditarFunil: () => ({ isPending: false, mutate: mocks.editar }),
  useArquivarFunil: () => ({ isPending: false, mutate: mocks.arquivar }),
}));
vi.mock("@/app/app/kanban/_components/ImportarLeads", () => ({ ImportarLeads: () => null }));

const ARQUIVADO: FunilDaLista = {
  id: "funil-velho",
  name: "Comercial 2025",
  slug: "comercial-2025",
  description: null,
  position: 1,
  is_default: false,
};

function comQuery(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("abrir um funil arquivado (#1298, item 1)", () => {
  it("o nome do funil arquivado leva ao quadro dele, sem passar pelo arquivo", async () => {
    const user = userEvent.setup();
    render(
      comQuery(<FunisClient funis={[]} arquivados={[ARQUIVADO]} podeGerenciar podeImportar />),
    );

    await user.click(screen.getByTestId("arquivados-abrir"));

    const link = screen.getByTestId(`abrir-arquivado-${ARQUIVADO.id}`);
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", `/app/pipelines/${ARQUIVADO.id}`);
    // Abrir é LEITURA: nenhuma das três escritas do caminho antigo sai do clique
    // (desarquivar, arquivar de novo, trocar de padrão).
    await user.click(link);
    expect(mocks.arquivar).not.toHaveBeenCalled();
    expect(mocks.editar).not.toHaveBeenCalled();
    expect(mocks.criar).not.toHaveBeenCalled();
  });

  it("a gaveta diz que abrir é só leitura, para o clique não parecer desarquivar", async () => {
    const user = userEvent.setup();
    render(
      comQuery(<FunisClient funis={[]} arquivados={[ARQUIVADO]} podeGerenciar podeImportar />),
    );

    await user.click(screen.getByTestId("arquivados-abrir"));

    expect(screen.getByTestId("arquivados-explicacao").textContent).toMatch(/leitura/i);
  });
});
