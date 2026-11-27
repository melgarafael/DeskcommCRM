import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BulkActionBar } from "./BulkActionBar";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const bulkMutate = vi.hoisted(() => vi.fn());
const bulkMutateAsync = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/client", () => ({ apiClient: { get, post, patch: vi.fn() } }));
// O diálogo "Levar para outro funil" consulta os destinos por este hook; o
// teste de #5102 alimenta a lista direto.
vi.mock("@/hooks/kanban/useDestinosDeFunil", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useDestinosDeFunil: vi.fn(),
}));

import { useDestinosDeFunil } from "@/hooks/kanban/useDestinosDeFunil";
import { ApiError } from "@/lib/api/types";
// O idioma da tela é trocável por caso: o nome do card vem do BANCO, e o padrão
// neutro ("Negócio") é palavra portuguesa — numa tela em espanhol ele tem de sair traduzido.
const idioma = vi.hoisted(() => ({ atual: "pt-BR" as "pt-BR" | "es" }));
vi.mock("@/hooks/i18n/useT", async () => {
  const { traduzir } = await import("@/lib/i18n/dicionario");
  return { useT: () => (chave: string) => traduzir(chave, idioma.atual) };
});
vi.mock("sonner", () => ({ toast: { success: toastSuccess, warning: vi.fn(), error: vi.fn() } }));
// #5024: o papel da organização ativa é trocável por caso — a opção "Outro
// funil…" depende dele, e o padrão continua sendo o mesmo de antes.
const papelDaOrg = vi.hoisted(() => ({ atual: "manager" as "manager" | "agent" | "viewer" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ id: "u1", is_platform_admin: false }),
  useActiveOrg: () => ({ role: papelDaOrg.atual }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
vi.mock("@/hooks/kanban/useBulkAction", () => ({
  useBulkAction: () => ({ mutate: bulkMutate, mutateAsync: bulkMutateAsync, isPending: false }),
}));
// F2 (#2484): o diálogo de motivo do card, reusado pela barra, exige estes dois.
// Os motivos vêm do FUNIL (é o que a tela tem de mostrar) e a mutação individual
// fica de fora — no lote quem escreve é o `mutateAsync` acima.
vi.mock("@/hooks/kanban/useMotivosDePerdaDoFunil", () => ({
  useMotivosDePerdaDoFunil: () => ["preço alto", "prazo curto"],
}));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useLoseLead: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// Funil SEM etapa de perda: a barra não tem onde marcar perdido.
const STAGES = [{ id: "s1", name: "Novo" }] as never;
// Funil COM etapa de perda: é sobre ela que o lote fecha os selecionados.
const STAGES_COM_PERDA = [
  { id: "s1", name: "Novo", is_lost: false },
  { id: "s-perdido", name: "Perdido", is_lost: true },
] as never;

describe("BulkActionBar — D10, aviso agregado ao excluir em lote", () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({ data: [] });
    bulkMutate.mockReset();
  });

  it("algum dos negocios selecionados tem proposta enviada: avisa na confirmacao", async () => {
    get.mockImplementation(async (url: string) =>
      url.includes("lead-1") ? { data: [{ status: "enviada" }] } : { data: [] },
    );
    const user = userEvent.setup();
    render(
      <BulkActionBar
        selectedIds={["lead-1", "lead-2"]}
        stages={STAGES}
        pipelineId="p-1"
        tagsExistentes={[]}
        onClear={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Excluir" }));
    await waitFor(() => expect(screen.getByText(/continuam disponíveis em Propostas/i)).toBeInTheDocument());
  });

  it("nenhum negocio selecionado tem proposta enviada: sem aviso extra", async () => {
    get.mockResolvedValue({ data: [] });
    const user = userEvent.setup();
    render(
      <BulkActionBar
        selectedIds={["lead-1", "lead-2"]}
        stages={STAGES}
        pipelineId="p-1"
        tagsExistentes={[]}
        onClear={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Excluir" }));
    await screen.findByText("Esta ação remove o que está selecionado. Não pode ser desfeita.");
    expect(screen.queryByText(/continuam disponíveis em Propostas/i)).not.toBeInTheDocument();
  });
});

describe("BulkActionBar — F2 (#2484): perdido em lote", () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({ data: [] });
    bulkMutate.mockReset();
    bulkMutateAsync.mockReset();
    bulkMutateAsync.mockResolvedValue({ data: { updated_count: 2 } });
    toastSuccess.mockReset();
  });

  function montar(stages = STAGES_COM_PERDA, onClear = vi.fn()) {
    render(
      <BulkActionBar
        selectedIds={["lead-1", "lead-2"]}
        stages={stages}
        pipelineId="p-1"
        tagsExistentes={[]}
        onClear={onClear}
      />,
    );
    return onClear;
  }

  it("seleção → ação → diálogo com os motivos do funil → confirma: a rota leva os ids e o motivo", async () => {
    const onClear = montar();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Marcar como perdido…" }));

    // O MESMO diálogo do card: acha-se pela acessibilidade, não por testid.
    const caixa = await screen.findByRole("dialog");
    // Os motivos do funil — não o padrão do produto (mock devolve o funil).
    expect(within(caixa).getByRole("radio", { name: "preço alto" })).toBeInTheDocument();
    expect(within(caixa).getByRole("radio", { name: "prazo curto" })).toBeInTheDocument();

    await user.click(within(caixa).getByRole("radio", { name: "preço alto" }));
    await user.click(within(caixa).getByRole("button", { name: "Confirmar" }));

    await waitFor(() =>
      expect(bulkMutateAsync).toHaveBeenCalledWith({
        action: "move",
        lead_ids: ["lead-1", "lead-2"],
        params: { stage_id: "s-perdido", lost_reason: "preço alto" },
      }),
    );
    // Um motivo ÚNICO aplicado ao lote inteiro: a chamada leva o motivo escolhido.
    expect(bulkMutateAsync).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalled();
    // A confirmação de que deu certo: sem ela o lote some do quadro em silêncio
    // (prova de tela de 14/10 — o "atribuir" em lote já avisava, o "perder" não).
    expect(toastSuccess).toHaveBeenCalledWith("2 marcados como perdidos.");
  });

  it("sem motivo a ação não confirma: nenhuma escrita sai", async () => {
    montar();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Marcar como perdido…" }));
    const caixa = await screen.findByRole("dialog");

    // Sem escolher motivo, o "Confirmar" está barrado — e nada foi escrito.
    expect(within(caixa).getByRole("button", { name: "Confirmar" })).toBeDisabled();
    expect(bulkMutateAsync).not.toHaveBeenCalled();
    expect(bulkMutate).not.toHaveBeenCalled();
  });

  it("funil sem etapa de perda: a ação não é oferecida", () => {
    montar(STAGES);
    expect(screen.queryByRole("button", { name: "Marcar como perdido…" })).not.toBeInTheDocument();
  });
});

describe("BulkActionBar — o card é o NEGÓCIO do funil (#3811)", () => {
  beforeEach(() => {
    idioma.atual = "pt-BR";
    get.mockReset();
    get.mockResolvedValue({ data: [] });
  });

  it("tela em espanhol, funil com o padrão neutro: '1 Negocio', nunca o português cru", async () => {
    idioma.atual = "es";
    const user = userEvent.setup();
    render(
      <BulkActionBar
        selectedIds={["lead-1"]}
        stages={STAGES}
        pipelineId="p-1"
        tagsExistentes={[]}
        onClear={vi.fn()}
        vocabulary={null}
      />,
    );
    expect(screen.getByText(/^1 Negocio /)).toBeInTheDocument();
    expect(screen.queryByText(/Negócio/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Eliminar" }));
    expect(await screen.findByText(/ 1 Negocio\?$/)).toBeInTheDocument();
  });

  it("sem vocabulário: '1 Negócio selecionado', nunca o nome da pessoa", () => {
    render(
      <BulkActionBar selectedIds={["lead-1"]} stages={STAGES} pipelineId="p-1" tagsExistentes={[]} onClear={vi.fn()} />,
    );
    expect(screen.getByText(/^1 Negócio selecionado$/)).toBeInTheDocument();
  });

  it("o vocabulário do funil vence: no e-commerce o card é 'Pedido', não 'Cliente'", async () => {
    const user = userEvent.setup();
    render(
      <BulkActionBar
        selectedIds={["lead-1"]}
        stages={STAGES}
        pipelineId="p-1"
        tagsExistentes={[]}
        onClear={vi.fn()}
        vocabulary={{ lead: "Cliente", deal: "Pedido" }}
      />,
    );
    expect(screen.getByText(/^1 Pedido selecionado$/)).toBeInTheDocument();
    expect(screen.queryByText(/Cliente/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Excluir" }));
    expect(await screen.findByText("Excluir 1 Pedido?")).toBeInTheDocument();
  });
});

describe("BulkActionBar — \"Outro funil…\" só para quem a rota aceita (#5024)", () => {
  // A rota em lote exige `agent` para tudo que não é `assign`
  // (`app/api/v1/leads/bulk/route.ts`). Oferecer a opção ao `viewer` é
  // controle decorativo: o clique morre em 403. A opção some, como em funil
  // arquivado — não fica desabilitada.
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({ data: [] });
  });

  async function abrirMenuDoMover() {
    const user = userEvent.setup();
    render(
      <BulkActionBar
        selectedIds={["lead-1", "lead-2"]}
        stages={STAGES}
        pipelineId="p-1"
        tagsExistentes={[]}
        onClear={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Mover para…" }));
    return user;
  }

  it("viewer: a opção não aparece no menu", async () => {
    papelDaOrg.atual = "viewer";
    await abrirMenuDoMover();

    expect(screen.queryByTestId("lote-outro-funil")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Outro funil…" })).not.toBeInTheDocument();
  });

  it("agent: a opção aparece no menu", async () => {
    papelDaOrg.atual = "agent";
    await abrirMenuDoMover();

    expect(await screen.findByTestId("lote-outro-funil")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Outro funil…" })).toBeInTheDocument();
  });
});

describe('Funil: "promocao" sugere a etiqueta "Promoção"', () => {
  // #4166: a sugestão em lote filtrava `tag.toLowerCase().includes(tagInput...)`
  // nos dois lados crus. Quem digita sem acento não via a etiqueta existente e
  // criava uma duplicada — "Promoção" e "promocao" passavam a conviver.
  it("sem acento, a etiqueta existente continua sugerida", async () => {
    get.mockResolvedValue({ data: [] });
    const user = userEvent.setup();
    render(
      <BulkActionBar
        selectedIds={["lead-1"]}
        stages={STAGES}
        pipelineId="p-1"
        tagsExistentes={["Promoção", "vip"]}
        onClear={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Tag…" }));
    const campo = await screen.findByPlaceholderText("nova tag");
    await user.type(campo, "promocao");

    expect(await screen.findByRole("menuitem", { name: "Promoção" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "vip" })).not.toBeInTheDocument();
  });

  it("termo que não existe continua sem sugestão", async () => {
    get.mockResolvedValue({ data: [] });
    const user = userEvent.setup();
    render(
      <BulkActionBar
        selectedIds={["lead-1"]}
        stages={STAGES}
        pipelineId="p-1"
        tagsExistentes={["Promoção", "vip"]}
        onClear={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Tag…" }));
    const campo = await screen.findByPlaceholderText("nova tag");
    await user.type(campo, "inverno");

    expect(screen.queryByRole("menuitem", { name: "Promoção" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "vip" })).not.toBeInTheDocument();
  });
});

describe("BulkActionBar — Levar para outro funil depois de uma falha parcial (#5102)", () => {
  // A tela real: o quadro guarda `selectedIds` e passa `onClear`; aqui o mesmo
  // contrato — o diálogo avisa que houve efeito e a seleção inteira é limpa.
  function BarraComSelecao({ inicial }: { inicial: string[] }) {
    const [selecionados, setSelecionados] = useState(inicial);
    return (
      <BulkActionBar
        selectedIds={selecionados}
        stages={STAGES_COM_PERDA}
        pipelineId="p-1"
        tagsExistentes={[]}
        onClear={() => setSelecionados([])}
      />
    );
  }

  beforeAll(() => {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.scrollIntoView ??= () => {};
  });

  beforeEach(() => {
    post.mockReset();
    vi.mocked(useDestinosDeFunil).mockReturnValue({
      data: [
        {
          id: "p-2",
          name: "Pós-venda",
          stages: [{ id: "s-1", name: "Novo", position: 1, is_won: false, is_lost: false }],
        },
      ],
    } as never);
  });

  it("a falha parcial com cópia criada limpa a seleção e não sobra negócio para um segundo Levar", async () => {
    const cloneId = "c0a1b2c3-1111-4111-8111-111111111111";
    post.mockImplementation(async (url: string) => {
      // lead-1: a cópia nasceu no destino, o vínculo falhou (500 com o id).
      if (String(url).includes("lead-1")) {
        throw new ApiError(500, "internal_error", { cloned_lead_id: cloneId }, "qa-1", "Falha ao vincular a origem");
      }
      // lead-2: recusado sem cópia; mesmo assim a seleção é limpa (regra de
      // antes: houve efeito no lote, ninguém fica selecionado).
      throw new ApiError(422, "required_fields_missing", undefined, "qa-2", "Campos obrigatórios faltando");
    });

    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BarraComSelecao inicial={["lead-1", "lead-2"]} />
      </QueryClientProvider>,
    );

    async function levarSelecionados() {
      await user.click(screen.getByRole("button", { name: "Mover para…" }));
      await user.click(await screen.findByTestId("lote-outro-funil"));
      const caixa = await screen.findByTestId("levar-lote-para-outro-funil");
      await user.click(within(caixa).getByRole("combobox", { name: "Funil de destino" }));
      await user.click(await screen.findByRole("option", { name: "Pós-venda" }));
      await user.click(within(caixa).getByRole("button", { name: "Levar" }));
      await within(caixa).findByTestId("resultado-do-lote");
      await user.click(within(caixa).getAllByRole("button", { name: "Fechar" })[0]!);
    }

    await levarSelecionados();

    // A cópia criada no destino (mesmo com a resposta sem sucesso) conta como
    // efeito: a seleção é limpa, e não sobra nada para um segundo "Levar".
    expect(screen.queryByRole("button", { name: "Mover para…" })).not.toBeInTheDocument();

    const chamadas = post.mock.calls.map(([url]) => String(url));
    expect(chamadas.filter((url) => url.includes("lead-1"))).toHaveLength(1);
    expect(chamadas.filter((url) => url.includes("lead-2"))).toHaveLength(1);
  });
});
