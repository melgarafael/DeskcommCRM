import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationHeader } from "./ConversationHeader";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

/**
 * EXPORTAR CONVERSA (#1982, F1) — O BOTÃO QUE FALTAVA.
 *
 * ─── O buraco que este arquivo fecha ────────────────────────────────────────
 *
 * A rota existe desde o PR #2229 (`app/api/v1/conversations/[id]/export`,
 * `?formato=pdf`, gate `requireRole("agent")`, 404 para conversa invisível,
 * audit `conversation.exported`) e o montador do PDF também
 * (`lib/conversas/exporta-pdf.ts`). O que não existia era TELA: medido em
 * `origin/main`, `git grep -n "Exportar conversa" -- app components lib` saía
 * vazio e `formato=pdf` só aparecia dentro da própria rota. O operador não
 * tinha por onde baixar — a rota era um endereço sem porta.
 *
 * ─── O que este arquivo mede, e o que ele NÃO mede ──────────────────────────
 *
 * Mede o CONTRATO da tela: o item existe no menu "⋯", é uma âncora de
 * download (não `fetch`), aponta para a rota existente com o `formato=pdf` e
 * carrega o atributo `download` que faz o browser gravar o arquivo. Mede
 * também o gate: `viewer` não vê o item, porque a rota devolve 403 para ele e
 * a tela não oferece o que a rota recusa.
 *
 * NÃO mede o download de verdade: não há e2e de conversa rodando local, e o
 * PDF em si é provado em `lib/conversas/exporta-pdf.test.ts` (6 casos) e na
 * rota, com dublê. Também não mede o tempo de geração para conversas longas.
 */

const estado = vi.hoisted(() => ({
  auth: {
    user: { id: "u1", support: null } as Record<string, unknown>,
    activeOrg: null as null | { role: string },
  },
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => estado.auth,
  usePermission: () => true,
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
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({
  useAutomaticoAtivo: () => ({ data: true }),
}));
// Desde a Spec 31 (B2) o cabeçalho consulta o número da resposta por uma query
// (`useQuery`), e este arquivo não monta `QueryClientProvider` — mesmo
// tratamento do `ConversationHeader.acoes.test.tsx`: sem resposta, o aviso de
// "a resposta sai por" não aparece, e o item de export não depende dele.
vi.mock("@/hooks/inbox/useEnderecoDaResposta", () => ({
  useEnderecoDaResposta: () => ({ data: undefined }),
}));
vi.mock("@/components/kanban/OwnerBadge", () => ({ OwnerBadge: () => null }));
vi.mock("@/components/inbox/FaixaDaCarteira", () => ({ FaixaDaCarteira: () => null }));
vi.mock("@/components/inbox/ReassignDialog", () => ({ ReassignDialog: () => null }));
vi.mock("@/components/inbox/JanelaSelo", () => ({ JanelaSelo: () => null }));
vi.mock("@/components/inbox/ChannelLogo", () => ({ ChannelLogo: () => null }));
vi.mock("@/components/voice/DialButton", () => ({ DialButton: () => null }));
vi.mock("@/components/inbox/VideoCallButton", () => ({ VideoCallButton: () => null }));
vi.mock("@/components/inbox/ParticipantesDaConversa", () => ({
  ParticipantesDaConversa: () => null,
  DialogoDeConvite: () => null,
}));
vi.mock("@/components/inbox/SnoozeButton", () => ({
  SnoozeButton: () => <button type="button">Lembrar</button>,
}));
// A folha de reserva é montada no fim do cabeçalho e lê react-query: com
// `activeOrg` de atendente o `podeReservar` é verdadeiro e, sem o dublê, o
// render morre em "No QueryClient set" — este arquivo mede o item de export,
// não a agenda.
vi.mock("@/components/agenda/ReservarServicoNaConversa", () => ({
  ItemReservarServico: () => null,
  ReservarServicoNaConversa: () => null,
}));

const CONVERSA = {
  id: "conv-1",
  organization_id: "org-1",
  contact_id: "contato-1",
  status: "open",
  assigned_to_user_id: null,
  assigned_to_user_name: null,
  assignee_kind: "ai",
  bot_silenced_until: null,
  snooze_until: null,
  service_revision: 3,
  is_group: false,
  tags: [],
  contacts: {
    id: "contato-1",
    display_name: "Fulana",
    name: null,
    phone_number: "5511999",
    tags: [],
    is_blocked: false,
    is_personal: false,
    is_anonymized: false,
    force_human: false,
  },
  channel_sessions: null,
} as unknown as ConversationWithContact;

function montar() {
  return render(<ConversationHeader conversation={CONVERSA} />);
}

/** Abre o "⋯" (o Radix abre no `pointerdown`) e devolve o conteúdo portalizado. */
async function abrirOMenu(): Promise<HTMLElement> {
  fireEvent.pointerDown(screen.getByTestId("menu-de-acoes"), {
    button: 0,
    ctrlKey: false,
    pointerId: 1,
  });
  const conteudo = await screen.findByTestId("menu-de-acoes-conteudo");
  expect(conteudo, "o menu ⋯ não abriu").toBeTruthy();
  return conteudo;
}

describe("#1982 — exportar conversa em PDF pelo menu ⋯", () => {
  beforeEach(() => {
    estado.auth = { user: { id: "u1", support: null }, activeOrg: { role: "agent" } };
  });

  it("o item existe no menu ⋯ e baixa pela rota que já existe", async () => {
    montar();
    const menu = await abrirOMenu();

    const item = within(menu).getByTestId("exportar-conversa");
    // Nome acessível é o rótulo visível — a guia vai no `title`, não no nome.
    expect(item.textContent?.trim()).toContain("Exportar conversa");
    expect(item.getAttribute("title")?.trim()).not.toBe("");

    // Âncora de download, não `fetch`: o browser faz o GET com o cookie da
    // sessão e a rota responde com `Content-Disposition: attachment`.
    expect(item.tagName).toBe("A");
    expect(item.getAttribute("href")).toBe("/api/v1/conversations/conv-1/export?formato=pdf");
    expect(item.hasAttribute("download")).toBe(true);
  });

  it("viewer não vê o item — a rota devolve 403 para quem só lê", async () => {
    estado.auth = { user: { id: "u1", support: null }, activeOrg: { role: "viewer" } };
    montar();
    const menu = await abrirOMenu();

    expect(within(menu).queryByTestId("exportar-conversa")).toBeNull();
  });
});
