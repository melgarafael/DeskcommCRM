/**
 * "MARCAR COMO GANHO" DO MENU DO CARD PEDE O MOTIVO (issue #5181).
 *
 * O defeito medido na main: o item chamava `mutate({ leadId })` e o corpo ia
 * `{}`. A rota JÁ aceitava `won_reason`, e `encerraDemanda` já recusava sem
 * ele (`won_reason_required`) e fora do vocabulário (`settings.won_reasons`) —
 * ou seja, quem tinha lista cadastrada nunca acertava o motivo por este
 * caminho, e descobria no 422 depois de clicar.
 *
 * O que este teste mede, e como:
 *
 *   - a árvore é a de verdade (`KanbanCardActions` + `WinLeadDialog`), com o
 *     `useWinLead` REAL — porque o que se prova é o CORPO DO POST, e um dublê
 *     do hook provaria só que alguém chamou alguém;
 *   - o `apiClient` é dublê, então o que sai no fio é observável sem servidor;
 *   - o funil entra pelo cache do quadro (`["board", pipelineId]`), que é de
 *     onde o card lê `settings.won_reasons` e `settings.won_reason_required` —
 *     a mesma fonte do quadro de verdade, não uma prop inventada para o teste.
 */
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import type { BoardData } from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";

const post = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
const toastDeErro = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/client", () => ({ apiClient: { post, get, patch: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
// O toast genérico é justamente o que a recusa de vocabulário NÃO pode virar.
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: toastDeErro }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => false,
  useMoedaDaOrgAtiva: () => null,
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
vi.mock("@/hooks/kanban/useAssignableAgents", () => ({ useAssignableAgents: () => ({ data: [] }) }));
vi.mock("@/hooks/kanban/usePropostaEnviadaDoLead", () => ({
  usePropostaEnviadaDoLead: () => ({ data: undefined }),
}));
vi.mock("@/components/kanban/LoseLeadDialog", () => ({ LoseLeadDialog: () => null }));
vi.mock("@/components/kanban/MoveToOtherPipelineDialog", () => ({
  MoveToOtherPipelineDialog: () => null,
}));
vi.mock("@/components/kanban/EditLeadDialog", () => ({ EditLeadDialog: () => null }));

import { KanbanCardActions } from "@/components/kanban/KanbanCardActions";

const PIPELINE = "p-1";
const LEAD = { id: "l-1", title: "Proposta da ACME", owner_user_id: null, owner_agent_id: null } as unknown as Lead;

/** O corpo de cada POST que saiu para `/win`, na ordem. */
function ganhosEnviados(): Array<Record<string, unknown>> {
  return post.mock.calls
    .filter(([url]) => String(url).endsWith("/win"))
    .map(([, corpo]) => corpo as Record<string, unknown>);
}

function montar(settings: Record<string, unknown>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const quadro = {
    pipeline: { id: PIPELINE, settings },
    stages: [],
    leads: [LEAD],
  } as unknown as BoardData;
  client.setQueryData(["board", PIPELINE], quadro);
  return render(
    <QueryClientProvider client={client}>
      <KanbanCardActions lead={LEAD} pipelineId={PIPELINE} />
    </QueryClientProvider>,
  );
}

/**
 * O QUADRO QUE RECARREGA (#5340).
 *
 * O card não lê `settings` por prop: ele lê o CACHE do quadro
 * (`useRegraDoMotivoDeGanho`), como o quadro de verdade. Sem ninguém observando
 * a chave, trocar o cache não re-renderiza nada — é o `KanbanBoard` quem faz
 * isso, e aqui é o dublê dele: a consulta busca o quadro pelo `apiClient`, e
 * `recarregar` troca o que vem na volta seguinte (o funil editado por fora).
 */
function QuadroQueRecarrega() {
  useQuery({
    queryKey: ["board", PIPELINE],
    queryFn: async () =>
      ((await get(`/api/v1/pipelines/${PIPELINE}/board`)) as { data: BoardData }).data,
  });
  return <KanbanCardActions lead={LEAD} pipelineId={PIPELINE} />;
}

function montarQuadroQueRecarrega(settings: Record<string, unknown>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const quadro = (s: Record<string, unknown>) =>
    ({
      pipeline: { id: PIPELINE, settings: s },
      stages: [],
      leads: [LEAD],
    }) as unknown as BoardData;
  client.setQueryData(["board", PIPELINE], quadro(settings));
  get.mockResolvedValue({ data: quadro(settings) });
  render(
    <QueryClientProvider client={client}>
      <QuadroQueRecarrega />
    </QueryClientProvider>,
  );
  /** A próxima leitura do quadro já traz a lista NOVA do funil. */
  return (settingsNovos: Record<string, unknown>) =>
    get.mockResolvedValue({ data: quadro(settingsNovos) });
}

/** Abre o menu do card e clica no item de ganho. */
async function abrirOGanho(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Ações do negócio" }));
  await user.click(await screen.findByRole("menuitem", { name: "Marcar como ganho" }));
}

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({ data: { ...LEAD, status: "won" } });
  get.mockReset();
  get.mockResolvedValue({ data: [] });
  toastDeErro.mockReset();
});

describe("#5181 — o ganho pelo menu do card pergunta o motivo", () => {
  it("funil COM lista: a caixa oferece as opções do funil e o POST leva a escolhida", async () => {
    const user = userEvent.setup();
    montar({ won_reasons: ["Renovação", "Expansão de contrato"], won_reason_required: true });

    await abrirOGanho(user);

    // A caixa aparece, com a LISTA do funil — não um campo de texto livre.
    expect(await screen.findByText("Escolha o motivo do ganho deste funil.")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Renovação" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Expansão de contrato" })).toBeTruthy();
    // Nada foi enviado antes de a pessoa escolher: era exatamente o que a main
    // fazia errado (POST imediato, sem motivo).
    expect(ganhosEnviados()).toEqual([]);

    await user.click(screen.getByRole("radio", { name: "Expansão de contrato" }));
    await user.click(screen.getByRole("button", { name: "Confirmar ganho" }));

    await waitFor(() => expect(ganhosEnviados()).toEqual([{ won_reason: "Expansão de contrato" }]));
    expect(post.mock.calls.at(-1)?.[0]).toBe(`/api/v1/leads/${LEAD.id}/win`);
    // A caixa fecha só depois de a rota responder.
    await waitFor(() => expect(screen.queryByText("Escolha o motivo do ganho deste funil.")).toBeNull());
  });

  it("funil SEM lista, mas exigindo o motivo: texto livre, e o POST leva o texto digitado", async () => {
    const user = userEvent.setup();
    montar({ won_reason_required: true });

    await abrirOGanho(user);

    const campo = await screen.findByRole("textbox", { name: "Motivo do ganho" });
    // Sem lista não há opção para oferecer: o comportamento do servidor é texto livre.
    expect(screen.queryByRole("radio")).toBeNull();

    // O botão não deixa fechar vazio quando o funil exige o motivo.
    expect((screen.getByRole("button", { name: "Confirmar ganho" }) as HTMLButtonElement).disabled).toBe(true);

    await user.type(campo, "Cliente renovou no plano anual");
    await user.click(screen.getByRole("button", { name: "Confirmar ganho" }));

    await waitFor(() =>
      expect(ganhosEnviados()).toEqual([{ won_reason: "Cliente renovou no plano anual" }]),
    );
  });

  it("funil com lista e SEM obrigatoriedade: a caixa abre, e sair sem motivo continua possível", async () => {
    const user = userEvent.setup();
    montar({ won_reasons: ["Renovação"] });

    await abrirOGanho(user);
    await screen.findByText("Escolha o motivo do ganho deste funil.");

    await user.click(screen.getByRole("button", { name: "Fechar sem motivo" }));

    // O caminho de antes: fecha sem motivo, e o corpo volta a ser o `{}` de sempre.
    await waitFor(() => expect(ganhosEnviados()).toEqual([{}]));
  });

  it("NADA MUDOU: funil sem lista e sem obrigatoriedade fecha em um clique, sem caixa e sem won_reason", async () => {
    const user = userEvent.setup();
    montar({});

    await abrirOGanho(user);

    // Nenhuma pergunta: era assim antes da #5181 e continua sendo.
    await waitFor(() => expect(ganhosEnviados()).toEqual([{}]));
    expect(screen.queryByText("Escolha o motivo do ganho deste funil.")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Motivo do ganho" })).toBeNull();
  });

  it("a recusa won_reason_invalid do servidor aparece NA CAIXA, e não como toast genérico", async () => {
    const user = userEvent.setup();
    montar({ won_reasons: ["Renovação"], won_reason_required: true });
    post.mockRejectedValueOnce(
      new ApiError(422, "won_reason_invalid", undefined, "req-1", "motivo fora do vocabulário"),
    );

    await abrirOGanho(user);
    await screen.findByText("Escolha o motivo do ganho deste funil.");
    await user.click(screen.getByRole("radio", { name: "Renovação" }));
    await user.click(screen.getByRole("button", { name: "Confirmar ganho" }));

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toBe(
      "Este motivo de ganho não está na lista do funil. Escolha um dos motivos cadastrados.",
    );
    // A caixa NÃO some na recusa: é dentro dela que está a lista para reler.
    expect(screen.getByText("Escolha o motivo do ganho deste funil.")).toBeTruthy();
    expect(toastDeErro).not.toHaveBeenCalled();
  });

  it("#5340 — depois da recusa, a escolha que saiu da lista não fica marcada e o botão volta a ficar desabilitado", async () => {
    const user = userEvent.setup();
    const recarregar = montarQuadroQueRecarrega({
      won_reasons: ["Renovação", "Expansão de contrato"],
      won_reason_required: true,
    });
    post.mockRejectedValueOnce(
      new ApiError(422, "won_reason_invalid", undefined, "req-1", "motivo fora do vocabulário"),
    );

    await abrirOGanho(user);
    await screen.findByText("Escolha o motivo do ganho deste funil.");
    await user.click(screen.getByRole("radio", { name: "Expansão de contrato" }));

    // O funil é editado por fora ANTES do clique: é o que o servidor vai recusar
    // e o que o quadro devolve no recarregamento disparado pela recusa.
    recarregar({ won_reasons: ["Outro"], won_reason_required: true });
    await user.click(screen.getByRole("button", { name: "Confirmar ganho" }));

    await screen.findByRole("alert");
    // A lista que a caixa passa a mostrar é só a atual...
    await waitFor(() => expect(screen.getByRole("radio", { name: "Outro" })).toBeTruthy());
    expect(screen.queryByRole("radio", { name: "Expansão de contrato" })).toBeNull();
    // ...e a escolha antiga NÃO continua marcada: nada selecionado.
    expect((screen.getByRole("radio", { name: "Outro" }) as HTMLInputElement).checked).toBe(false);
    // O botão só volta com uma escolha da lista ATUAL — era aqui que a caixa
    // deixava reenviar o valor que o servidor acabou de recusar.
    const confirmar = screen.getByRole("button", { name: "Confirmar ganho" }) as HTMLButtonElement;
    expect(confirmar.disabled).toBe(true);

    // E o caminho de volta continua inteiro: escolher da lista nova reabilita.
    await user.click(screen.getByRole("radio", { name: "Outro" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Confirmar ganho" }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole("button", { name: "Confirmar ganho" }));
    await waitFor(() => expect(ganhosEnviados()).toEqual([{ won_reason: "Expansão de contrato" }, { won_reason: "Outro" }]));
  });
});
