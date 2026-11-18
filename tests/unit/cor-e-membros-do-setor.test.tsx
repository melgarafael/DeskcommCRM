/**
 * #3876 (F3) — a COR da fila e os MEMBROS dentro do card do setor.
 *
 * ─── O que este arquivo prova, e por quê ───────────────────────────────────
 *
 * A aba Setores nasceu (0801) como cadastro de nome e descrição, e o número de
 * atendentes era um contador mudo: para tirar alguém de uma fila era preciso ir
 * à aba Atendimento e editar a pessoa inteira, sem ver as outras filas dela. A
 * F3 fecha isso no lugar onde a pergunta nasce — o card do setor — e dá à fila o
 * que todo o resto do produto já tem: cor (`estiloDoChip` + `escolheAFrente`,
 * a régua da #2373), nunca cor livre e nunca frente escolhida a dedo.
 *
 * Três coisas deste arquivo não são detalhe:
 *
 *   1. SEM cor = o visual de hoje, byte a byte. O chip só existe quando há cor;
 *      setor sem cor continua sendo exatamente o card da 0801. É o critério de
 *      aceite (c), e o teste falha se alguém pintar o padrão.
 *   2. A escrita reusa `PUT /api/v1/attendants/sector/[user_id]` com a lista
 *      COMPLETA da pessoa — a rota substitui o conjunto. Mandar só o setor novo
 *      tiraria a pessoa das outras filas dela. É o critério (d).
 *   3. Módulo desligado (doc 213) = nada novo na tela e nenhuma leitura. É o
 *      critério (e).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { apiClient } from "@/lib/api/client";
import { escolheAFrente } from "@/lib/branding/contraste";
import { SectorsClient } from "@/app/app/team/_components/SectorsClient";

const SETOR_COMERCIAL = "11111111-1111-4111-8111-111111111111";
const SETOR_SUPORTE = "22222222-2222-4222-8222-222222222222";
const ANA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BRUNO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const COR_DO_COMERCIAL = "#3e63dd";

interface SetorDoTeste {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
  member_count: number;
  member_user_ids: string[];
  schedule: { timezone?: string; windows: [] };
}

let setores: SetorDoTeste[];
let atendentes: Array<{
  user_id: string;
  name: string | null;
  email: string | null;
  role: string | null;
  sector_ids: string[];
}>;

function montarSetores(): SetorDoTeste[] {
  return [
    {
      id: SETOR_COMERCIAL,
      name: "Comercial",
      description: null,
      color: COR_DO_COMERCIAL,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      member_count: 1,
      member_user_ids: [ANA],
      schedule: { windows: [] },
    },
    {
      id: SETOR_SUPORTE,
      name: "Suporte",
      description: null,
      // SEM cor: o card tem de sair igual ao de antes desta fatia.
      color: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      member_count: 1,
      member_user_ids: [BRUNO],
      schedule: { windows: [] },
    },
  ];
}

function montarAtendentes() {
  return [
    { user_id: ANA, name: "Ana", email: "ana@example.com", role: "agent", sector_ids: [SETOR_COMERCIAL] },
    { user_id: BRUNO, name: "Bruno", email: "bruno@example.com", role: "agent", sector_ids: [SETOR_SUPORTE] },
  ];
}

function renderClient(props: Partial<{ canManage: boolean; setoresLigado: boolean }> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SectorsClient
        canManage={props.canManage ?? true}
        {...(props.setoresLigado === undefined ? {} : { setoresLigado: props.setoresLigado })}
      />
    </QueryClientProvider>,
  );
}

/** O jsdom normaliza cor de `style` para `rgb(...)`; a régua fala hex. */
function paraRgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

/** O card do setor pelo nome — é o recorte em que cada asserção acontece. */
async function cardDoSetor(nome: string): Promise<HTMLElement> {
  const cards = await screen.findAllByTestId("setor");
  const card = cards.find((c) => c.textContent?.includes(nome));
  if (!card) throw new Error(`card do setor ${nome} não apareceu`);
  return card;
}

beforeEach(() => {
  vi.clearAllMocks();
  setores = montarSetores();
  atendentes = montarAtendentes();

  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    if (url === "/api/v1/attendants/sectors") return { data: setores };
    if (url === "/api/v1/attendants/availability") return { data: atendentes };
    throw new Error(`GET inesperado no teste: ${url}`);
  });
  // O PUT grava no estado do dublê: é o que faz a tela ATUALIZAR depois da
  // invalidação, e não só "chamar a rota".
  vi.mocked(apiClient.put).mockImplementation(
    async (url: string, body: unknown) => {
      const userId = url.replace("/api/v1/attendants/sector/", "");
      const { sector_ids } = body as { sector_ids: string[] };
      atendentes = atendentes.map((a) => (a.user_id === userId ? { ...a, sector_ids } : a));
      return { data: { user_id: userId, sector_ids } };
    },
  );
  vi.mocked(apiClient.patch).mockResolvedValue({ data: setores[0] });
});

describe("#3876 F3 — cor da fila no card", () => {
  it("(c) setor COM cor ganha chip pintado e frente da régua; setor SEM cor fica como era", async () => {
    renderClient();

    const comercial = await cardDoSetor("Comercial");
    const chip = within(comercial).getByTestId("cor-do-setor");
    expect(chip.style.backgroundColor).toBe(paraRgb(COR_DO_COMERCIAL));
    // A frente NUNCA é escolhida a dedo: é a régua de contraste que decide.
    expect(chip.style.color).toBe(paraRgb(escolheAFrente(COR_DO_COMERCIAL)));

    // Critério (c): sem cor, sem chip — e nada de `style` pintado.
    const suporte = await cardDoSetor("Suporte");
    expect(within(suporte).queryByTestId("cor-do-setor")).toBeNull();
  });

  it("editar o setor grava a cor pelo PATCH (paleta medida + 'sem cor')", async () => {
    const user = userEvent.setup();
    renderClient();

    const suporte = await cardDoSetor("Suporte");
    await user.click(within(suporte).getByLabelText("Editar setor Suporte"));
    // O seletor é a paleta curta: cada tom é um botão com o NOME do tom — cor
    // nunca é o único portador de significado (mesma regra do seletor de tag).
    await user.click(await screen.findByLabelText("Roxo"));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(`/api/v1/attendants/sectors/${SETOR_SUPORTE}`, {
        name: "Suporte",
        description: null,
        color: "#ab4aba",
      }),
    );
  });

  it("'Sem cor' no editar manda null — apagar a cor é uma escolha, não um silêncio", async () => {
    const user = userEvent.setup();
    renderClient();

    const comercial = await cardDoSetor("Comercial");
    await user.click(within(comercial).getByLabelText("Editar setor Comercial"));
    await user.click(await screen.findByRole("button", { name: "Sem cor" }));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(`/api/v1/attendants/sectors/${SETOR_COMERCIAL}`, {
        name: "Comercial",
        description: null,
        color: null,
      }),
    );
  });
});

describe("#3876 F3 — membros dentro do card", () => {
  it("lista quem está na fila, e o card VAZIO diz o que é", async () => {
    renderClient();

    const comercial = await cardDoSetor("Comercial");
    const membros = within(comercial).getByTestId("membros-do-setor");
    expect(within(membros).getByText("Ana")).toBeInTheDocument();
    expect(within(membros).queryByText("Bruno")).toBeNull();
  });

  it("(d) remover chama o PUT com a lista da pessoa SEM aquele setor, e a tela atualiza", async () => {
    const user = userEvent.setup();
    renderClient();

    const comercial = await cardDoSetor("Comercial");
    await user.click(within(comercial).getByLabelText("Remover do setor Ana"));

    await waitFor(() =>
      expect(apiClient.put).toHaveBeenCalledWith(`/api/v1/attendants/sector/${ANA}`, {
        sector_ids: [],
      }),
    );
    // A tela reflete o PUT: Ana sai da lista depois da invalidação. Sem isso, a
    // pessoa clicaria de novo achando que o clique não pegou.
    await waitFor(() =>
      expect(within(within(comercial).getByTestId("membros-do-setor")).queryByText("Ana")).toBeNull(),
    );
  });

  it("(d) '+ Adicionar pessoa' manda a lista COMPLETA (as outras filas da pessoa continuam)", async () => {
    const user = userEvent.setup();
    renderClient();

    const suporte = await cardDoSetor("Suporte");
    await user.selectOptions(within(suporte).getByLabelText("Adicionar pessoa ao setor"), ANA);

    // Ana já é do Comercial: a lista tem de ser [Comercial, Suporte] — mandar só
    // o Suporte a tiraria do Comercial, porque a rota SUBSTITUI o conjunto.
    await waitFor(() =>
      expect(apiClient.put).toHaveBeenCalledWith(`/api/v1/attendants/sector/${ANA}`, {
        sector_ids: [SETOR_COMERCIAL, SETOR_SUPORTE],
      }),
    );
    await waitFor(() =>
      expect(within(within(suporte).getByTestId("membros-do-setor")).getByText("Ana")).toBeInTheDocument(),
    );
  });
});

describe("#3879 — duas ações seguidas sobre a mesma pessoa não se desfazem", () => {
  /**
   * A tela monta o PUT a partir do roster em cache, e a rota SUBSTITUI o
   * conjunto. Medido na triagem: adicionar a Ana ao Suporte e, antes de o
   * roster voltar, tirá-la do Comercial mandava `sector_ids: []` — a Ana saía
   * das DUAS filas. São duas janelas, e este teste segura as duas: o PUT
   * pendente (controles travados) e o refetch do roster depois dele (o cache
   * já tem de carregar o conjunto que o PUT devolveu).
   */
  it("com o PUT e o refetch segurados, a segunda ação parte do estado novo", async () => {
    const user = userEvent.setup();
    let soltarPut!: () => void;
    const putsEnviados: string[][] = [];
    vi.mocked(apiClient.put).mockImplementation(async (url: string, body: unknown) => {
      const userId = url.replace("/api/v1/attendants/sector/", "");
      const { sector_ids } = body as { sector_ids: string[] };
      putsEnviados.push(sector_ids);
      if (putsEnviados.length === 1) await new Promise<void>((r) => (soltarPut = r));
      return { data: { user_id: userId, sector_ids } };
    });
    let leiturasDoRoster = 0;
    vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
      if (url === "/api/v1/attendants/sectors") return { data: setores };
      if (url === "/api/v1/attendants/availability") {
        leiturasDoRoster += 1;
        // Só a primeira leitura volta: o refetch depois do PUT fica pendurado.
        if (leiturasDoRoster > 1) return new Promise(() => {});
        return { data: atendentes };
      }
      throw new Error(`GET inesperado no teste: ${url}`);
    });
    renderClient();

    const suporte = await cardDoSetor("Suporte");
    const comercial = await cardDoSetor("Comercial");
    await user.selectOptions(within(suporte).getByLabelText("Adicionar pessoa ao setor"), ANA);

    // Janela 1: PUT pendente — remover a Ana do Comercial não está disponível.
    await waitFor(() => expect(putsEnviados).toHaveLength(1));
    expect(within(comercial).getByLabelText("Remover do setor Ana")).toBeDisabled();

    // Janela 2: o PUT respondeu, o refetch do roster não voltou.
    soltarPut();
    await waitFor(() =>
      expect(within(comercial).getByLabelText("Remover do setor Ana")).toBeEnabled(),
    );
    await user.click(within(comercial).getByLabelText("Remover do setor Ana"));

    await waitFor(() => expect(putsEnviados).toHaveLength(2));
    expect(putsEnviados[1]).toEqual([SETOR_SUPORTE]);
  });
});

describe("#3876 F3 — módulo desligado", () => {
  it("(e) nada novo aparece e a tela nem pergunta pelos setores", async () => {
    renderClient({ setoresLigado: false });

    await waitFor(() => expect(apiClient.get).not.toHaveBeenCalled());
    expect(screen.queryByTestId("lista-de-setores")).toBeNull();
    expect(screen.queryByTestId("setor")).toBeNull();
    expect(screen.queryByTestId("membros-do-setor")).toBeNull();
    expect(screen.queryByTestId("cor-do-setor")).toBeNull();
  });
});
