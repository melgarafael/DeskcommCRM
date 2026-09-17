/**
 * "Novo Lead" pelo funil nasce sem contato (#852, fatia S2).
 *
 * Medido em `main@174cd0da`: `NewLeadDialog` pede título, descrição, etapa,
 * valor, fechamento e tags — e nada mais. O `contact_id` só vai quando o
 * diálogo recebe a prop `contactId`, o que hoje só acontece no Inbox
 * (`components/inbox/CRMSidePanel.tsx`). Pelo funil
 * (`app/app/pipelines/[id]/_client.tsx`), a prop não existe e o lead nasce
 * órfão: sem telefone, sem e-mail, sem ligação com a base de contatos.
 *
 * O mesmo produto faz o oposto na importação de planilha
 * (`app/api/v1/leads/import/route.ts`): lá o telefone é procurado com
 * `phoneLookupVariants`, o contato é reaproveitado quando existe e criado
 * quando falta. Dois caminhos para a mesma coisa, com resultados diferentes.
 *
 * Relatado por quem usa a instalação: *"lá ele não permite colocar telefone e
 * esse tipo de coisa, sendo que quando a gente vai usar a importação e escolhe
 * funil pra poder mandar os contatos ele pede todos esses campos"*.
 *
 * Consequência prática, já medida no mesmo quadro: lead sem contato não tem
 * para quem o WhatsApp falar, e a automação não tem contato para casar.
 *
 * O contato fica OPCIONAL, com aviso. O defeito relatado é a ausência do campo,
 * não a permissão de criar sem ele: com o campo na tela e o título nascendo com
 * o nome da pessoa, o caminho fácil já é o certo. Obrigar custaria um major
 * (`exige_acao` em `lib/release/fragmento.ts:44`) e quebraria o hábito de abrir
 * o card no meio da ligação — decisão do dono da instalação em 16/09, depois de
 * medir os dois custos. Se o quadro continuar juntando card órfão, a trava se
 * decide com dado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Contact } from "@/lib/types/contacts";
import type { Stage } from "@/lib/kanban/types";

const criarLead = vi.fn();
vi.mock("@/hooks/kanban/useCreateLead", () => ({
  useCreateLead: () => ({ mutateAsync: criarLead, isPending: false }),
}));

const busca = vi.fn();
vi.mock("@/hooks/contacts/useContactList", () => ({
  useContactList: (filtros: { search?: string }) => busca(filtros),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { NewLeadDialog } from "@/components/kanban/NewLeadDialog";

const ETAPAS = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Novo", is_won: false, is_lost: false, is_archived: false },
] as unknown as Stage[];

const MICHELLE = {
  id: "22222222-2222-4222-8222-222222222222",
  display_name: "Michelle",
  name: null,
  phone_number: "5511988887777",
  is_anonymized: false,
  tags: [],
} as unknown as Contact;

/** O hook devolve páginas do react-query; o diálogo só lê `data.pages`. */
function paginaCom(contatos: Contact[]) {
  return { data: { pages: [{ data: contatos }] }, isLoading: false };
}

beforeEach(() => {
  criarLead.mockReset();
  criarLead.mockResolvedValue({ data: { id: "lead-1" } });
  busca.mockReset();
  busca.mockReturnValue(paginaCom([MICHELLE]));
});

afterEach(cleanup);

describe("Novo Lead pelo funil — o lead nasce com contato", () => {
  it("escolher um contato da base manda o contact_id na criação", async () => {
    const user = userEvent.setup();
    render(
      <NewLeadDialog
        open
        onOpenChange={() => {}}
        pipelineId="33333333-3333-4333-8333-333333333333"
        stages={ETAPAS}
      />,
    );

    await user.type(await screen.findByLabelText("Contato"), "Michelle");
    await user.click(await screen.findByRole("button", { name: /Michelle/ }));

    await user.type(screen.getByLabelText("Título"), "Consulta trabalhista");
    await user.click(screen.getByRole("button", { name: "Criar lead" }));

    await waitFor(() => expect(criarLead).toHaveBeenCalledTimes(1));
    expect(criarLead.mock.calls[0]?.[0]).toMatchObject({ contact_id: MICHELLE.id });
  });

  it("fechar o diálogo esquece o contato escolhido — o próximo lead não nasce ligado a ele", async () => {
    // O componente NÃO desmonta ao fechar: o funil o mantém montado enquanto há
    // dados (`app/app/pipelines/[id]/_client.tsx`). Sem limpar no fechamento, o
    // contato escolhido e abandonado volta selecionado, e o negócio seguinte
    // nasce vinculado a quem o operador desistiu de usar — sem nada na tela.
    const user = userEvent.setup();
    const { rerender } = render(
      <NewLeadDialog
        open
        onOpenChange={() => {}}
        pipelineId="33333333-3333-4333-8333-333333333333"
        stages={ETAPAS}
      />,
    );

    await user.type(await screen.findByLabelText("Contato"), "Michelle");
    await user.click(await screen.findByRole("button", { name: /Michelle/ }));

    rerender(
      <NewLeadDialog
        open={false}
        onOpenChange={() => {}}
        pipelineId="33333333-3333-4333-8333-333333333333"
        stages={ETAPAS}
      />,
    );
    rerender(
      <NewLeadDialog
        open
        onOpenChange={() => {}}
        pipelineId="33333333-3333-4333-8333-333333333333"
        stages={ETAPAS}
      />,
    );

    await user.type(await screen.findByLabelText("Título"), "Outro assunto");
    await user.click(screen.getByRole("button", { name: "Criar lead" }));

    await waitFor(() => expect(criarLead).toHaveBeenCalledTimes(1));
    expect(criarLead.mock.calls[0]?.[0]).not.toHaveProperty("contact_id");
  });

  it("sem contato o lead ainda nasce, mas a tela diz o que ele perde", async () => {
    const user = userEvent.setup();
    render(
      <NewLeadDialog
        open
        onOpenChange={() => {}}
        pipelineId="33333333-3333-4333-8333-333333333333"
        stages={ETAPAS}
      />,
    );

    expect(await screen.findByText(/não recebe WhatsApp/i)).toBeTruthy();

    await user.type(screen.getByLabelText("Título"), "Consulta trabalhista");
    await user.click(screen.getByRole("button", { name: "Criar lead" }));

    await waitFor(() => expect(criarLead).toHaveBeenCalledTimes(1));
    expect(criarLead.mock.calls[0]?.[0]).not.toHaveProperty("contact_id");
  });

  it("aberto pelo Inbox, que já sabe o contato, o seletor não aparece", async () => {
    const user = userEvent.setup();
    render(
      <NewLeadDialog
        open
        onOpenChange={() => {}}
        pipelineId="33333333-3333-4333-8333-333333333333"
        stages={ETAPAS}
        contactId={MICHELLE.id}
      />,
    );

    await user.type(await screen.findByLabelText("Título"), "Consulta trabalhista");
    expect(screen.queryByLabelText("Contato")).toBeNull();
    // O contato veio na prop; avisar que falta contato seria mentira.
    expect(screen.queryByText(/não recebe WhatsApp/i)).toBeNull();
  });
});
