/**
 * A TELA DO RECURSO PRÉ-PRONTO (#2833, fatia 2) — criar, editar e desativar.
 *
 * ─── O que já existia, medido antes de escrever ─────────────────────────────
 *
 * A tela NÃO nasce aqui: a categoria `respostas-rapidas`
 * (`app/app/templates/_components/TemplatesClient.tsx:187`) e o formulário
 * (`TemplateFormDialog.tsx`) já trazem o modo TEXTO/ÁUDIO, o campo de atalho, a
 * dica das variáveis e o interruptor "Mostrar na barra do Inbox" — tudo isso
 * entrou com o PR #2847 (`MERGED`, merge `e85fd2b5e7`) e com o #3282. O que
 * faltava era PROVA de que o caminho da TELA satisfaz os critérios da issue:
 * criar texto, criar áudio, editar o que a barra entrega, desativar sem apagar
 * a linha — e não deixar passar recurso de outra organização.
 *
 * ─── Como a prova é feita ──────────────────────────────────────────────────
 *
 * A tela roda de VERDADE (TemplatesClient + TemplateFormDialog) sobre as ROTAS
 * de verdade (`POST/GET /message-templates`, `PATCH/DELETE /message-templates/:id`)
 * e sobre um dublê stateful do PostgREST. Só duas fronteiras são dubladas: o
 * `fetch` do `apiClient` (que aqui chama o handler do App Router, em vez de
 * atravessar a rede) e o `useUploadTemplateMedia` (os bytes do arquivo não
 * interessam a esta fatia).
 *
 * A BARRA entra pela função de produto (`recursosDaBarra`) e pelo componente
 * real (`BarraDeRecursos`): é o botão por título que o operador vê no Inbox, e
 * a injeção no compositor é a fatia 1, já presa em
 * `tests/unit/composer-recursos-pre-prontos.test.tsx`.
 *
 * ─── O dublê NÃO filtra organização de propósito ──────────────────────────
 *
 * Em produção há DUAS camadas: a RLS de `message_templates` e o
 * `.eq("organization_id", org.orgId)` explícito de cada rota. Se o dublê
 * também filtrasse por organização, um PATCH sem o `.eq` continuaria devolvendo
 * 404 — mascarado pela segunda camada — e o caso de isolamento não provaria
 * nada sobre a primeira. Aqui o dublê aplica só a régua de DONO (pessoal ×
 * compartilhado); quem separa as organizações é a linha de código que o teste
 * vigia. A linha alheia da fixture é compartilhada (`owner_user_id: null`) para
 * ser gravável pelo papel `manager` caso o filtro desapareça.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  apoio: vi.fn(),
  audit: vi.fn(),
  /** Quem está logado, e o que a régua de dono do dublê usa. */
  papel: { organizacao: "", usuario: "", podeCompartilhado: true },
  /** As linhas de `message_templates` — a MESMA tabela para todas as rotas. */
  linhas: [] as Linha[],
  /** Todo pedido que a tela fez, na ordem: é assim que "nada envia" é medido. */
  disco: [] as string[],
  /** Os uploads que a tela pediu (o hook é a fronteira dublada). */
  uploads: [] as { templateId: string; nome: string }[],
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.guard }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.apoio }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => banco() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/auth/AuthProvider", async () => {
  const real: Record<string, unknown> = await vi.importActual("@/hooks/auth/AuthProvider");
  // A tela é renderizada fora do provider: a permissão de consulta é dada.
  return { ...real, usePermission: () => true };
});
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("") }));

/**
 * O `apiClient` da tela chama os HANDLERS de verdade. O corpo do pedido é o
 * mesmo que o cliente HTTP mandaria; o retorno é o JSON da resposta, que é o
 * contrato que `apiClient.get/post/patch/delete` já promete.
 */
vi.mock("@/lib/api/client", async () => {
  const { GET, POST } = await import("@/app/api/v1/message-templates/route");
  const { PATCH, DELETE } = await import("@/app/api/v1/message-templates/[id]/route");

  function pedido(metodo: string, url: string, corpo?: unknown): NextRequest {
    return new NextRequest(`http://localhost${url}`, {
      method: metodo,
      headers: { "Content-Type": "application/json" },
      ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
    });
  }

  const parametros = (url: string) => ({ params: Promise.resolve({ id: url.split("/").pop()! }) });

  async function ler(resposta: Response): Promise<unknown> {
    const corpo = (await resposta.json()) as { error?: { message?: string } };
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}: ${corpo.error?.message ?? ""}`);
    return corpo;
  }

  return {
    apiClient: {
      get: async (url: string) => {
        h.disco.push(`GET ${url}`);
        return ler(await GET(pedido("GET", url)));
      },
      post: async (url: string, corpo: unknown) => {
        h.disco.push(`POST ${url}`);
        return ler(await POST(pedido("POST", url, corpo)));
      },
      patch: async (url: string, corpo: unknown) => {
        h.disco.push(`PATCH ${url}`);
        return ler(await PATCH(pedido("PATCH", url, corpo), parametros(url)));
      },
      delete: async (url: string) => {
        h.disco.push(`DELETE ${url}`);
        const resposta = await DELETE(pedido("DELETE", url), parametros(url));
        if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
        return undefined;
      },
    },
  };
});

vi.mock("@/hooks/templates/useUploadTemplateMedia", () => ({
  useUploadTemplateMedia: () => ({
    isPending: false,
    mutateAsync: async ({ templateId, file }: { templateId: string; file: File }) => {
      h.uploads.push({ templateId, nome: file.name });
      const alvo = h.linhas.find((l) => l.id === templateId)!;
      alvo.midias = [
        ...alvo.midias,
        {
          storage_path: `${ORG}/templates/${templateId}/voz-do-operador.ogg`,
          media_mime: "audio/ogg",
          media_size_bytes: 3,
        },
      ];
      return alvo.midias;
    },
  }),
}));

vi.mock("@hello-pangea/dnd", () => ({
  DragDropContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Droppable: ({ children }: { children: (p: Record<string, unknown>) => ReactNode }) =>
    children({ innerRef: () => {}, droppableProps: {}, placeholder: null }),
  Draggable: ({
    children,
  }: {
    children: (p: Record<string, unknown>, s: Record<string, unknown>) => ReactNode;
  }) => children({ innerRef: () => {}, draggableProps: {}, dragHandleProps: {} }, { isDragging: false }),
}));

import { GET as GET_DA_LISTA } from "@/app/api/v1/message-templates/route";
import { DELETE, PATCH } from "@/app/api/v1/message-templates/[id]/route";
import { TemplatesClient } from "@/app/app/templates/_components/TemplatesClient";
import { BarraDeRecursos } from "@/components/inbox/composer/BarraDeRecursos";
import type { MessageTemplate } from "@/hooks/inbox/useMessageTemplates";
import { ehRecursoDeAudio, recursosDaBarra, type Recurso } from "@/lib/inbox/recursos";
import { payloadDeUso } from "@/lib/inbox/template-vars";
import type { MidiaDeTemplate } from "@/lib/templates/midias";

const ORG = "b7c30000-0000-4000-8000-000000000001";
const OUTRA_ORG = "b7c30000-0000-4000-8000-0000000000ff";
const USER = "b7c30000-0000-4000-8000-000000000002";

interface Linha {
  id: string;
  organization_id: string;
  owner_user_id: string | null;
  title: string;
  body: string;
  shortcut: string | null;
  midias: MidiaDeTemplate[];
  mostrar_na_barra: boolean;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  ordem: number;
}

function linha(id: string, ordem: number, extra: Partial<Linha> = {}): Linha {
  return {
    id,
    organization_id: ORG,
    owner_user_id: USER,
    title: `Título ${id}`,
    body: `Corpo ${id}`,
    shortcut: null,
    midias: [],
    mostrar_na_barra: true,
    created_by_user_id: USER,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ordem,
    ...extra,
  };
}

/**
 * O dublê do PostgREST — os mesmos `select/eq/order/limit/insert/update/delete`
 * encadeados que as rotas usam, cada `from()` abrindo uma consulta NOVA (como o
 * supabase-js: filtro de uma consulta não vaza para a seguinte).
 */
function banco() {
  // Só a régua de DONO. A organização NÃO é filtrada aqui de propósito (ver o
  // cabeçalho): quem a separa é o `.eq("organization_id", …)` de cada rota.
  const visivel = (l: Linha) => l.owner_user_id === null || l.owner_user_id === h.papel.usuario;
  const escrevivel = (l: Linha) =>
    l.owner_user_id === h.papel.usuario || (l.owner_user_id === null && h.papel.podeCompartilhado);

  function consulta() {
    const filtros: Array<[string, unknown]> = [];
    const ordenacao: Array<[string, boolean]> = [];
    let patch: Record<string, unknown> | null = null;
    let novo: Record<string, unknown> | null = null;
    let apagar = false;
    let colunasDeVolta = "id";
    let teto = Number.POSITIVE_INFINITY;

    const casam = (base: Linha[]) =>
      base.filter((l) => filtros.every(([coluna, valor]) => l[coluna as keyof Linha] === valor));

    const executar = (): Array<Record<string, unknown>> => {
      if (apagar) {
        const alvos = casam(h.linhas).filter(escrevivel);
        h.linhas = h.linhas.filter((l) => !alvos.includes(l));
        return alvos.map((l) => somente(l, colunasDeVolta));
      }
      if (novo) {
        const criada = linha(`n${h.linhas.length + 1}`, 0, {
          updated_at: new Date().toISOString(),
          ...(novo as Partial<Linha>),
        });
        if (!escrevivel(criada)) return [];
        h.linhas.push(criada);
        return [somente(criada, colunasDeVolta)];
      }
      if (patch) {
        const alvos = casam(h.linhas).filter(escrevivel);
        for (const alvo of alvos) Object.assign(alvo, patch);
        return alvos.map((l) => somente(l, colunasDeVolta));
      }
      const lista = casam(h.linhas.filter(visivel));
      lista.sort((a, b) => {
        for (const [coluna, ascendente] of ordenacao) {
          const x = a[coluna as keyof Linha] as never;
          const y = b[coluna as keyof Linha] as never;
          if (x === y) continue;
          return ascendente ? (x < y ? -1 : 1) : x < y ? 1 : -1;
        }
        return 0;
      });
      return lista.slice(0, teto).map((l) => somente(l, colunasDeVolta));
    };

    const builder = {
      select: (colunas?: string) => {
        if (colunas) colunasDeVolta = colunas;
        return builder;
      },
      eq: (coluna: string, valor: unknown) => {
        filtros.push([coluna, valor]);
        return builder;
      },
      order: (coluna: string, opcoes?: { ascending?: boolean }) => {
        ordenacao.push([coluna, opcoes?.ascending ?? true]);
        return builder;
      },
      limit: (n: number) => {
        teto = n;
        return builder;
      },
      insert: (valores: Record<string, unknown>) => {
        novo = valores;
        return builder;
      },
      update: (valores: Record<string, unknown>) => {
        patch = valores;
        return builder;
      },
      delete: () => {
        apagar = true;
        return builder;
      },
      maybeSingle: async () => ({ data: executar()[0] ?? null, error: null }),
      single: async () => {
        const primeira = executar()[0];
        return primeira
          ? { data: primeira, error: null }
          : { data: null, error: { code: "PGRST116", message: "no rows" } };
      },
      then: (aoResolver?: ((v: unknown) => unknown) | null) =>
        Promise.resolve({ data: executar(), error: null }).then(aoResolver ?? ((v) => v)),
    };
    return builder;
  }

  return { from: (_tabela: string) => consulta() };
}

function somente(l: Linha, colunas: string): Record<string, unknown> {
  if (colunas.trim() === "id") return { id: l.id };
  const pedidas = colunas.split(",").map((c) => c.trim());
  const saida: Record<string, unknown> = {};
  for (const coluna of pedidas) saida[coluna] = l[coluna as keyof Linha];
  return saida;
}

/** A listagem de verdade, pelo handler do App Router — o que a barra recebe. */
async function listar(): Promise<MessageTemplate[]> {
  const resposta = await GET_DA_LISTA(new NextRequest("http://localhost/api/v1/message-templates"));
  return ((await resposta.json()) as { data: MessageTemplate[] }).data;
}

function pedido(metodo: string, url: string, corpo?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: metodo,
    headers: { "Content-Type": "application/json" },
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
  });
}

const parametros = (id: string) => ({ params: Promise.resolve({ id }) });

function montarTela() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TemplatesClient canShare currentUserId={USER} />
    </QueryClientProvider>,
  );
}

/** A barra do Inbox, com a lista que a tela/listagem entregou. */
function montarBarra(recursos: Recurso[]) {
  return render(<BarraDeRecursos recursos={recursos} onEscolher={() => {}} storage={null} />);
}

const abrirNovo = () =>
  fireEvent.click(screen.getByRole("button", { name: /nova resposta rápida/i }));

const enviarFormulario = () =>
  fireEvent.submit(screen.getByLabelText("Título").closest("form")!);

beforeEach(() => {
  vi.resetAllMocks();
  h.papel = { organizacao: ORG, usuario: USER, podeCompartilhado: true };
  h.linhas = [];
  h.disco = [];
  h.uploads = [];
  h.guard.mockImplementation(async () => ({
    ok: true,
    user: { id: USER, idioma: "pt" },
    org: { orgId: h.papel.organizacao, role: h.papel.podeCompartilhado ? "manager" : "agent" },
  }));
  h.apoio.mockResolvedValue(null);
});

describe("criar o recurso pela tela (#2833)", () => {
  it("(1) recurso de TEXTO: nasce na lista e o botão com o TÍTULO aparece na barra do Inbox", async () => {
    montarTela();
    await waitFor(() => expect(screen.getByText("Nenhuma resposta rápida ainda.")).toBeInTheDocument());

    abrirNovo();
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "BOAS VINDAS" } });
    fireEvent.change(screen.getByLabelText("Mensagem"), {
      target: { value: "Oi {{primeiro_nome}}, tudo bem?" },
    });
    enviarFormulario();

    await waitFor(() => expect(h.linhas).toHaveLength(1));
    expect(h.linhas[0]).toMatchObject({
      organization_id: ORG,
      title: "BOAS VINDAS",
      body: "Oi {{primeiro_nome}}, tudo bem?",
      // O interruptor nasce LIGADO: criação sem tocar nele aparece na barra.
      mostrar_na_barra: true,
    });

    // A tela recarrega a lista (invalidação da chave), e a linha está nela.
    await waitFor(() => expect(screen.getByText("BOAS VINDAS")).toBeInTheDocument());

    // O que a BARRA recebe é a listagem de verdade, filtrada pela régua real.
    const lista = await listar();
    expect(lista.map((t) => t.title)).toEqual(["BOAS VINDAS"]);
    expect(recursosDaBarra(lista).map((r) => r.title)).toEqual(["BOAS VINDAS"]);

    montarBarra(lista);
    const botao = screen.getByRole("button", { name: "BOAS VINDAS" });
    expect(botao).toHaveAttribute("data-recurso-tipo", "texto");
    // E o texto que o clique entrega é o corpo INTERPOLADO — o mesmo caminho do
    // `/` (fatia 1), não uma cópia própria da barra.
    expect(payloadDeUso(lista[0]!, { name: "Ana Paula" }).texto).toBe("Oi Ana, tudo bem?");
  });

  it("(2) recurso de ÁUDIO: linha sem texto + mídia de áudio, e NADA é enviado", async () => {
    montarTela();
    await waitFor(() => expect(screen.getByText("Nenhuma resposta rápida ainda.")).toBeInTheDocument());

    abrirNovo();
    fireEvent.click(screen.getByRole("button", { name: "Áudio" }));
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Áudio boas-vindas" } });
    fireEvent.change(document.getElementById("tpl-audio")!, {
      target: { files: [new File([new Uint8Array([1, 2, 3])], "voz.ogg", { type: "audio/ogg" })] },
    });
    enviarFormulario();

    await waitFor(() => expect(h.uploads).toHaveLength(1));
    // O conteúdo do recurso de áudio é o ARQUIVO: a linha nasce sem corpo.
    expect(h.linhas[0]).toMatchObject({ title: "Áudio boas-vindas", body: "" });
    expect(h.uploads[0]!.templateId).toBe(h.linhas[0]!.id);

    const lista = await listar();
    expect(ehRecursoDeAudio(lista[0]!)).toBe(true);
    expect(recursosDaBarra(lista)).toHaveLength(1);

    montarBarra(lista);
    const botao = screen.getByRole("button", { name: "🎧 Áudio boas-vindas" });
    expect(botao).toHaveAttribute("data-recurso-tipo", "audio");

    // CRITÉRIO DA ISSUE: a tela prepara, não envia. Todo pedido que ela fez foi
    // ao módulo de recursos — nenhum caminho de mensagem foi tocado.
    expect(h.disco.length).toBeGreaterThan(0);
    expect(h.disco.every((pedido) => pedido.includes("/message-templates"))).toBe(true);
  });
});

describe("editar e desativar pela tela (#2833)", () => {
  it("(3) editar muda o que a barra ENTREGA (o corpo interpolado é o novo)", async () => {
    h.linhas = [linha("a", 1000, { title: "Saudação", body: "Oi {{primeiro_nome}}" })];
    montarTela();
    await waitFor(() => expect(screen.getByText("Saudação")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Editar resposta rápida" }));
    fireEvent.change(screen.getByLabelText("Mensagem"), {
      target: { value: "Olá {{nome}}, seu pedido saiu para entrega." },
    });
    fireEvent.click(screen.getByRole("button", { name: /^salvar$/i }));

    await waitFor(() =>
      expect(h.linhas[0]!.body).toBe("Olá {{nome}}, seu pedido saiu para entrega."),
    );

    const lista = await listar();
    expect(recursosDaBarra(lista).map((r) => r.title)).toEqual(["Saudação"]);
    expect(payloadDeUso(lista[0]!, { name: "Ana Paula" }).texto).toBe(
      "Olá Ana Paula, seu pedido saiu para entrega.",
    );
  });

  it("(4) desativar: some da barra, a linha CONTINUA (e o `/` continua listando)", async () => {
    h.linhas = [linha("a", 1000, { title: "Saudação" })];
    montarTela();
    await waitFor(() => expect(screen.getByText("Saudação")).toBeInTheDocument());

    // Controle: antes do interruptor, a resposta está na barra.
    expect(recursosDaBarra(await listar())).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Editar resposta rápida" }));
    fireEvent.click(screen.getByRole("switch", { name: "Mostrar na barra do Inbox" }));
    fireEvent.click(screen.getByRole("button", { name: /^salvar$/i }));

    await waitFor(() => expect(h.linhas[0]!.mostrar_na_barra).toBe(false));

    const lista = await listar();
    // Sumiu da barra…
    expect(recursosDaBarra(lista)).toHaveLength(0);
    montarBarra(lista);
    expect(screen.queryByTestId("barra-de-recursos")).toBeNull();
    // …mas a LINHA continua: nada foi excluído, e a listagem (o `/`) a entrega.
    expect(lista.map((t) => t.title)).toEqual(["Saudação"]);
    expect(h.disco.some((pedido) => pedido.startsWith("DELETE"))).toBe(false);
  });
});

describe("recurso de OUTRA organização (#2833: isolamento)", () => {
  it("(5) não aparece na lista da tela nem na barra", async () => {
    h.linhas = [
      linha("alheia", 1000, {
        organization_id: OUTRA_ORG,
        owner_user_id: null,
        title: "Compartilhada da outra org",
      }),
    ];
    montarTela();
    await waitFor(() =>
      expect(screen.getByText("Nenhuma resposta rápida ainda.")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Compartilhada da outra org")).toBeNull();

    const lista = await listar();
    expect(lista).toHaveLength(0);
    expect(recursosDaBarra(lista)).toHaveLength(0);
  });

  it("(6) PATCH de outra organização: 404 e NADA gravado", async () => {
    h.linhas = [
      linha("alheia", 1000, {
        organization_id: OUTRA_ORG,
        owner_user_id: null,
        title: "Compartilhada da outra org",
      }),
    ];

    const resposta = await PATCH(
      pedido("PATCH", "/api/v1/message-templates/alheia", { title: "Invadida" }),
      parametros("alheia"),
    );

    expect(resposta.status).toBe(404);
    expect(((await resposta.json()) as { error: { code: string } }).error.code).toBe("not_found");
    expect(h.linhas[0]!.title).toBe("Compartilhada da outra org");
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("(7) DELETE de outra organização: 404 e a linha continua lá", async () => {
    h.linhas = [
      linha("alheia", 1000, {
        organization_id: OUTRA_ORG,
        owner_user_id: null,
        title: "Compartilhada da outra org",
      }),
    ];

    const resposta = await DELETE(pedido("DELETE", "/api/v1/message-templates/alheia"), parametros("alheia"));

    expect(resposta.status).toBe(404);
    expect(((await resposta.json()) as { error: { code: string } }).error.code).toBe("not_found");
    expect(h.linhas.map((l) => l.id)).toEqual(["alheia"]);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
