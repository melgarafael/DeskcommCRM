import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationHeader } from "./ConversationHeader";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

/**
 * "Fechar" e "Arquivar" usavam `window.confirm()` — mesmo defeito documentado
 * em `app/app/tasks/_components/ListaDeTarefas.tsx`: bloqueado em iframe,
 * ignora o tema, não passa por `t()`. Agora usam o `AlertDialog` da casa
 * (docs/doctrine/destrutivo-pede-confirmacao.md): o botão só ABRE o diálogo,
 * a mutação só dispara no clique de DENTRO dele.
 */

const closeMutate = vi.hoisted(() => vi.fn());
const arquivarMutate = vi.hoisted(() => vi.fn());
const startCall = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "u1", support: null } }),
}));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useReleaseConversation", () => ({
  useReleaseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: closeMutate, isPending: false }),
  useReopenConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useArchiveConversation: () => ({ mutate: arquivarMutate, isPending: false }),
}));
vi.mock("@/hooks/inbox/useResumeAiAttendance", () => ({
  useResumeAiAttendance: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/usePauseAiAttendance", () => ({
  usePauseAiAttendance: () => ({ mutate: vi.fn(), isPending: false }),
}));
// Spec 21, etapa 15: o cabeçalho chama os hooks de pessoal em toda
// renderização (antes dos early returns) — sem este mock, o `useMutation` real
// exigiria QueryClientProvider e o teste inteiro caía.
vi.mock("@/hooks/contacts/usePersonalContact", () => ({
  useMarkPersonalContact: () => ({ mutate: vi.fn(), isPending: false }),
  useUnmarkPersonalContact: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({
  useAutomaticoAtivo: () => ({ data: false }),
}));
vi.mock("@/components/kanban/OwnerBadge", () => ({ OwnerBadge: () => null }));
// A faixa da carteira (#2591) lê a carteira com react-query; este arquivo mede
// a barra de ações, não a carteira (que tem arquivo próprio).
vi.mock("@/components/inbox/FaixaDaCarteira", () => ({ FaixaDaCarteira: () => null }));
vi.mock("@/components/inbox/ReassignDialog", () => ({ ReassignDialog: () => null }));
vi.mock("@/components/inbox/SnoozeButton", () => ({ SnoozeButton: () => null }));
vi.mock("@/components/inbox/JanelaSelo", () => ({ JanelaSelo: () => null }));
vi.mock("@/components/inbox/ChannelLogo", () => ({ ChannelLogo: () => null }));
vi.mock("@/hooks/voice/useVoiceSessionStatus", () => ({
  useVoiceSessionStatus: () => ({ data: { configured: true, paired: true } }),
}));
vi.mock("@/components/voice/VoiceCallContext", () => ({
  useVoiceCall: () => ({ call: null, startCall }),
}));

function conversa(status: string): ConversationWithContact {
  return {
    id: "conv-1",
    organization_id: "org-1",
    contact_id: "contato-1",
    channel_session_id: "sess-1",
    channel: "whatsapp",
    status,
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
    contacts: null,
    channel_sessions: null,
  } as unknown as ConversationWithContact;
}

beforeEach(() => {
  closeMutate.mockReset();
  arquivarMutate.mockReset();
  startCall.mockReset();
});

vi.mock("@/components/ui-themes/Provider", () => ({
  useUiTheme: () => ({
    package: {
      id: "test-header",
      apiVersion: 1,
      title: "Header test",
      version: "1.0.0",
      optionsVersion: 1,
      options: [],
      areas: {
        "inbox-header": {
          contractVersion: 1,
          configuration: { actionsControl: "disclosure" },
          regions: {},
          layout: {
            type: "row",
            children: ["identity", "primary", "tools", "actions", "notices"].map((name) => ({
              type: "slot",
              name,
            })),
          },
        },
      },
    },
    values: {},
    requestedId: "test-header",
    fallback: null,
  }),
}));
describe("header control slots", () => {
  it("keeps the main action visible and secondary actions reachable with native confirmation", async () => {
    const user = userEvent.setup();
    render(<ConversationHeader conversation={conversa("open")} onBuscar={() => {}} />);
    expect(screen.getByRole("button", { name: "Assumir" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Buscar nesta conversa" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Fechar$/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Mais ações da conversa" }));
    await user.click(screen.getByRole("button", { name: /^Fechar$/ }));
    expect(screen.getByRole("alertdialog")).toBeVisible();
    expect(closeMutate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(closeMutate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Mais ações da conversa" }));
    expect(screen.queryByRole("button", { name: /^Fechar$/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Mais ações da conversa" }));
    await user.click(screen.getByRole("button", { name: /^Arquivar$/ }));
    expect(screen.getByRole("alertdialog")).toBeVisible();
    expect(arquivarMutate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(arquivarMutate).not.toHaveBeenCalled();
  });
});
