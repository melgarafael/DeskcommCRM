/**
 * O AVISO APARECE COMO FOI GRAVADO; O QUE É NOSSO CONTINUA TRADUZIDO.
 *
 * ## O defeito (issue #603), achado por @rafaelbatistazz no PR #622
 *
 * `AgentInboxList` renderizava `{t(item.title)}` e `{t(item.body)}`.
 * `agent_inbox_items.title/body` são LINHAS: o runtime as escreve no instante
 * do evento, recheadas com dado de gente — nome do cliente, número do WhatsApp,
 * motivo do handoff, o nome que o operador cadastrou. Passar isso pelo
 * dicionário é o mesmo erro que o PR #600 corrigiu na Agenda: na maioria das
 * vezes não traduz nada (a chave é a frase inteira e nunca casa) e, quando
 * casa, troca a palavra que a pessoa cadastrou por outra que ela não consegue
 * procurar.
 *
 * ## Por que renderizar, e não varrer o AST
 *
 * A varredura estática guardaria a CHAMADA (`t(` aplicado a `item.title`), e a
 * chamada tem mil disfarces: `t(item.title ?? "")`, `t(String(item.title))`,
 * um helper `rotulo(item)` que traduz lá dentro. O que importa é o texto que
 * chega ao olho. Aqui o `t` de mentira PREFIXA tudo que passa por ele; então o
 * título sem prefixo é prova de que não passou, e o rótulo COM prefixo é prova
 * de que a tela continua traduzida — o par do "não faça X", sem o qual arrancar
 * `t()` da tela inteira satisfaria este arquivo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { AgentInboxList } from "@/app/app/ai/inbox/_components/AgentInboxList";
import {
  useAgentInbox,
  useResolveAllInboxItems,
  useUpdateInboxItem,
  type AgentInboxItem,
} from "@/hooks/ai/useAgentInbox";

vi.mock("@/hooks/ai/useAgentInbox", () => ({
  useAgentInbox: vi.fn(),
  useUpdateInboxItem: vi.fn(),
  useResolveAllInboxItems: vi.fn(),
}));
/** Todo texto que passar pelo tradutor sai marcado. O que não passar, sai cru. */
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => `ES:${texto}` }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));

/** Título e corpo como o runtime os grava: frase inteira, com dado de gente dentro. */
const TITULO = "Fulano de Tal pediu para falar com uma pessoa";
const CORPO = "Motivo: pergunta sobre contrato. Cliente: Fulano de Tal (+55 11 99999-0000).";

const aviso: AgentInboxItem = {
  id: "aviso-1",
  kind: "handoff",
  severity: "warn",
  title: TITULO,
  body: CORPO,
  ref_kind: "conversation",
  ref_id: "conversa-1",
  status: "open",
  created_at: new Date().toISOString(),
  destination: { estado: "disponivel", href: "/app/inbox/conversa-1", rotulo: "Abrir conversa" },
};

const resolverTodos = vi.fn();

function lista(itens: AgentInboxItem[] = [aviso], extra: Record<string, unknown> = {}) {
  vi.mocked(useAgentInbox).mockReturnValue({
    data: { items: itens, open_count: itens.length },
    isLoading: false,
    // Estes casos renderizam como quem ALCANÇA a Central (é o `podeConsultar`
    // que habilita a lista e o estado vazio legítimo, #3147).
    podeConsultar: true,
    ...extra,
  } as unknown as ReturnType<typeof useAgentInbox>);
}

beforeEach(() => {
  vi.clearAllMocks();
  lista();
  vi.mocked(useUpdateInboxItem).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateInboxItem>);
  vi.mocked(useResolveAllInboxItems).mockReturnValue({
    mutate: resolverTodos,
    isPending: false,
  } as unknown as ReturnType<typeof useResolveAllInboxItems>);
});

describe("Central de avisos: o dado sai como veio", () => {
  it("título e corpo do aviso chegam ao olho SEM passar pelo tradutor", () => {
    render(<AgentInboxList canResolve />);

    expect(screen.getByText(TITULO)).toBeVisible();
    expect(screen.getByText(CORPO)).toBeVisible();
    expect(
      screen.queryByText(`ES:${TITULO}`),
      "o título do aviso foi pelo dicionário: quem lê em espanhol deixa de ver o que foi gravado",
    ).toBeNull();
    expect(screen.queryByText(`ES:${CORPO}`)).toBeNull();
  });

  it("o que é NOSSO continua traduzido — o par do «não faça X»", () => {
    // Sem este caso, arrancar t() da tela inteira deixaria o de cima verde e
    // devolveria a Central em português para quem escolheu espanhol.
    render(<AgentInboxList canResolve />);

    expect(screen.getByText("ES:atenção"), "severidade").toBeVisible();
    expect(
      screen.getByText(/^ES:O assistente passou um atendimento para um humano/),
      "rótulo do kind",
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "ES:Abrir conversa" })).toBeVisible();
    expect(screen.getByRole("button", { name: "ES:Marcar resolvido" })).toBeVisible();
  });
});

describe("Central de avisos: resolver todos de uma vez", () => {
  it("o botão aparece na aba Abertos para quem pode resolver e dispara uma chamada só", () => {
    render(<AgentInboxList canResolve />);

    fireEvent.click(screen.getByRole("button", { name: "ES:Marcar todos resolvidos" }));
    expect(resolverTodos).toHaveBeenCalledOnce();
  });

  it("quem não pode resolver não recebe o botão do lote", () => {
    render(<AgentInboxList canResolve={false} />);
    expect(screen.queryByRole("button", { name: "ES:Marcar todos resolvidos" })).toBeNull();
  });

  it("sem aviso aberto não há lote a resolver", () => {
    lista([]);
    render(<AgentInboxList canResolve />);
    expect(screen.queryByRole("button", { name: "ES:Marcar todos resolvidos" })).toBeNull();
  });

  it("na aba Resolvidos o botão some — ele fecha abertos, não reabre nada", () => {
    render(<AgentInboxList canResolve />);
    // Radix ativa a aba no mouseDown/focus, não no `click` sintético.
    const aba = screen.getByRole("tab", { name: "ES:Resolvidos" });
    fireEvent.mouseDown(aba);
    fireEvent.focus(aba);
    expect(aba).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("button", { name: "ES:Marcar todos resolvidos" })).toBeNull();
  });

  it("lote que falha deixa rastro na tela e não afirma que fechou nada", () => {
    // O laço de retorno (invariante 7 do Sistema Vivo): o lote pode falhar
    // depois de resolver PARTE dos avisos. Sem esta mensagem o clique some sem
    // efeito visível e a pessoa clica de novo achando que não pegou.
    vi.mocked(useResolveAllInboxItems).mockReturnValue({
      mutate: resolverTodos,
      isPending: false,
      isError: true,
    } as unknown as ReturnType<typeof useResolveAllInboxItems>);
    render(<AgentInboxList canResolve />);

    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível resolver todos");
    expect(screen.getByText(TITULO), "a lista some junto com o erro").toBeVisible();
  });
});
