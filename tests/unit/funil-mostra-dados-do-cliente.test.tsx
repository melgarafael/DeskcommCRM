/**
 * O FUNIL MOSTRA OS DADOS DO CLIENTE — telefone, e-mail e links (Instagram, site,
 * Google Meu Negócio…) no card e nas abas do dossiê.
 *
 * Três garantias que um teste só de "renderiza" não daria:
 *
 *  1. o link é `<a href>`, então só http(s) pode virar clicável — a defesa vale
 *     no card mesmo que o valor chegue por outro caminho que não o servidor;
 *  2. salvar links troca o `custom_fields` INTEIRO (o PATCH substitui o objeto),
 *     então o que não é link tem que ir junto — perder um campo personalizado da
 *     organização ao salvar um Instagram seria o pior tipo de defeito: silencioso;
 *  3. o card lê os links do QUADRO, não do contato: salvar sem reler o quadro
 *     parece "não fez nada" onde a pessoa mais olha.
 *
 * Mais a fiação, lida da fonte (a mesma técnica dos irmãos deste diretório): a
 * rota lê os dados do contato na MESMA consulta dos marcadores, o card e o
 * dossiê renderizam os componentes.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useContact = vi.hoisted(() => vi.fn());
const mutateAsync = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/contacts/useContact", () => ({ useContact }));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutateAsync, isPending: false }),
}));
vi.mock("@/hooks/kanban/useBoard", () => ({
  chaveDoQuadro: (pipelineId: string | null) => ["kanban-board", pipelineId],
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...resto }: { href: string; children: ReactNode }) => (
    <a href={href} {...resto}>
      {children}
    </a>
  ),
}));

import { ContatoDoNegocio } from "@/components/kanban/ContatoDoNegocio";
import { ContatoNoCard } from "@/components/kanban/ContatoNoCard";

const RAIZ = process.cwd();
const fonte = (arquivo: string) => readFileSync(join(RAIZ, arquivo), "utf8");

function comQuery(ui: ReactNode, cliente = new QueryClient()) {
  return { cliente, ...render(<QueryClientProvider client={cliente}>{ui}</QueryClientProvider>) };
}

const CONTATO = {
  id: "c-1",
  name: "Ana Souza",
  display_name: null,
  email: "ana@exemplo.com",
  phone_number: "+5511999998888",
  updated_at: "2026-09-19T10:00:00Z",
  custom_fields: { cor_favorita: "azul", link_instagram: "instagram.com/loja" } as Record<string, unknown>,
};

beforeEach(() => {
  vi.clearAllMocks();
  useContact.mockReturnValue({ data: { data: CONTATO }, isLoading: false, isError: false });
  mutateAsync.mockResolvedValue({ data: CONTATO });
});

afterEach(cleanup);

describe("ContatoNoCard", () => {
  it("não renderiza nada quando o negócio não tem dado de contato", () => {
    const { container } = render(<ContatoNoCard lead={{}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("⭐ mostra telefone, e-mail e um link por rede, abrindo em outra aba", () => {
    render(
      <ContatoNoCard
        lead={{
          contact_phone: "+5511999998888",
          contact_email: "ana@exemplo.com",
          contact_links: [
            { tipo: "instagram", href: "https://www.instagram.com/loja" },
            { tipo: "google_meu_negocio", href: "https://maps.app.goo.gl/x" },
          ],
        }}
      />,
    );

    expect(screen.getByText("+5511999998888")).toBeInTheDocument();
    expect(screen.getByText("ana@exemplo.com")).toBeInTheDocument();

    const instagram = screen.getByRole("link", { name: "Abrir Instagram" });
    expect(instagram).toHaveAttribute("href", "https://www.instagram.com/loja");
    expect(instagram).toHaveAttribute("target", "_blank");
    expect(instagram).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(screen.getByRole("link", { name: "Abrir Google Meu Negócio" })).toHaveAttribute(
      "href",
      "https://maps.app.goo.gl/x",
    );
  });

  it("⭐ só renderiza link http(s) — javascript: que chegue por fora não vira clicável", () => {
    render(
      <ContatoNoCard
        lead={{
          contact_links: [
            { tipo: "site", href: "javascript:alert(1)" },
            { tipo: "instagram", href: "https://www.instagram.com/loja" },
          ],
        }}
      />,
    );

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://www.instagram.com/loja");
  });

  it("⭐ clicar num link NÃO abre o dossiê (o card inteiro tem onClick)", () => {
    const abrirDossie = vi.fn();
    render(
      <div onClick={abrirDossie}>
        <ContatoNoCard
          lead={{ contact_links: [{ tipo: "site", href: "https://exemplo.com.br/" }] }}
        />
      </div>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Abrir Site" }));

    expect(abrirDossie).not.toHaveBeenCalled();
  });
});

describe("ContatoDoNegocio — as abas do dossiê", () => {
  it("negócio sem contato vinculado avisa, sem consultar nada", () => {
    comQuery(<ContatoDoNegocio contactId={null} pipelineId="p-1" />);

    expect(screen.getByText("Este negócio não tem contato vinculado.")).toBeInTheDocument();
    expect(useContact).not.toHaveBeenCalled();
  });

  it("aba Dados: nome, telefone com atalho do WhatsApp, e-mail e a ficha completa", () => {
    comQuery(<ContatoDoNegocio contactId="c-1" pipelineId="p-1" />);

    expect(screen.getByText("Ana Souza")).toBeInTheDocument();
    expect(screen.getByText("+5511999998888")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Abrir no WhatsApp" })).toHaveAttribute(
      "href",
      "https://wa.me/5511999998888",
    );
    expect(screen.getByRole("link", { name: "ana@exemplo.com" })).toHaveAttribute(
      "href",
      "mailto:ana@exemplo.com",
    );
    expect(screen.getByRole("link", { name: "Ver ficha completa do contato" })).toHaveAttribute(
      "href",
      "/app/contacts/c-1",
    );
  });

  function abrirAbaDeLinks() {
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Links" }), { button: 0 });
    return screen.getByTestId("formulario-de-links");
  }

  it("aba Links: vem preenchida com o que está gravado no contato", () => {
    comQuery(<ContatoDoNegocio contactId="c-1" pipelineId="p-1" />);
    const formulario = abrirAbaDeLinks();

    expect(within(formulario).getByLabelText("Instagram")).toHaveValue("instagram.com/loja");
    expect(within(formulario).getByLabelText("Site")).toHaveValue("");
    // todos os tipos do catálogo aparecem, inclusive "Google Meu Negócio" e "Outro"
    expect(within(formulario).getByLabelText("Google Meu Negócio")).toBeInTheDocument();
    expect(within(formulario).getByLabelText("Outro")).toBeInTheDocument();
  });

  it("⭐ salvar manda o custom_fields COMPLETO e relê o quadro do funil", async () => {
    const { cliente } = comQuery(<ContatoDoNegocio contactId="c-1" pipelineId="p-1" />);
    const invalidar = vi.spyOn(cliente, "invalidateQueries");
    const formulario = abrirAbaDeLinks();

    fireEvent.change(within(formulario).getByLabelText("Site"), {
      target: { value: "exemplo.com.br" },
    });
    fireEvent.click(within(formulario).getByRole("button", { name: "Salvar links" }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith({
      custom_fields: {
        cor_favorita: "azul", // o campo que NÃO é link sobrevive ao PATCH
        link_instagram: "instagram.com/loja",
        link_site: "exemplo.com.br",
      },
    });
    await waitFor(() =>
      expect(invalidar).toHaveBeenCalledWith({ queryKey: ["kanban-board", "p-1"] }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Links salvos."));
  });

  it("apagar o texto de um link remove a chave, em vez de gravar string vazia", async () => {
    comQuery(<ContatoDoNegocio contactId="c-1" pipelineId="p-1" />);
    const formulario = abrirAbaDeLinks();

    fireEvent.change(within(formulario).getByLabelText("Instagram"), { target: { value: "" } });
    fireEvent.click(within(formulario).getByRole("button", { name: "Salvar links" }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith({ custom_fields: { cor_favorita: "azul" } });
  });

  it("⭐ endereço inválido bloqueia o salvamento e marca o campo", async () => {
    comQuery(<ContatoDoNegocio contactId="c-1" pipelineId="p-1" />);
    const formulario = abrirAbaDeLinks();

    fireEvent.change(within(formulario).getByLabelText("Site"), {
      target: { value: "javascript:alert(1)" },
    });
    fireEvent.click(within(formulario).getByRole("button", { name: "Salvar links" }));

    expect(await within(formulario).findByText("Endereço inválido.")).toBeInTheDocument();
    expect(within(formulario).getByLabelText("Site")).toHaveAttribute("aria-invalid", "true");
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it("enquanto o contato carrega, mostra o estado de carregamento", () => {
    useContact.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    comQuery(<ContatoDoNegocio contactId="c-1" pipelineId="p-1" />);

    expect(screen.getByText("Carregando…")).toBeInTheDocument();
  });

  it("falha ao carregar o contato é dita, não silenciada", () => {
    useContact.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    comQuery(<ContatoDoNegocio contactId="c-1" pipelineId="p-1" />);

    expect(screen.getByText("Não consegui carregar o contato.")).toBeInTheDocument();
  });
});

describe("a fiação — quem usa a regra a chama", () => {
  it("⭐ a rota lê o dado do contato na MESMA consulta dos marcadores e o aplica nos leads", () => {
    const rota = fonte("app/api/v1/pipelines/[id]/board/route.ts");
    const inicio = rota.indexOf("async function withMarcadoresDoContato");
    const fim = rota.indexOf("async function withNextActions");
    expect(inicio, "a etapa dos marcadores sumiu da rota").toBeGreaterThan(-1);
    const etapa = rota.slice(inicio, fim);

    expect(etapa, "a consulta não traz telefone, e-mail e custom_fields").toMatch(
      /\.select\(\s*"id, tags, phone_number, email, custom_fields, is_anonymized"\s*\)/,
    );
    expect(etapa, "anexarDadosDoContato não é chamada na etapa").toMatch(
      /anexarDadosDoContato\(\s*leadsDoQuadro,\s*linhas\s*\)/,
    );
    // sem etapa nova na cadeia: `funil-filtro-de-tag-le-as-duas-caixas` e
    // `kanban-atalho-conversa` vigiam withConversas → withMarcadoresDoContato → resposta
    expect(rota).toMatch(/leads:\s*leadsComMarcadores\.leads/);
  });

  it("o card e o dossiê renderizam os componentes novos", () => {
    expect(fonte("components/kanban/KanbanCard.tsx")).toMatch(/<ContatoNoCard\s+lead=\{lead\}/);
    expect(fonte("components/kanban/LeadDossier.tsx")).toMatch(
      /<ContatoDoNegocio\s+contactId=\{lead\.contact_id\}\s+pipelineId=\{pipelineId\}/,
    );
  });
});
