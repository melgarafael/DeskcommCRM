// app/app/leads/[id]/rota-estavel-do-negocio.test.tsx
/**
 * #3062 / #4151 — a URL estável do negócio (`/app/leads/<id>`).
 *
 * ─── O que mudou, e por quê ────────────────────────────────────────────────
 *
 * Até a #4151 esta rota só RESOLVIA o funil do negócio e redirecionava para o
 * quadro com `?lead=`: o destino real era o painel lateral, e não havia como
 * ler um resumo de caso longo com conforto. A #4151 pediu a página inteira, e
 * é isso que a rota passa a RENDERIZAR — o `redirect` daqui saiu.
 *
 * O controle que importa continua o mesmo, e é por isso que este arquivo foi
 * reescrito em vez de apagado: a consulta é filtrada pela ORGANIZAÇÃO ativa,
 * então um link para negócio de outra org responde `notFound()` — sem
 * redirecionar para o funil de lá, o que trocaria a organização ativa por baixo
 * de quem clicou.
 *
 * O retorno ao quadro (com o filtro) também é medido: ele chega por `voltar=`
 * e só vale quando aponta para dentro do quadro. Um `voltar` externo cai no
 * quadro do próprio negócio — a rota não vira trampolim de redirect aberto.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireAuthMock, resolveActiveOrgMock, notFoundMock, redirectMock, respostas, chamadas } = vi.hoisted(
  () => ({
    requireAuthMock: vi.fn(),
    resolveActiveOrgMock: vi.fn(),
    notFoundMock: vi.fn(),
    redirectMock: vi.fn(),
    /** O que cada tabela devolve — a página faz quatro leituras leves. */
    respostas: {} as Record<string, { data: unknown; error?: unknown }>,
    /** `(tabela, coluna, valor)` de cada `.eq()` — é onde o filtro de org aparece. */
    chamadas: [] as Array<{ tabela: string; coluna: string; valor: unknown }>,
  }),
);

vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
  redirect: redirectMock,
}));

vi.mock("@/lib/auth/server", () => ({
  requireAuth: requireAuthMock,
  resolveActiveOrg: resolveActiveOrgMock,
}));

/**
 * A página em si não é o objeto deste arquivo (ela tem teste próprio, com as
 * peças montadas). Aqui só interessa O QUE o servidor resolve e entrega.
 */
vi.mock("./_client", () => ({
  NegocioEmPagina: ({ lead }: { lead: { id: string; title: string } }) => (
    <div data-negocio-em-pagina={lead.id}>{lead.title}</div>
  ),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      const resposta = () => respostas[tabela] ?? { data: null, error: null };
      // A corrente do PostgREST: `select().eq()….maybeSingle()` (ou `order()`
      // aguardado direto, no caso das etapas). Uma corrente só, em que cada
      // método devolve a si mesma, e o `then` a torna aguardável.
      const cadeia: Record<string, unknown> = {};
      for (const metodo of ["select", "order", "limit"]) cadeia[metodo] = () => cadeia;
      cadeia.eq = (coluna: string, valor: unknown) => {
        chamadas.push({ tabela, coluna, valor });
        return cadeia;
      };
      cadeia.maybeSingle = async () => resposta();
      cadeia.then = (resolver: (v: unknown) => unknown) => Promise.resolve(resposta()).then(resolver);
      return cadeia;
    },
  }),
}));

import LeadPage from "./page";

const LEAD = {
  id: "l-1",
  organization_id: "org-1",
  pipeline_id: "p-1",
  stage_id: "e-1",
  contact_id: "c-1",
  title: "Viagem Rio",
  status: "open",
};

afterEach(() => {
  vi.clearAllMocks();
  chamadas.length = 0;
  for (const tabela of Object.keys(respostas)) delete respostas[tabela];
});

function prepararSessao() {
  requireAuthMock.mockResolvedValue({ id: "u-1" });
  resolveActiveOrgMock.mockResolvedValue({ orgId: "org-1", role: "admin" });
  // No Next, `notFound()` LANÇA — a execução para ali. Um mock silencioso
  // deixaria a página seguir e o teste mediria o mock.
  notFoundMock.mockImplementation(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
  respostas.crm_leads = { data: LEAD };
  respostas.crm_pipelines = { data: { id: "p-1", name: "Comercial", settings: {} } };
  respostas.crm_stages = { data: [{ id: "e-1", name: "Novo" }] };
  respostas.conversations = { data: null };
}

function abrir(id: string, busca: Record<string, string> = {}) {
  return LeadPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(busca) });
}

describe("#3062/#4151 — a rota estável do negócio", () => {
  it("⭐ RENDERIZA o negócio em vez de redirecionar para o quadro", async () => {
    prepararSessao();

    const pagina = await abrir("l-1");
    render(pagina);

    expect(screen.getByText("Viagem Rio")).toBeInTheDocument();
    expect(redirectMock).not.toHaveBeenCalled();
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("entrega o nome da etapa, os campos do funil e o funil à página", async () => {
    // A etapa é resolvida no SERVIDOR (a página só mostra o nome): as etapas
    // nem descem para o cliente, e é por isso que o teste cobra o nome, não a
    // lista.
    prepararSessao();

    const pagina = await abrir("l-1");

    expect(pagina.props.pipelineId).toBe("p-1");
    expect(pagina.props.stageName).toBe("Novo");
    // Sem campos declarados no funil, a lista é vazia — e não `undefined`, que
    // faria o formulário cair no default dele sem ninguém saber por quê.
    expect(pagina.props.fieldDefs).toEqual([]);
  });

  it("volta para o quadro com o MESMO filtro quando `voltar` é do quadro", async () => {
    prepararSessao();

    const pagina = await abrir("l-1", { voltar: "/app/pipelines/p-1?etapa=e-1&etiqueta=quente" });

    expect(pagina.props.voltar).toBe("/app/pipelines/p-1?etapa=e-1&etiqueta=quente");
  });

  it("`voltar` de FORA do quadro é ignorado — nada de redirect aberto", async () => {
    prepararSessao();

    for (const bruto of ["https://exemplo.com/golpe", "//exemplo.com", "/app/contatos", "javascript:alert(1)"]) {
      const pagina = await abrir("l-1", { voltar: bruto });
      expect(pagina.props.voltar, `aceitou ${bruto}`).toBe("/app/pipelines/p-1");
    }
  });

  it("filtra pela ORGANIZAÇÃO ativa — o negócio de outra org não é encontrado", async () => {
    prepararSessao();
    // A RLS enxerga as organizações do usuário; é este filtro que separa uma da
    // outra. Sem a linha da organização ativa, a resposta é `notFound()`.
    respostas.crm_leads = { data: null };

    await expect(abrir("l-de-outra-org")).rejects.toThrow("NEXT_NOT_FOUND");

    expect(chamadas).toContainEqual({ tabela: "crm_leads", coluna: "organization_id", valor: "org-1" });
    expect(notFoundMock).toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("negócio sem funil também responde `notFound()`", async () => {
    prepararSessao();
    respostas.crm_leads = { data: { ...LEAD, pipeline_id: null } };

    await expect(abrir("l-2")).rejects.toThrow("NEXT_NOT_FOUND");

    expect(notFoundMock).toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
