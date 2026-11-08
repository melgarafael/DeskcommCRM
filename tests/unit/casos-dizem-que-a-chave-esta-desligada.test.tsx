import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type * as UseCasesModule from "@/hooks/ai/useCases";

import type { AvisoDeVazioDeCasos } from "@/lib/ai/cases/liberacao-de-casos";

const useCasesMock = vi.fn();
vi.mock("@/hooks/ai/useCases", async () => {
  const actual = await vi.importActual<typeof UseCasesModule>("@/hooks/ai/useCases");
  return { ...actual, useCases: (...args: unknown[]) => useCasesMock(...args) };
});

// CaseDetail é testado à parte; aqui só a lista importa.
vi.mock("@/app/app/ai/cases/_components/CaseDetail", () => ({
  CaseDetail: () => null,
}));

import { CaseList } from "@/app/app/ai/cases/_components/CaseList";

function wrap(ui: React.ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;
}

function filaVazia() {
  useCasesMock.mockReturnValue({ isLoading: false, data: { open_count: 0, cases: [] } });
}

function filaComCaso() {
  useCasesMock.mockReturnValue({
    isLoading: false,
    data: {
      open_count: 1,
      cases: [
        {
          id: "case-1",
          title: "Cliente pede desconto acima do permitido",
          summary: "Quer 30% de desconto",
          blocker: "Fora da política de descontos",
          status: "awaiting_human",
          opened_at: new Date().toISOString(),
          contact_id: "contact-1",
          conversation_id: "conv-1",
          contact_name: "Maria Silva",
          contact_phone: "+551****0000",
        },
      ],
    },
  });
}

const DESLIGADO: AvisoDeVazioDeCasos = {
  motivo: "chave_desligada",
  href: "/app/ai/agents/ag-1#cases_enabled",
  alvo: "agente",
  podeEditar: true,
};

describe("Casos — a tela vazia explica por que está vazia", () => {
  /**
   * RED do defeito #3975: com a chave desligada, a tela dizia apenas "Nenhum
   * caso aberto / Quando a IA precisar de você, aparece aqui." — indistinguível
   * de "a chave está ligada e ninguém pediu nada ainda".
   */
  it("chave desligada: nomeia a opção, diz o motivo e leva ao cartão do agente", () => {
    filaVazia();
    render(wrap(<CaseList aviso={DESLIGADO} />));

    const bloco = screen.getByTestId("casos-sem-chave");
    expect(bloco).toHaveTextContent(/Nenhum agente está liberado para abrir casos/i);
    // O NOME do recurso, como está no cartão do agente — é o que a pessoa
    // precisa procurar quando abrir o formulário.
    expect(bloco).toHaveTextContent(/Deixar o agente pedir uma tarefa a alguém e seguir conversando/);
    expect(bloco).toHaveTextContent(/Pedir ajuda sem sair da conversa/);
    // O MOTIVO, dito por extenso.
    expect(bloco).toHaveTextContent(/está desligada/);

    // O LINK, para o cartão onde se liga (o `id` do Switch em AgentForm).
    const link = within(bloco).getByRole("link", { name: "Abrir o agente" });
    expect(link).toHaveAttribute("href", "/app/ai/agents/ag-1#cases_enabled");

    // E o vazio genérico NÃO aparece ao lado: uma tela, uma explicação.
    expect(screen.queryByText("Nenhum caso aberto")).not.toBeInTheDocument();
  });

  it("chave ligada e nenhum caso: estado vazio normal, sem mandar ligar o que já está ligado", () => {
    filaVazia();
    render(wrap(<CaseList aviso={null} />));

    expect(screen.getByText("Nenhum caso aberto")).toBeInTheDocument();
    expect(screen.queryByTestId("casos-sem-chave")).not.toBeInTheDocument();
    // O texto normal cita o interruptor (diz quem abre caso); o que não pode é
    // acusar a chave de desligada ou mandar a pessoa ligá-la.
    expect(screen.queryByText(/está desligada/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("com caso na fila: a lista aparece e nenhum aviso de configuração", () => {
    filaComCaso();
    // Mesmo que a leitura diga "desligada", fila com caso não vira aviso: o
    // vazio é o que se explica, não o preenchido.
    render(wrap(<CaseList aviso={DESLIGADO} />));

    expect(screen.getByTestId("case-item")).toHaveTextContent("Cliente pede desconto acima do permitido");
    expect(screen.queryByTestId("casos-sem-chave")).not.toBeInTheDocument();
  });

  it("sem permissão de editar: sem botão que leve a 403, e diz quem pode ligar", () => {
    filaVazia();
    render(
      wrap(
        <CaseList aviso={{ motivo: "chave_desligada", href: null, alvo: "agente", podeEditar: false }} />,
      ),
    );

    const bloco = screen.getByTestId("casos-sem-chave");
    expect(bloco).toHaveTextContent(/Nenhum agente está liberado para abrir casos/i);
    expect(within(bloco).queryByRole("link")).not.toBeInTheDocument();
    expect(bloco).toHaveTextContent(/Só um administrador da organização pode ligar esta opção/);
  });

  it("gestor (vê o agente, não edita): link existe, rótulo não promete edição", () => {
    filaVazia();
    render(
      wrap(<CaseList aviso={{ ...DESLIGADO, alvo: "agente", podeEditar: false }} />),
    );

    const link = screen.getByRole("link", { name: "Ver o agente" });
    expect(link).toHaveAttribute("href", "/app/ai/agents/ag-1#cases_enabled");
  });

  it("vários agentes: o link leva à lista, porque escolher um seria inventar qual deve poder", () => {
    filaVazia();
    render(
      wrap(<CaseList aviso={{ motivo: "chave_desligada", href: "/app/ai/agents", alvo: "lista", podeEditar: true }} />),
    );

    expect(screen.getByRole("link", { name: "Ver os agentes" })).toHaveAttribute("href", "/app/ai/agents");
  });

  it("chave ligada só no rascunho: o vazio pede a publicação, não a chave", () => {
    filaVazia();
    render(wrap(<CaseList aviso={{ ...DESLIGADO, motivo: "falta_publicar" }} />));

    const bloco = screen.getByTestId("casos-sem-chave");
    expect(bloco).toHaveTextContent(/está ligada, mas o agente não foi publicado/i);
    expect(bloco).toHaveTextContent(/publique a versão/i);
    expect(bloco).not.toHaveTextContent(/está desligada/i);
  });

  it("organização sem agente nenhum: diz que falta configurar o agente", () => {
    filaVazia();
    render(wrap(<CaseList aviso={{ ...DESLIGADO, motivo: "sem_agente", alvo: "lista", href: "/app/ai/agents" }} />));

    expect(screen.getByTestId("casos-sem-chave")).toHaveTextContent(/Nenhum agente configurado ainda/i);
  });
});
