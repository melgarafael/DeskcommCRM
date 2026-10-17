import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ContactTagsEditor } from "@/components/inbox/ContactTagsEditor";
import { ConversationTagsEditor } from "@/components/inbox/ConversationTagsEditor";
import { ProvedorDeCoresDasEtiquetas } from "@/components/tags/CoresDasEtiquetas";

/**
 * A sugestão de etiqueta vai para a CAIXA DE DIÁLOGO antes de gravar (#2789).
 *
 * O nome DIGITADO já nasce colorido desde a #2718 (escolhe no gatilho 🎨, clica
 * "+"), mas a sugestão do vocabulário escapava daquele caminho: o chip chamava
 * `add(tag)` direto, com `cor` ainda `null`, e a etiqueta nascia SEM COR sem que
 * a paleta aparecesse. A queixa era "clico e vai direto, sem cor".
 *
 * Três lados, porque um sem os outros não fecha:
 *  - o CLIQUE abre o diálogo e NÃO grava ainda (se já gravasse, a cor não teria
 *    onde entrar);
 *  - CONFIRMAR grava a tag com o tom escolhido, e CANCELAR não grava nada;
 *  - para quem a rota recusaria (`agent`, manager + MFA exigidos) o clique
 *    continua DIRETO — a tela não oferece o que a escrita recusa (#2718).
 *
 * O papel vem de `estado.papel` e não do mock fixo dos testes irmãos porque os
 * dois caminhos (com e sem diálogo) precisam rodar no MESMO arquivo.
 */
const estado = vi.hoisted(() => ({ papel: "manager" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { orgId: "org-1", role: estado.papel } }),
}));

const get = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (...args: unknown[]) => get(...args), post: vi.fn(), patch: vi.fn() },
}));
const mutate = vi.fn();
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutate, isPending: false }),
}));
// O editor da CONVERSA lê vocabulário e grava por outro gancho; o mesmo diálogo
// tem de valer lá, senão a #2789 fica consertada só numa das duas telas.
const mutateConversa = vi.fn();
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useUpdateConversationTags: () => ({ mutate: mutateConversa, isPending: false }),
  useConversationTagVocabulary: () => ({ data: ["google", "vip"] }),
}));
const definirCor = vi.fn();
vi.mock("@/hooks/tags/useDefinirCorDaEtiqueta", () => ({
  useDefinirCorDaEtiqueta: () => ({ definirCor }),
}));

const ORG = "org-1";
const dialogo = () => screen.getByRole("dialog");

function montar(tags: string[] = ["vip"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProvedorDeCoresDasEtiquetas>
        <ContactTagsEditor entityId="c-1" orgId={ORG} tags={tags} />
      </ProvedorDeCoresDasEtiquetas>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
  mutate.mockReset();
  mutateConversa.mockReset();
  definirCor.mockReset();
  estado.papel = "manager";
  // Duas leituras na mesma tela: vocabulário das sugestões e mapa de cores.
  get.mockImplementation(async (url: string) =>
    url === "/api/v1/tags/cores" ? { data: [] } : { data: ["google", "vip"] },
  );
});

describe("sugestão de etiqueta — caixa de diálogo antes de enviar", () => {
  it("clicar na sugestão ABRE o diálogo e ainda NÃO grava a tag", async () => {
    montar();

    const sugestao = await screen.findByRole("button", { name: "+ google" }, { timeout: 5000 });
    await userEvent.click(sugestao);

    // O diálogo é o sinal de que o caminho foi desviado — e a gravação fica para
    // depois da escolha da cor. Sem esta asserção o teste passaria hoje também
    // só que pelo motivo errado (grava direto e o diálogo nunca aparece).
    expect(dialogo()).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("confirmar grava a tag E define o tom escolhido no vocabulário", async () => {
    montar();

    const sugestao = await screen.findByRole("button", { name: "+ google" }, { timeout: 5000 });
    await userEvent.click(sugestao);

    const caixa = dialogo();
    await userEvent.click(within(caixa).getByRole("button", { name: "Índigo" }));
    await userEvent.click(within(caixa).getByRole("button", { name: "Adicionar tag" }));

    expect(mutate).toHaveBeenCalledWith({ tags: ["vip", "google"] });
    // Sem esta linha o clique poderia gravar a tag SÓ sem cor — o defeito
    // original disfarçado de corrigido.
    expect(definirCor).toHaveBeenCalledWith("google", "#3e63dd");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancelar não grava nada e fecha o diálogo", async () => {
    montar();

    const sugestao = await screen.findByRole("button", { name: "+ google" }, { timeout: 5000 });
    await userEvent.click(sugestao);

    await userEvent.click(within(dialogo()).getByRole("button", { name: "Cancelar" }));

    expect(mutate).not.toHaveBeenCalled();
    expect(definirCor).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("abre com o tom que a sugestão JÁ tem no vocabulário pré-marcado", async () => {
    // Sem isto, abrir como se a tag não tivesse cor faria "Confirmar" apagar o
    // que estava lá — a mesma pegadinha da #2771.
    get.mockImplementation(async (url: string) =>
      url === "/api/v1/tags/cores"
        ? { data: [{ tag: "google", cor: "#3e63dd" }] }
        : { data: ["google", "vip"] },
    );
    montar();

    const sugestao = await screen.findByRole("button", { name: "+ google" }, { timeout: 5000 });
    await userEvent.click(sugestao);

    const caixa = dialogo();
    expect(within(caixa).getByRole("button", { name: "Índigo" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("Sem cor sobre sugestão colorida apaga a cor do vocabulário", async () => {
    // No diálogo, `null` é "Sem cor" escolhido de propósito. Tratá-lo como "não
    // mexer" fazia a etiqueta entrar com o tom que o gerente acabou de recusar.
    get.mockImplementation(async (url: string) =>
      url === "/api/v1/tags/cores"
        ? { data: [{ tag: "google", cor: "#3e63dd" }] }
        : { data: ["google", "vip"] },
    );
    montar();
    await userEvent.click(await screen.findByRole("button", { name: "+ google" }, { timeout: 5000 }));
    const caixa = dialogo();
    await userEvent.click(within(caixa).getByRole("button", { name: "Sem cor" }));
    await userEvent.click(within(caixa).getByRole("button", { name: "Adicionar tag" }));
    expect(mutate).toHaveBeenCalledWith({ tags: ["vip", "google"] });
    expect(definirCor).toHaveBeenCalledWith("google", null);
  });

  it("Sem cor sobre sugestão colorida mostra a prévia SEM cor", async () => {
    // A prévia é a promessa do que vai ser gravado: com "Sem cor" marcado, ela
    // não pode continuar pintada com o tom do vocabulário.
    get.mockImplementation(async (url: string) =>
      url === "/api/v1/tags/cores"
        ? { data: [{ tag: "google", cor: "#3e63dd" }] }
        : { data: ["google", "vip"] },
    );
    montar();
    await userEvent.click(await screen.findByRole("button", { name: "+ google" }, { timeout: 5000 }));
    const caixa = dialogo();
    expect(within(caixa).getByText("google").style.backgroundColor).not.toBe("");
    await userEvent.click(within(caixa).getByRole("button", { name: "Sem cor" }));
    expect(within(caixa).getByText("google").style.backgroundColor).toBe("");
  });

  it("confirmar o tom já marcado grava a tag sem regravar a cor", async () => {
    get.mockImplementation(async (url: string) =>
      url === "/api/v1/tags/cores"
        ? { data: [{ tag: "google", cor: "#3e63dd" }] }
        : { data: ["google", "vip"] },
    );
    montar();
    await userEvent.click(await screen.findByRole("button", { name: "+ google" }, { timeout: 5000 }));
    await userEvent.click(within(dialogo()).getByRole("button", { name: "Adicionar tag" }));
    expect(mutate).toHaveBeenCalledWith({ tags: ["vip", "google"] });
    expect(definirCor).not.toHaveBeenCalled();
  });

  it("cor que chega DEPOIS de o diálogo abrir não é apagada pelo Sem cor que o gerente viu", async () => {
    // O diálogo guarda o tom que mostrou ao abrir. Comparar com o mapa ao vivo
    // faria confirmar o "Sem cor" exibido por omissão apagar da organização uma
    // cor que o gerente nunca viu.
    let soltarCores: (v: unknown) => void = () => {};
    get.mockImplementation((url: string) =>
      url === "/api/v1/tags/cores"
        ? new Promise((resolve) => {
            soltarCores = resolve;
          })
        : Promise.resolve({ data: ["google", "vip"] }),
    );
    montar();
    await userEvent.click(await screen.findByRole("button", { name: "+ google" }, { timeout: 5000 }));
    const caixa = dialogo();
    expect(within(caixa).getByRole("button", { name: "Sem cor" }).getAttribute("aria-pressed")).toBe("true");

    await act(async () => soltarCores({ data: [{ tag: "google", cor: "#3e63dd" }] }));
    await waitFor(() =>
      expect(document.querySelector('[data-ponto-da-etiqueta="google"]')).not.toBeNull(),
    );

    await userEvent.click(within(caixa).getByRole("button", { name: "Adicionar tag" }));
    expect(mutate).toHaveBeenCalledWith({ tags: ["vip", "google"] });
    expect(definirCor).not.toHaveBeenCalled();
  });

  it("sem permissão o clique continua direto — a rota recusaria o diálogo", async () => {
    estado.papel = "agent";
    montar();

    const sugestao = await screen.findByRole("button", { name: "+ google" }, { timeout: 5000 });
    await userEvent.click(sugestao);

    // POST /api/v1/tags/vocabulario exige manager + MFA: a tela não oferece o
    // que a escrita recusa (#2718). Aqui a tag entra sem tom, como antes.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mutate).toHaveBeenCalledWith({ tags: ["vip", "google"] });
  });
});

describe("sugestão de etiqueta no editor da CONVERSA", () => {
  it("abre o diálogo, não grava no clique, e confirmar grava com o tom escolhido", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ProvedorDeCoresDasEtiquetas>
          <ConversationTagsEditor conversationId="conv-1" orgId={ORG} tags={["vip"]} />
        </ProvedorDeCoresDasEtiquetas>
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "+ google" }, { timeout: 5000 }));
    expect(mutateConversa).not.toHaveBeenCalled();

    const caixa = dialogo();
    await userEvent.click(within(caixa).getByRole("button", { name: "Índigo" }));
    await userEvent.click(within(caixa).getByRole("button", { name: "Adicionar tag" }));

    expect(mutateConversa).toHaveBeenCalledWith({ conversation_id: "conv-1", tags: ["vip", "google"] });
    expect(definirCor).toHaveBeenCalledWith("google", "#3e63dd");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
