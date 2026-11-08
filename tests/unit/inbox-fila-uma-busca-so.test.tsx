import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A FILA DO INBOX CONSULTA UMA VEZ — a resposta do `automatico-ativo` não pode
 * gerar uma segunda chave (nem um segundo GET em série).
 *
 * ─── O defeito, medido no trace do #2360 (run 37340942770) ───────────────────
 *
 *   conversations?comando=aguardando            1091ms
 *   conversations?comando=aguardando,automatico  896ms
 *
 * Os dois pedidos são a MESMA lista. O primeiro sai porque `comandosDaFila` trata
 * `undefined` ("não sei se a org tem automático") como "assume que há" — e com o
 * automático DESLIGADO na org a resposta troca a chave para
 * `aguardando,automatico`, o react-query abre uma query NOVA e a primeira
 * resposta é DESCARTADA. Custo para quem usa: ~1 s de esqueleto a cada carga do
 * inbox, pagando duas voltas de rede por uma lista.
 *
 * ─── O conserto medido aqui ────────────────────────────────────────────────
 *
 * A chave é ESTABILIZADA antes de consultar: a Fila (aba `unassigned`) só dispara
 * o GET depois de o fato org-wide responder, então sai UMA requisição — com o
 * `comando` definitivo. As abas que não dependem do fato (Todas, Minhas,
 * Fechadas, Automático) seguem consultando na hora, como antes.
 *
 * ─── Por que estes três casos ──────────────────────────────────────────────
 *
 *   1. org SEM automático → antes do conserto são 2 GET; depois, 1. É este que
 *      reprova sem o gate (e o `expect(listas()).toHaveLength(0)` do começo
 *      reprova já no primeiro GET, que é o descartado);
 *   2. aba que NÃO depende do fato → a lista não pode passar a esperar: o gate
 *      é da Fila, não do inbox inteiro (controle contra "segurar tudo");
 *   3. org COM automático → o filtro efetivo não mudava antes e não pode mudar
 *      agora: a Fila continua pedindo só `aguardando`, sem `automatico` de
 *      carona.
 *
 * O trabalho é no encontro do hook com o layout, então os dois são REAIS — só os
 * vizinhos (realtime, toast, linhas, cabeçalho) são dublês.
 *
 * SABOTAGEM (medida antes do conserto, com este arquivo já no repositório):
 * consultar a Fila sem esperar o fato da org — `useConversationsRealtime(filters,
 * orgId)` sem o terceiro argumento, ou soltar o `enabled` do hook — reproduz
 * 1 failed | 2 passed: o caso 1 reprova JÁ na primeira asserção, com
 * "a Fila consultou antes de saber se a org tem automático: expected length 0,
 * got 1" (o GET que a resposta do `automatico-ativo` descarta).
 */

const { ORG, AUTOMATICO } = vi.hoisted(() => ({
  ORG: "00000000-0000-4000-8000-0000000000aa",
  AUTOMATICO: "/api/v1/ai/automatico-ativo",
}));

/**
 * CADA GET FICA EM BOLSA — o teste decide quando a resposta chega. Sem isso não
 * há como afirmar "a lista ainda não foi pedida" nem "só uma vez": a ordem das
 * respostas é justamente o defeito.
 */
const chamadas = vi.hoisted(
  () =>
    [] as {
      url: string;
      resolver: (resposta: unknown) => void;
      recusar: (erro: unknown) => void;
    }[],
);
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (url: string) =>
      new Promise((resolver, recusar) => {
        chamadas.push({ url, resolver, recusar });
      }),
  },
}));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
}));
vi.mock("@/components/inbox/ConversationListItem", () => ({
  ConversationListItem: ({ conversation }: { conversation: { id: string } }) => (
    <div data-testid="linha">{conversation.id}</div>
  ),
}));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: () => ({ status: "subscribed", ultimaEntrega: { current: null } }),
}));
vi.mock("@/hooks/realtime/useRefetchDeSeguranca", () => ({ useRefetchDeSeguranca: () => ({}) }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/lib/supabase/browser", () => ({
  prepareRealtimeAuthentication: vi.fn().mockResolvedValue(undefined),
  createClient: () => ({
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inbox",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "u-1", role: "admin" }, activeOrg: { orgId: ORG } }),
  usePermission: () => true,
}));
vi.mock("@/hooks/inbox/useMarkAsRead", () => ({ useMarkAsRead: () => undefined }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/components/inbox/CRMSidePanel", () => ({ CRMSidePanel: () => null }));
vi.mock("@/components/inbox/InboxFilters", () => ({ InboxFilters: () => null }));
vi.mock("@/components/inbox/ChatThread", () => ({ ChatThread: () => null }));
vi.mock("@/components/inbox/Composer", () => ({ Composer: () => null }));
vi.mock("@/components/inbox/ConversationHeader", () => ({ ConversationHeader: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/InboxKeyboardShortcuts", () => ({
  InboxKeyboardShortcuts: () => null,
}));
vi.mock("@/components/inbox/ShortcutsHelpDialog", () => ({ ShortcutsHelpDialog: () => null }));
vi.mock("@/components/inbox/JanelaFechadaAviso", () => ({ JanelaFechadaAviso: () => null }));

import { InboxLayout } from "@/components/inbox/InboxLayout";

/** As buscas da LISTA — o que este teste conta. */
function listas() {
  return chamadas.filter((c) => c.url.startsWith("/api/v1/conversations?"));
}

/**
 * A única busca da lista — afirma a contagem antes de devolvê-la, e sem `[0]`
 * solto: o typecheck do repositório é estrito (`noUncheckedIndexedAccess`).
 */
function unicaLista() {
  const buscas = listas();
  expect(buscas).toHaveLength(1);
  const [primeira] = buscas;
  if (!primeira) throw new Error("nenhum GET da lista");
  return primeira;
}

function busca(url: string) {
  const chamada = chamadas.find((c) => c.url === url);
  if (!chamada) {
    throw new Error(`nenhum GET para ${url} — pedidos: ${chamadas.map((c) => c.url).join(", ")}`);
  }
  return chamada;
}

/** O `comando` que a URL pediu — `null` quando não há filtro de comando. */
function comando(url: string) {
  return new URLSearchParams(url.split("?")[1] ?? "").get("comando");
}

function esqueletos(): number {
  return document.querySelectorAll("[data-esqueleto]").length;
}

async function entregar(url: string, resposta: unknown) {
  await act(async () => {
    busca(url).resolver(resposta);
  });
}

/** Deixa o próximo ciclo do react-query rodar — é onde o 2º GET apareceria. */
async function assentar() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InboxLayout />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  chamadas.length = 0;
  window.history.replaceState(null, "", "/app/inbox");
});
afterEach(() => cleanup());

describe("a lista do inbox consulta UMA vez quando o filtro efetivo muda (#2365)", () => {
  it("⭐ org SEM automático: a Fila espera o fato da org e busca uma vez só", async () => {
    montar();

    // A pergunta org-wide sai primeiro — e é ELA que decide o filtro da Fila.
    await waitFor(() => expect(chamadas.some((c) => c.url === AUTOMATICO)).toBe(true));
    // ANTES do conserto, aqui já havia UM GET da lista (chave `aguardando`) — o
    // que a resposta do automático descartava. É este o dado jogado no lixo.
    expect(listas(), "a Fila consultou antes de saber se a org tem automático").toHaveLength(0);
    // E a espera não mente sobre o estado: esqueleto, nunca "caixa vazia".
    expect(esqueletos()).toBeGreaterThan(0);
    expect(screen.queryByText(/Sem conversas por aqui/)).not.toBeInTheDocument();

    await entregar(AUTOMATICO, { data: { ativo: false } });

    // UMA requisição, com o filtro DEFINITIVO da Fila de uma org sem automático.
    // `ninguem` desde a 9252: é o valor que o campo calculado emite quando a
    // organização não tem agente publicado (#4012).
    await waitFor(() => expect(listas()).toHaveLength(1));
    expect(comando(unicaLista().url)).toBe("aguardando,ninguem");

    // E nenhuma segunda chave depois: nada de GET em série.
    await assentar();
    expect(listas(), "segundo GET em série depois da resposta do automático").toHaveLength(1);
  });

  it("aba que NÃO depende do fato (Todas) segue consultando na hora — o gate é da Fila", async () => {
    window.history.replaceState(null, "", "/app/inbox?filter=all");
    montar();

    await waitFor(() => expect(listas()).toHaveLength(1));
    expect(comando(unicaLista().url)).toBeNull();

    // O fato org-wide foi pedido — o cabeçalho e a lista o leem para o rótulo —
    // mas não segura a lista de uma aba que não o usa.
    await assentar();
    expect(listas()).toHaveLength(1);
  });

  it("org COM automático: a Fila continua pedindo só `aguardando` — uma busca, filtro igual", async () => {
    montar();
    await waitFor(() => expect(chamadas.some((c) => c.url === AUTOMATICO)).toBe(true));

    await entregar(AUTOMATICO, { data: { ativo: true } });

    await waitFor(() => expect(listas()).toHaveLength(1));
    expect(comando(unicaLista().url)).toBe("aguardando");

    await assentar();
    expect(listas()).toHaveLength(1);
  });
});
