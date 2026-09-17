import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ContactTagsEditor } from "@/components/inbox/ContactTagsEditor";

/**
 * Tags do CONTATO sem sugestão (#852, item 1 da divisão). O editor de tags da
 * conversa já oferecia as tags em uso; o do contato obrigava a digitar do zero,
 * e cada operador criava a sua variação ("google", "gogle", "google ads").
 *
 * Dois lados, porque um sem o outro não resolve:
 *  - a ROTA precisa devolver as tags que existem, só da organização da sessão;
 *  - o EDITOR precisa oferecê-las e gravar a escolhida.
 */

const get = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (...args: unknown[]) => get(...args), post: vi.fn(), patch: vi.fn() },
}));
const mutate = vi.fn();
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutate, isPending: false }),
}));

const ORG = "org-1";

beforeEach(() => {
  get.mockReset();
  mutate.mockReset();
});

describe("ContactTagsEditor", () => {
  it("oferece as tags existentes que o contato ainda não tem, e clicar grava", async () => {
    get.mockResolvedValue({ data: ["google", "vip"] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ContactTagsEditor contactId="c-1" orgId={ORG} tags={["vip"]} />
      </QueryClientProvider>,
    );

    // 5s e não o 1s padrão: medido vermelho UMA vez com este arquivo rodando ao
    // lado de outro — 1637ms contra 436ms sozinho. O que estoura é o custo frio
    // do primeiro render do arquivo sob concorrência, não a consulta, que já
    // está resolvida no mock.
    const sugestao = await screen.findByRole("button", { name: "+ google" }, { timeout: 5000 });
    // Nada mais no repositório amarra o hook à rota: `/api/v1/contact-tags`
    // aparece em três lugares e nenhum deles é um portão. Trocar a URL por
    // `/api/v1/conversation-tags`, que existe, deixava typecheck, eslint e a
    // suíte inteira verdes — e o editor do CONTATO passaria a sugerir tags de
    // CONVERSA, que é outro vocabulário, sem ninguém notar.
    expect(get).toHaveBeenCalledWith("/api/v1/contact-tags");
    expect(screen.queryByRole("button", { name: "+ vip" })).toBeNull();

    await userEvent.click(sugestao);

    expect(mutate).toHaveBeenCalledWith({ tags: ["vip", "google"] });
  });

  /**
   * As duas direções da mesma cegueira: o filtro comparava com sensibilidade a
   * caixa, então bastava a tag estar gravada fora da forma normalizada — de um
   * lado ou do outro — para o chip nunca sumir. Clicar nele gravava a variante
   * minúscula, o contato ficava com as DUAS, e do segundo clique em diante o
   * botão não fazia nada.
   */
  it("tag do vocabulário em caixa mista não vira chip para quem já a tem", async () => {
    // A segunda tag existe como TESTEMUNHA: esperar pelo campo de texto, que
    // está na tela desde o primeiro render, fazia a asserção negativa passar
    // ANTES de a consulta resolver — verde vácuo. Medido: com o filtro
    // sabotado o caso continuava verde. Esperar por "+ google" prova que o
    // vocabulário chegou, e só então a ausência de "+ VIP" quer dizer algo.
    get.mockResolvedValue({ data: ["VIP", "google"] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ContactTagsEditor contactId="c-1" orgId={ORG} tags={["vip"]} />
      </QueryClientProvider>,
    );

    await screen.findByRole("button", { name: "+ google" }, { timeout: 5000 });
    expect(screen.queryByRole("button", { name: /\+ ?VIP/i })).toBeNull();
  });

  /**
   * Alcançável DIGITANDO, sem chip nenhum: o contato tem "VIP" gravado de
   * antes, alguém digita "vip", e sem comparar formas normalizadas o contato
   * fica com as duas — a duplicação, pelo caminho mais comum de todos.
   */
  it("digitar a variante de uma tag que o contato já tem não grava a segunda", async () => {
    get.mockResolvedValue({ data: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ContactTagsEditor contactId="c-1" orgId={ORG} tags={["VIP"]} />
      </QueryClientProvider>,
    );

    await userEvent.type(screen.getByLabelText("Adicionar tag ao contato"), "vip");
    await userEvent.click(screen.getByRole("button", { name: "Adicionar tag" }));

    expect(mutate).not.toHaveBeenCalled();
  });

  it("contato com a tag em caixa mista não recebe o chip da versão minúscula", async () => {
    get.mockResolvedValue({ data: ["vip", "google"] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ContactTagsEditor contactId="c-1" orgId={ORG} tags={["VIP"]} />
      </QueryClientProvider>,
    );

    await screen.findByRole("button", { name: "+ google" }, { timeout: 5000 });
    expect(screen.queryByRole("button", { name: /\+ ?vip/i })).toBeNull();
  });

  /**
   * O chip diz o que o clique grava MESMO que a lista chegue crua. Hoje quem
   * normaliza a lista é `GET /api/v1/contact-tags`, mas o editor não pode
   * depender disso: o cabeçalho daquela rota já manda trocar a consulta pela
   * `fn_vocabulario_de_tags`, e o rótulo do chip não pode mudar de verdade
   * junto com a fonte. "Google " cru viraria o chip "+ Google" que grava
   * "google", e "VIP"/"vip" viraria dois chips que gravam a mesma tag.
   */
  it("lista crua da fonte: o chip já mostra a forma que o clique grava, uma vez só", async () => {
    get.mockResolvedValue({ data: ["VIP", "vip", "Google "] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ContactTagsEditor contactId="c-1" orgId={ORG} tags={["cliente"]} />
      </QueryClientProvider>,
    );

    const google = await screen.findByRole("button", { name: "+ google" }, { timeout: 5000 });
    expect(screen.getAllByRole("button", { name: /^\+ ?vip$/i })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "+ vip" })).toBeTruthy();

    await userEvent.click(google);

    expect(mutate).toHaveBeenCalledWith({ tags: ["cliente", "google"] });
  });
});
