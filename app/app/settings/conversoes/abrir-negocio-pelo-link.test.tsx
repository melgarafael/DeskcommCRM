// app/app/settings/conversoes/abrir-negocio-pelo-link.test.tsx
/**
 * #3062 — os links de Configurações › Conversões que prometem abrir o NEGÓCIO
 * abrem o negócio.
 *
 * Os dois apontavam para a lista de funis com o `?lead=` na URL, e a lista de
 * funis não lê esse parâmetro: quem clicava caía na lista sem nenhum negócio
 * aberto. Quem resolve isso é a URL ESTÁVEL `/app/leads/<id>`, que acha o funil
 * ATUAL e redireciona para o quadro com o card aberto.
 *
 * O teste guarda as duas linhas separadamente — o `<a>` do Histórico de envios é
 * RENDERIZADO (é componente de servidor puro, renderiza no jsdom), e o da tabela
 * de pendências é renderizado pelo mesmo componente de link que a página usa
 * mais a asserção de origem, porque `page.tsx` é `async` e puxa Supabase admin.
 */
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { LinhaDoHistorico } from "@/lib/conversoes/historico";
import { HistoricoDeEnvios } from "./_historico";
import { LinkDoNegocio, caminhoDoNegocio } from "./_linkDoNegocio";

afterEach(cleanup);

const FILTROS = {
  periodo: "30d",
  situacao: "todas",
  evento: "",
  plataforma: "",
  busca: "",
  pagina: 1,
} as const;

const LINHA: LinhaDoHistorico = {
  id: "d-1",
  leadId: "negocio-h1",
  tituloDoLead: "Compra da loja",
  plataforma: "meta_ads",
  evento: "Purchase",
  status: "sent",
  motivo: null,
  detalhe: null,
  eventoId: "ev-1",
  protocolo: "proto-1",
  acaoGoogle: null,
  valorCentavos: 15000,
  moeda: "BRL",
  ocorridoEm: "2026-10-20T12:00:00Z",
  tentadoEm: "2026-10-20T12:00:05Z",
};

const fonte = (arquivo: string) => readFileSync(new URL(arquivo, import.meta.url), "utf8");

describe("#3062 — 'Abrir negócio' (aba Histórico de envios)", () => {
  it("aponta para a URL ESTÁVEL do negócio, com o id certo", () => {
    const { container } = render(
      <HistoricoDeEnvios linhas={[LINHA]} total={1} filtros={FILTROS} regras={[]} idioma="pt-BR" />,
    );

    const link = screen.getByRole("link", { name: "Abrir negócio" });
    expect(link).toHaveAttribute("href", "/app/leads/negocio-h1");
    // E o rótulo continua sendo o que a pessoa lê na tela.
    expect(link).toHaveTextContent("Abrir negócio");
    expect(container.querySelectorAll('a[href^="/app/kanban"]')).toHaveLength(0);
  });

  it("não deixa nenhum href para a lista de funis com `?lead=` na linha", () => {
    const { container } = render(
      <HistoricoDeEnvios linhas={[LINHA]} total={1} filtros={FILTROS} regras={[]} idioma="pt-BR" />,
    );

    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((h) => h.includes("lead="))).toBe(false);
  });
});

describe("#3062 — nome do negócio na tabela de pendências (aba Configuração)", () => {
  it("é o MESMO link estável, e mantém o título do negócio como texto", () => {
    render(<LinkDoNegocio leadId="negocio-pend-1">{LINHA.tituloDoLead}</LinkDoNegocio>);

    const link = screen.getByRole("link", { name: "Compra da loja" });
    expect(link).toHaveAttribute("href", "/app/leads/negocio-pend-1");
  });

  it("a página de Conversões monta a coluna com esse link, e não com `/app/kanban`", () => {
    const pagina = fonte("./page.tsx");
    const historico = fonte("./_historico.tsx");

    // A coluna "Negócio" das pendências usa o componente, com o id do negócio.
    expect(pagina).toMatch(/<LinkDoNegocio[^>]*leadId=\{p\.leadId\}/);
    // E o "Abrir negócio" do histórico, com o id da linha.
    expect(historico).toMatch(/<LinkDoNegocio[^>]*leadId=\{l\.leadId\}/);
    // O href errado não volta por descuido: nenhum dos dois arquivos o menciona.
    expect(pagina).not.toContain("/app/kanban");
    expect(historico).not.toContain("/app/kanban");
  });
});

describe("#3062 — a URL estável é a única resolução de negócio da tela", () => {
  it("`caminhoDoNegocio` devolve `/app/leads/<id>` — nunca a lista de funis", () => {
    expect(caminhoDoNegocio("l-9")).toBe("/app/leads/l-9");
    expect(caminhoDoNegocio("l-9")).not.toContain("/app/kanban");
  });
});
