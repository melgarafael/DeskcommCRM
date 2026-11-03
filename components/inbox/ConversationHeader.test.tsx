import { render, screen, waitFor, within } from "@testing-library/react";
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
const claimMutate = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "u1", support: null } }),
}));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: claimMutate, isPending: false }),
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
// O atendimento conjunto (#2542) tem arquivo de teste próprio; este arquivo mede
// a barra de ações, e o componente novo lê react-query (exigiria provider).
vi.mock("@/components/inbox/ParticipantesDaConversa", () => ({
  ParticipantesDaConversa: () => null,
}));
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
  claimMutate.mockReset();
});

/**
 * O BOTÃO "ASSUMIR" NUNCA SOME (#3012).
 *
 * Ele é a SAÍDA da regra que trava a caixa de mensagem até alguém assumir: se
 * ele desaparecesse em algum estado, a conversa ficaria sem caminho de volta. O
 * cabeçalho não conhece a preferência da organização de propósito — quem lê a
 * opção é o compositor —, então estes casos medem o que não pode depender dela:
 * o botão existe e funciona com a conversa SEM dono, e continua existindo com a
 * conversa já assumida por outra pessoa (onde ele é o gesto de reatribuir).
 */
describe("ConversationHeader — 'Assumir' é a saída da trava (#3012)", () => {
  it("aparece e assume numa conversa SEM dono", async () => {
    const user = userEvent.setup();
    render(<ConversationHeader conversation={conversa("open")} />);

    const botao = screen.getByRole("button", { name: "Assumir" });
    await user.click(botao);

    expect(claimMutate).toHaveBeenCalledWith({
      conversation_id: "conv-1",
      expected_assignee: null,
    });
  });

  it("continua visível com a conversa já assumida por OUTRO atendente", () => {
    const atual = conversa("open");
    atual.assigned_to_user_id = "u2";
    render(<ConversationHeader conversation={atual} />);

    expect(screen.getByRole("button", { name: "Assumir" })).toBeInTheDocument();
  });
});

describe("ConversationHeader — chamada de voz na Inbox", () => {
  it("mostra Chamar e liga para o contato da conversa", async () => {
    const user = userEvent.setup();
    const atual = conversa("open");
    atual.contacts = {
      id: "contato-1",
      display_name: "Raphael",
      name: "Raphael",
      phone_number: "+5511999999999",
      tags: [],
      is_blocked: false,
      is_personal: false,
      is_anonymized: false,
    };
    render(<ConversationHeader conversation={atual} />);

    await user.click(screen.getByRole("button", { name: "Chamar" }));
    expect(startCall).toHaveBeenCalledWith("contato-1");
  });

  it("não oferece chamada individual para um grupo", () => {
    const atual = conversa("open");
    atual.is_group = true;
    atual.contacts = {
      id: "contato-1",
      display_name: "Grupo",
      name: "Grupo",
      phone_number: "+5511999999999",
      tags: [],
      is_blocked: false,
      is_personal: false,
      is_anonymized: false,
    };
    render(<ConversationHeader conversation={atual} />);
    expect(screen.queryByRole("button", { name: "Chamar" })).toBeNull();
  });
});

describe("ConversationHeader — Fechar e Arquivar por AlertDialog", () => {
  it("Fechar pede confirmação e só encerra no clique de dentro do diálogo", async () => {
    const user = userEvent.setup();
    render(<ConversationHeader conversation={conversa("open")} />);

    await user.click(screen.getByRole("button", { name: "Fechar" }));

    const dialogo = await screen.findByRole("alertdialog");
    expect(within(dialogo).getByText("Fechar esta conversa?")).toBeTruthy();
    expect(closeMutate).not.toHaveBeenCalled();

    await user.click(within(dialogo).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(closeMutate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Fechar" }));
    const dialogo2 = await screen.findByRole("alertdialog");
    await user.click(within(dialogo2).getByRole("button", { name: "Fechar" }));

    await waitFor(() => expect(closeMutate).toHaveBeenCalledTimes(1));
    expect(closeMutate).toHaveBeenCalledWith({
      conversation_id: "conv-1",
      expected_revision: 3,
    });
  });

  it("Arquivar, numa conversa aberta, avisa que o atendimento é encerrado junto", async () => {
    const user = userEvent.setup();
    render(<ConversationHeader conversation={conversa("open")} />);

    await user.click(screen.getByRole("button", { name: "Arquivar" }));

    const dialogo = await screen.findByRole("alertdialog");
    expect(within(dialogo).getByText("Arquivar esta conversa?")).toBeTruthy();
    expect(
      within(dialogo).getByText(
        "Arquivar encerra este atendimento e guarda a conversa no histórico. Se o cliente escrever de novo, ela volta.",
      ),
    ).toBeTruthy();
    expect(arquivarMutate).not.toHaveBeenCalled();

    await user.click(within(dialogo).getByRole("button", { name: "Arquivar" }));
    await waitFor(() => expect(arquivarMutate).toHaveBeenCalledTimes(1));
    expect(arquivarMutate).toHaveBeenCalledWith({
      conversation_id: "conv-1",
      expected_revision: 3,
    });
  });

  it("Arquivar, numa conversa já encerrada, não repete o aviso de encerramento", async () => {
    const user = userEvent.setup();
    render(<ConversationHeader conversation={conversa("closed")} />);

    await user.click(screen.getByRole("button", { name: "Arquivar" }));

    const dialogo = await screen.findByRole("alertdialog");
    expect(within(dialogo).getByText("Arquivar esta conversa?")).toBeTruthy();
    expect(
      screen.queryByText(
        "Arquivar encerra este atendimento e guarda a conversa no histórico. Se o cliente escrever de novo, ela volta.",
      ),
    ).toBeNull();
  });
});

describe("ConversationHeader — busca dentro da conversa (#1793)", () => {
  it("o botão só existe com quem o atenda, e só abre a busca — nenhuma ação de atendimento", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ConversationHeader conversation={conversa("open")} />);
    expect(screen.queryByRole("button", { name: "Buscar nesta conversa" })).toBeNull();

    const buscar = vi.fn();
    rerender(
      <ConversationHeader conversation={conversa("open")} onBuscar={buscar} buscaAberta={false} />,
    );
    const botao = screen.getByRole("button", { name: "Buscar nesta conversa" });
    expect(botao).toHaveAttribute("aria-expanded", "false");
    await user.click(botao);
    expect(buscar).toHaveBeenCalledOnce();
    expect(closeMutate).not.toHaveBeenCalled();
    expect(arquivarMutate).not.toHaveBeenCalled();
  });
});

/**
 * FECHAR UMA CONVERSA DE CONTATO COM A EQUIPE — A PERGUNTA QUE FALTAVA (#3313).
 *
 * A trava de humano mora no CONTATO (`contacts.force_human`), não na conversa:
 * fechar não a soltava, e a próxima mensagem daquele cliente, dias depois, era
 * pulada pela IA sem ninguém perceber. O diálogo de fechamento passa a
 * perguntar, com «Devolver ao automático ao fechar» MARCADO por padrão.
 *
 * ─── SABOTAGEM ──────────────────────────────────────────────────────────────
 *   - pôr a pergunta em toda conversa: o caso "sem a trava" acusa (a escolha
 *     apareceria onde não há trava nenhuma para soltar);
 *   - inverter o padrão (nascer marcado em "manter"): o primeiro caso acusa;
 *   - mandar a chave sempre: o caso "sem a trava" acusa, porque o corpo
 *     ganharia um `devolver_ao_automatico: false` que ninguém pediu.
 */
describe("ConversationHeader — fechar conversa de contato com a equipe (#3313)", () => {
  function comTrava(force_human: boolean, status = "open"): ConversationWithContact {
    const atual = conversa(status);
    atual.contacts = {
      id: "contato-1",
      display_name: "Raphael",
      name: "Raphael",
      phone_number: "+5511999999999",
      tags: [],
      is_blocked: false,
      is_personal: false,
      is_anonymized: false,
      force_human,
    } as unknown as ConversationWithContact["contacts"];
    return atual;
  }

  it("contato travado: o diálogo pergunta e «Devolver ao automático» vem MARCADO", async () => {
    const user = userEvent.setup();
    render(<ConversationHeader conversation={comTrava(true)} />);

    await user.click(screen.getByRole("button", { name: "Fechar" }));
    const dialogo = await screen.findByRole("alertdialog");

    expect(within(dialogo).getByTestId("escolha-ao-fechar")).toBeTruthy();
    expect(within(dialogo).getByTestId("fechar-devolver-ao-automatico")).toBeChecked();
    expect(within(dialogo).getByTestId("fechar-manter-com-a-equipe")).not.toBeChecked();

    await user.click(within(dialogo).getByRole("button", { name: "Fechar" }));
    await waitFor(() => expect(closeMutate).toHaveBeenCalledTimes(1));
    expect(closeMutate).toHaveBeenCalledWith({
      conversation_id: "conv-1",
      expected_revision: 3,
      devolver_ao_automatico: true,
    });
  });

  it("«Manter com a equipe»: fecha e manda NÃO devolver — a trava continua", async () => {
    const user = userEvent.setup();
    render(<ConversationHeader conversation={comTrava(true)} />);

    await user.click(screen.getByRole("button", { name: "Fechar" }));
    const dialogo = await screen.findByRole("alertdialog");

    await user.click(within(dialogo).getByTestId("fechar-manter-com-a-equipe"));
    expect(within(dialogo).getByTestId("fechar-manter-com-a-equipe")).toBeChecked();
    expect(within(dialogo).getByTestId("fechar-devolver-ao-automatico")).not.toBeChecked();

    await user.click(within(dialogo).getByRole("button", { name: "Fechar" }));
    await waitFor(() => expect(closeMutate).toHaveBeenCalledTimes(1));
    expect(closeMutate).toHaveBeenCalledWith({
      conversation_id: "conv-1",
      expected_revision: 3,
      devolver_ao_automatico: false,
    });
  });

  it("cancelar e reabrir volta ao PADRÃO MARCADO — a escolha não fica grudada", async () => {
    const user = userEvent.setup();
    render(<ConversationHeader conversation={comTrava(true)} />);

    await user.click(screen.getByRole("button", { name: "Fechar" }));
    const dialogo = await screen.findByRole("alertdialog");
    await user.click(within(dialogo).getByTestId("fechar-manter-com-a-equipe"));
    await user.click(within(dialogo).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Fechar" }));
    const dialogo2 = await screen.findByRole("alertdialog");
    expect(within(dialogo2).getByTestId("fechar-devolver-ao-automatico")).toBeChecked();
    expect(closeMutate).not.toHaveBeenCalled();
  });

  it("sem a trava: não pergunta nada e o fechamento é o de sempre", async () => {
    const user = userEvent.setup();
    render(<ConversationHeader conversation={comTrava(false)} />);

    await user.click(screen.getByRole("button", { name: "Fechar" }));
    const dialogo = await screen.findByRole("alertdialog");

    expect(within(dialogo).queryByTestId("escolha-ao-fechar")).toBeNull();

    await user.click(within(dialogo).getByRole("button", { name: "Fechar" }));
    await waitFor(() => expect(closeMutate).toHaveBeenCalledTimes(1));
    expect(closeMutate).toHaveBeenCalledWith({
      conversation_id: "conv-1",
      expected_revision: 3,
    });
  });
});
