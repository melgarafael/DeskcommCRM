import { render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

// A URL da tela. `modelo=<id>` é o link direto que a integração devolve —
// "use o modelo X" — e sem ele quem recebe cai na lista e tem de caçar de qual
// texto se falava.
let busca = "";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(busca),
}));

vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  // A chave é exportada pelo módulo real e usada pela tela e pela mutação de
  // ordem (#3244): sem ela aqui, o import da tela quebra antes de renderizar.
  CHAVE_DOS_TEMPLATES: ["message-templates"],
  CHAVE_DOS_GRUPOS: ["message-template-groups"],
  useMoverTemplate: () => ({ mutate: vi.fn(), isPending: false }),
  // A reordenação de GRUPO (#3245) — sem grupo, a tela não a chama.
  useMoverGrupo: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  // Sem grupo (#3245): a tela cai na lista plana, o caminho destes casos.
  useGruposDeRespostas: () => ({ data: [] }),
  useMessageTemplates: () => ({
    data: [
      { id: "1", title: "Meu Pessoal", body: "Oi {{primeiro_nome}}", shortcut: "oi", owner_user_id: "u1" },
      { id: "2", title: "Política da Equipe", body: "Política de troca", shortcut: null, owner_user_id: null },
      { id: "3", title: "Pessoal do Outro", body: "Segredo do colega", shortcut: null, owner_user_id: "u2" },
      {
        id: "4",
        title: "Áudio Boas-vindas",
        body: "",
        shortcut: null,
        owner_user_id: null,
        midias: [{ storage_path: "org/templates/4/a.ogg", media_mime: "audio/ogg", media_size_bytes: 10 }],
      },
      {
        id: "5",
        title: "Tabela",
        body: "Olha a tabela",
        shortcut: null,
        owner_user_id: null,
        midias: [{ storage_path: "org/templates/5/b.png", media_mime: "image/png", media_size_bytes: 10 }],
      },
    ],
    isLoading: false,
  }),
}));

import { TemplatesClient } from "@/app/app/templates/_components/TemplatesClient";

function wrap(ui: React.ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;
}

describe("TemplatesClient", () => {
  it("lista templates e abre o form de novo", () => {
    busca = "";
    render(wrap(<TemplatesClient canShare={true} currentUserId="u1" />));
    expect(screen.getByText("Meu Pessoal")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /nova resposta rápida/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("⭐ /app/templates?modelo=<id> abre aquele modelo, já preenchido", () => {
    busca = "modelo=2";
    render(wrap(<TemplatesClient canShare={true} currentUserId="u1" />));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Política da Equipe")).toBeInTheDocument();
    busca = "";
  });

  it("id que não existe na lista não abre nada sozinho", () => {
    busca = "modelo=nao-existe";
    render(wrap(<TemplatesClient canShare={true} currentUserId="u1" />));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    busca = "";
  });

  it("agent com o link de um COMPARTILHADO fica na lista: o form de edição não abre", () => {
    // A RLS (message_templates_write) só deixa manager+ alterar o compartilhado;
    // abrir o form aqui seria um Salvar que devolve "Template não encontrado.".
    busca = "modelo=2";
    render(wrap(<TemplatesClient canShare={false} currentUserId="u1" />));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("Política da Equipe")).toBeInTheDocument();
    busca = "";
  });

  it("agent com o link do PRÓPRIO pessoal abre a edição", () => {
    busca = "modelo=1";
    render(wrap(<TemplatesClient canShare={false} currentUserId="u1" />));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Meu Pessoal")).toBeInTheDocument();
    busca = "";
  });

  it("agent (não-manager) só vê ações no próprio pessoal, não no compartilhado nem no de outro", () => {
    busca = "";
    render(wrap(<TemplatesClient canShare={false} currentUserId="u1" />));
    // 5 templates listados, mas só 1 editável → 1 par de ações editar/excluir.
    expect(screen.getByText("Meu Pessoal")).toBeInTheDocument();
    expect(screen.getByText("Política da Equipe")).toBeInTheDocument();
    expect(screen.getByText("Pessoal do Outro")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Editar resposta rápida" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Excluir resposta rápida" })).toHaveLength(1);
  });

  it("manager vê ações no próprio E no compartilhado, mas não no pessoal de outro", () => {
    busca = "";
    render(wrap(<TemplatesClient canShare={true} currentUserId="u1" />));
    // próprio (u1) + 3 compartilhados (null) editáveis; pessoal de u2 não → 4 pares.
    expect(screen.getAllByRole("button", { name: "Editar resposta rápida" })).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: "Excluir resposta rápida" })).toHaveLength(4);
  });

  it("recurso de áudio leva o selo 🎧 e NÃO o de imagens; o de imagem leva o de imagens", () => {
    busca = "";
    render(wrap(<TemplatesClient canShare={true} currentUserId="u1" />));
    const itemDe = (titulo: string) => screen.getByText(titulo).closest("li") as HTMLElement;

    expect(within(itemDe("Áudio Boas-vindas")).getByText(/Áudio$/)).toBeInTheDocument();
    expect(within(itemDe("Áudio Boas-vindas")).queryByText(/Imagens/)).toBeNull();
    expect(within(itemDe("Tabela")).getByText(/Imagens/)).toBeInTheDocument();
  });
});
