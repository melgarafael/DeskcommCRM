import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationHeader } from "@/components/inbox/ConversationHeader";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

/**
 * GATES DO BOTÃO PESSOAL (spec 21, etapa 15 — decisão 1).
 *
 * Atendente não vê o botão; gerente e dono veem. Sem contato, sem botão.
 * Marcar pede confirmação (esconde da operação); desmarcar é direto.
 *
 * ─── SABOTAGEM (prova no CI) ───────────────────────────────────────────────
 * - Trocar o gate para `>= ROLE_RANK.agent`: o caso "atendente não vê" cai.
 * - Tirar a confirmação do marcar: o caso "marcar confirma antes" cai.
 * Linha para reverter: `components/inbox/ConversationHeader.tsx`,
 * `app/app/contacts/[id]/_client.tsx` (mesmo gate, lado a lado com o de admin).
 */

const papel = vi.hoisted(() => ({ atual: "agent" }));
const marcarMutate = vi.hoisted(() => vi.fn());
const desmarcarMutate = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u1", support: null, is_platform_admin: false },
    activeOrg: { orgId: "org-1", role: papel.atual },
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
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({
  useAutomaticoAtivo: () => ({ data: false }),
}));
vi.mock("@/hooks/contacts/usePersonalContact", () => ({
  useMarkPersonalContact: () => ({ mutate: marcarMutate, isPending: false }),
  useUnmarkPersonalContact: () => ({ mutate: desmarcarMutate, isPending: false }),
}));
vi.mock("@/components/kanban/OwnerBadge", () => ({ OwnerBadge: () => null }));
vi.mock("@/components/inbox/ReassignDialog", () => ({ ReassignDialog: () => null }));
vi.mock("@/components/inbox/SnoozeButton", () => ({ SnoozeButton: () => null }));
vi.mock("@/components/inbox/JanelaSelo", () => ({ JanelaSelo: () => null }));
vi.mock("@/components/inbox/ChannelLogo", () => ({ ChannelLogo: () => null }));
vi.mock("@/hooks/voice/useVoiceSessionStatus", () => ({
  useVoiceSessionStatus: () => ({ data: { configured: true, paired: true } }),
}));
vi.mock("@/components/voice/VoiceCallContext", () => ({
  useVoiceCall: () => ({ call: null, startCall: vi.fn() }),
}));

function conversa(pessoal: boolean | null): ConversationWithContact {
  return {
    id: "conv-1",
    organization_id: "org-1",
    contact_id: "contato-1",
    channel_session_id: "sess-1",
    channel: "whatsapp",
    status: "open",
    status_changed_at: new Date().toISOString(),
    service_revision: 3,
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
    contacts:
      pessoal === null
        ? null
        : {
            id: "contato-1",
            display_name: "Mãe",
            name: "Mãe",
            phone_number: "+5511999999999",
            tags: [],
            is_blocked: false,
            is_personal: pessoal,
            is_anonymized: false,
          },
    channel_sessions: null,
  } as unknown as ConversationWithContact;
}

beforeEach(() => {
  papel.atual = "agent";
  marcarMutate.mockReset();
  desmarcarMutate.mockReset();
});

describe("gate do botão pessoal no cabeçalho", () => {
  it("atendente não vê nem marcar nem desmarcar", () => {
    papel.atual = "agent";
    const { unmount } = render(<ConversationHeader conversation={conversa(false)} />);
    expect(screen.queryByTestId("marcar-pessoal")).toBeNull();
    expect(screen.queryByTestId("desmarcar-pessoal")).toBeNull();
    unmount();
  });

  it("gerente vê marcar no contato normal", () => {
    papel.atual = "manager";
    const { unmount } = render(<ConversationHeader conversation={conversa(false)} />);
    expect(screen.getByTestId("marcar-pessoal")).toBeTruthy();
    expect(screen.queryByTestId("desmarcar-pessoal")).toBeNull();
    unmount();
  });

  it("gerente vê desmarcar (e não marcar) no contato pessoal", () => {
    papel.atual = "manager";
    const { unmount } = render(<ConversationHeader conversation={conversa(true)} />);
    expect(screen.getByTestId("desmarcar-pessoal")).toBeTruthy();
    expect(screen.queryByTestId("marcar-pessoal")).toBeNull();
    unmount();
  });

  it("sem contato, sem botão para ninguém", () => {
    papel.atual = "manager";
    const { unmount } = render(<ConversationHeader conversation={conversa(null)} />);
    expect(screen.queryByTestId("marcar-pessoal")).toBeNull();
    expect(screen.queryByTestId("desmarcar-pessoal")).toBeNull();
    unmount();
  });

  it("marcar pede confirmação antes de mutar", async () => {
    papel.atual = "manager";
    const user = userEvent.setup();
    const { unmount } = render(<ConversationHeader conversation={conversa(false)} />);
    await user.click(screen.getByTestId("marcar-pessoal"));
    expect(marcarMutate).not.toHaveBeenCalled();
    expect(await screen.findByText("Marcar este contato como pessoal?")).toBeTruthy();
    unmount();
  });

  it("desmarcar é direto no botão", async () => {
    papel.atual = "manager";
    const user = userEvent.setup();
    const { unmount } = render(<ConversationHeader conversation={conversa(true)} />);
    await user.click(screen.getByTestId("desmarcar-pessoal"));
    expect(desmarcarMutate).toHaveBeenCalledTimes(1);
    unmount();
  });
});
