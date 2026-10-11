/**
 * O CABEÇALHO DA CONVERSA NO CELULAR — a regra, não o pixel (#2494).
 *
 * Em ~390px o cabeçalho empilhava as ações em várias linhas (Assumir,
 * Devolver ao automático, Transferir, Lembrar, Fechar, Arquivar, Marcar como
 * pessoal, Ver contato) junto com nome, status e comando, e o que sobrava para
 * o histórico era pouca coisa: a tela de conversa deixava de ser a conversa.
 *
 * A correção NÃO remove ação nenhuma. Abaixo de `md` só ficam fora do menu as
 * duas de quem atende — `Assumir` e `Devolver ao automático`; as secundárias
 * passam para o `⋮` "Mais", e acima de `md` nada muda: os mesmos botões, na
 * mesma barra, com as mesmas classes de antes. Este arquivo vigia as três
 * frentes.
 *
 * ─── Por que isto olha CLASSE e não pixel ───────────────────────────────────
 *
 * jsdom não faz layout: ele não sabe que a tela tem 390px nem onde o botão
 * desenha. Então o que se prova aqui é o que DECIDE o comportamento — qual
 * classe esconde qual ação abaixo de `md`, quem revela o grupo e quem some o
 * `⋮` no desktop —, e a prova de geometria fica com a spec de browser
 * `tests/e2e/celular-cabe-na-tela.spec.ts`. É o mesmo arranjo de
 * `components/shell/BarraInferior.celular.test.tsx` e de
 * `components/agenda/GradeDaAgenda.mobile.test.tsx`.
 *
 * A alternativa — `useMediaQuery` em JavaScript — é proibida aqui por
 * decisão registrada em `components/inbox/InboxLayout.tsx`: media query em JS
 * decide DEPOIS da hidratação, a primeira pintura mostra o layout errado e
 * pisca. Quem esconde, portanto, é CSS; quem abre é um clique.
 *
 * As asserções de "escondida" caminham do botão até a barra: a ação pode
 * esconder no próprio botão ou num invólucro (o Lembrar é um componente à
 * parte que não aceita `className`).
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ConversationHeader } from "./ConversationHeader";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

// Dublês que o cabeçalho chama em toda renderização: sem eles o `useMutation`
// real exigiria uma rede que não existe aqui. Só a LARGURA importa a este
// arquivo, então o que mutate faz fica fora da conta.
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  useAuth: () => ({
    user: { id: "u-1", is_platform_admin: false, support: null },
    activeOrg: { orgId: "org-1", role: "manager" },
  }),
}));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useReleaseConversation", () => ({
  useReleaseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useReopenConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useArchiveConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useResumeAiAttendance", () => ({
  useResumeAiAttendance: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/usePauseAiAttendance", () => ({
  usePauseAiAttendance: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/contacts/usePersonalContact", () => ({
  useMarkPersonalContact: () => ({ mutate: vi.fn(), isPending: false }),
  useUnmarkPersonalContact: () => ({ mutate: vi.fn(), isPending: false }),
}));
// O discador exige o `VoiceCallProvider` do shell autenticado. Aqui só a
// largura importa: ele fica fora da conta, como em `inbox-header-nao-trava`.
vi.mock("@/components/voice/DialButton", () => ({ DialButton: () => null }));

/**
 * As duas ações que o critério da #2494 manda deixar visíveis no celular.
 * Sem esta lista o caso "principais fora do menu" passaria por não haver
 * nada no DOM — e não por estar visível.
 */
const PRINCIPAIS = ["Assumir", "Devolver ao automático"] as const;

/** As que vão para o `⋮` — nada é removido, só reorganizado. */
const SECUNDARIAS = [
  "Transferir",
  "Lembrar",
  "Fechar",
  "Arquivar",
  "Marcar como pessoal",
  "Ver contato",
] as const;

function conversa(): ConversationWithContact {
  return {
    id: "cv-1",
    organization_id: "org-1",
    contact_id: "ct-1",
    channel_session_id: "sess-1",
    channel: "whatsapp",
    status: "open",
    status_changed_at: new Date().toISOString(),
    service_revision: 3,
    // Sem dono a "Assumir" existe; a trava do CONTATO (`force_human`) é o que
    // acende a "Devolver ao automático" — as DUAS principais na mesma tela,
    // que é o cenário da issue.
    assigned_to_user_id: null,
    assigned_to_user_name: null,
    assignee_kind: null,
    assigned_at: null,
    last_inbound_at: null,
    last_outbound_at: null,
    last_message_at: null,
    last_message_preview: null,
    unread_count_for_assignee: 0,
    is_group: false,
    group_chat_id: null,
    tags: [],
    metadata: {},
    snooze_until: null,
    contacts: {
      id: "ct-1",
      display_name: "Fulana",
      name: null,
      phone_number: "5511999999999",
      tags: [],
      is_blocked: false,
      is_personal: false,
      is_anonymized: false,
      force_human: true,
    },
    channel_sessions: null,
  } as unknown as ConversationWithContact;
}

function montar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConversationHeader conversation={conversa()} />
    </QueryClientProvider>,
  );
}

/** A barra é quem segura os botões — mesma leitura de `inbox-header-nao-trava`. */
function barraDeAcoes(): HTMLElement {
  const barra = screen.getByText("Transferir").closest("button")?.parentElement;
  expect(barra, "a barra de ações não renderizou").toBeTruthy();
  return barra as HTMLElement;
}

/** O alvo da ação: botão, ou o `Link` do "Ver contato". */
function acao(rotulo: string): HTMLElement {
  const alvo =
    screen.queryByRole("button", { name: rotulo }) ??
    screen.getByText(rotulo).closest("a, button");
  expect(alvo, `a ação "${rotulo}" não renderizou`).toBeTruthy();
  return alvo as HTMLElement;
}

function classesDe(el: Element): string {
  return el.getAttribute("class") ?? "";
}

/**
 * ESTA ação some abaixo de `md`? Caminha do botão até a barra, porque o
 * invólucro é legítimo (o `Lembrar` é um componente à parte) e o botão sozinho
 * não carrega a classe.
 */
function escondeNoCelular(el: Element, barra: HTMLElement): boolean {
  let atual: Element | null = el;
  while (atual) {
    if (classesDe(atual).split(/\s+/).includes("max-md:hidden")) return true;
    if (atual === barra) return false;
    atual = atual.parentElement;
  }
  return false;
}

describe("cabeçalho da conversa — o menu Mais do celular (#2494)", () => {
  it("no celular, as duas ações de quem atende ficam FORA do menu", () => {
    montar();
    const barra = barraDeAcoes();
    for (const rotulo of PRINCIPAIS) {
      const botao = acao(rotulo);
      expect(barra.contains(botao), `"${rotulo}" saiu da barra`).toBe(true);
      expect(
        escondeNoCelular(botao, barra),
        `"${rotulo}" escondida abaixo de md: no celular a ação de quem atende só existiria dentro do menu`,
      ).toBe(false);
    }
    // As principais NÃO são dependentes do menu: aberto ou fechado, elas
    // respondem ao clique.
    expect(acao("Assumir")).not.toBeDisabled();
    expect(acao("Devolver ao automático")).not.toBeDisabled();
  });

  it("as secundárias começam escondidas abaixo de md e o ⋮ as revela", async () => {
    const user = userEvent.setup();
    montar();
    const barra = barraDeAcoes();

    const menu = screen.getByTestId("menu-mais-acoes");
    // `md:hidden`: o próprio ⋮ é coisa de celular. Acima de 768px ele não
    // desenha — no desktop quem abre nada é quem já tem tudo na barra.
    expect(menu.className, "o ⋮ apareceria no desktop").toContain("md:hidden");
    expect(menu).toHaveAttribute("aria-expanded", "false");

    for (const rotulo of SECUNDARIAS) {
      expect(
        escondeNoCelular(acao(rotulo), barra),
        `"${rotulo}" visível no celular sem abrir o menu — a barra continua espremendo o histórico`,
      ).toBe(true);
    }

    await user.click(menu);

    expect(menu, "o ⋮ não abriu").toHaveAttribute("aria-expanded", "true");
    for (const rotulo of SECUNDARIAS) {
      const botao = acao(rotulo);
      expect(
        escondeNoCelular(botao, barra),
        `"${rotulo}" continua escondida com o menu aberto — a ação ficaria inalcançável`,
      ).toBe(false);
      // Alcançável é clicável: nada que o menu revela pode estar desativado.
      expect(botao, `"${rotulo}" revelada mas desativada`).not.toBeDisabled();
    }
  });

  it("no desktop as ações continuam visíveis como hoje, e o ⋮ some", () => {
    montar();
    const barra = barraDeAcoes();

    // Nada é removido do DOM em nenhuma largura — o que some é CSS com mídia.
    for (const rotulo of [...PRINCIPAIS, ...SECUNDARIAS]) {
      const botao = acao(rotulo);
      expect(barra.contains(botao), `"${rotulo}" saiu do cabeçalho`).toBe(true);
      // O escondido tem de ser MEDIA-SCOPED: um `hidden` solto tiraria a ação
      // do desktop também, e é justamente o desktop que não pode mudar.
      expect(
        classesDe(botao).split(/\s+/),
        `"${rotulo}" escondida sem mídia: o desktop perde uma ação que hoje tem`,
      ).not.toContain("hidden");
    }
    // O corte é o mesmo da barra "Conversas / Ficha" e das colunas do inbox:
    // `md` (768px), onde as duas colunas cabem juntas.
    expect(classesDe(screen.getByTestId("menu-mais-acoes")).split(/\s+/)).not.toContain(
      "hidden",
    );
    // A barra segue podendo quebrar: a catraca de 707px é contrato do #1625.
    expect(barra.className).toContain("flex-wrap");
    expect(barra.className).toContain("min-w-0");
  });
});
