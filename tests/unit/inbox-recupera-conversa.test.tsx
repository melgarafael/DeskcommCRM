import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import { InboxLayout } from "@/components/inbox/InboxLayout";

const { orgId, id, vizinha, eventos, get, lista, lida } = vi.hoisted(() => ({
  orgId: "00000000-0000-4000-8000-000000000450",
  id: "00000000-0000-4000-8000-000000000458",
  vizinha: "00000000-0000-4000-8000-000000000459",
  eventos: new Map<string, (payload: unknown) => void>(),
  get: vi.fn<(url: string, opts?: { signal?: AbortSignal }) => Promise<unknown>>(),
  lista: { data: { pages: [{ data: [] as ReturnType<typeof conversa>[] }], pageParams: [undefined] } },
  lida: vi.fn(),
}));

function conversa(conversaId: string, nome: string) {
  return {
    id: conversaId,
    organization_id: orgId,
    contact_id: conversaId,
    status: "open",
    tags: [],
    unread_count_for_assignee: 1,
    contacts: { id: conversaId, display_name: nome, name: nome, tags: [] },
  };
}

const detalhe = `/api/v1/conversations/${id}`;
const antiga = conversa(id, "Nome da lista antiga");
const atual = conversa(id, "Nome conferido na API");
const recuperar = "Tentar novamente";
const semAcesso = "Conversa não encontrada ou fora do seu acesso.";

vi.mock("@/lib/api/client", () => ({ apiClient: { get } }));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: ({ name, onChange }: { name: string; onChange: (payload: unknown) => void }) => {
    eventos.set(name, onChange);
    return { status: "subscribed", ultimaEntrega: { current: null } };
  },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inbox",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "atendente", role: "admin" }, activeOrg: { orgId } }),
  usePermission: () => true,
}));
vi.mock("@/hooks/inbox/useConversationsRealtime", () => ({ useConversationsRealtime: () => lista }));
vi.mock("@/hooks/inbox/useMarkAsRead", () => ({ useMarkAsRead: lida }));
vi.mock("@/components/inbox/ConversationList", () => ({
  ConversationList: ({ listQuery, onSelect }: {
    listQuery: typeof lista;
    onSelect: (id: string) => void;
  }) => listQuery.data.pages.flatMap((p) => p.data).map((c) => (
    <button key={c.id} onClick={() => onSelect(c.id)}>Abrir {c.contacts.display_name}</button>
  )),
}));
vi.mock("@/components/inbox/ConversationHeader", () => ({
  ConversationHeader: ({ conversation }: { conversation: ReturnType<typeof conversa> }) => (
    <h2>{conversation.contacts.display_name}</h2>
  ),
}));
vi.mock("@/components/inbox/ChatThread", () => ({ ChatThread: () => <p>Fio da conversa aberta</p> }));
vi.mock("@/components/inbox/Composer", () => ({
  Composer: ({ suspenso }: { suspenso?: boolean }) => {
    const [texto, setTexto] = useState("");
    return suspenso ? null : (
      <textarea aria-label="Resposta" value={texto} onChange={(e) => setTexto(e.target.value)} />
    );
  },
}));
vi.mock("@/components/inbox/CRMSidePanel", () => ({ CRMSidePanel: () => null }));
vi.mock("@/components/inbox/InboxFilters", () => ({ InboxFilters: () => null }));
vi.mock("@/components/inbox/PainelIniciarConversa", () => ({ BotaoIniciarConversa: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/JanelaFechadaAviso", () => ({ JanelaFechadaAviso: () => null }));
vi.mock("@/components/inbox/NumeroForaDoAr", () => ({ NumeroForaDoAr: () => null }));

let qc: QueryClient;

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  lista.data.pages[0].data = [antiga, conversa(vizinha, "Outra conversa")];
  eventos.clear();
  lida.mockClear();
  get.mockReset();
  get.mockImplementation(async (url) => {
    if (url === detalhe) return { data: antiga };
    if (url === "/api/v1/ai/automatico-ativo") return { data: { ativo: false } };
    return { data: [] };
  });
  window.history.replaceState(null, "", "/app/inbox?filter=all");
});

afterEach(() => {
  cleanup();
  qc.clear();
});

function montar() {
  return render(<QueryClientProvider client={qc}><InboxLayout /></QueryClientProvider>);
}

async function reassinar() {
  const evento = eventos.get(`participacoes-${orgId}-atendente`);
  expect(evento).toBeDefined();
  await act(async () => evento?.({ tipo: "reassinado" }));
}

async function abrirDaLista() {
  fireEvent.click(screen.getByRole("button", { name: "Abrir Nome da lista antiga" }));
  await screen.findByRole("heading", { name: "Nome da lista antiga" });
}

describe("Inbox depois de reassinar as participações (#4508)", () => {
  it.each(["lista", "link direto"])("recupera a conversa e a resposta depois de um 503 (%s)", async (entrada) => {
    if (entrada === "link direto") {
      lista.data.pages[0].data = [];
      window.history.replaceState(null, "", `/app/inbox?filter=all&id=${id}`);
    }
    montar();
    if (entrada === "lista") await abrirDaLista();
    fireEvent.change(await screen.findByRole("textbox", { name: "Resposta" }), {
      target: { value: "Resposta que ainda estou escrevendo" },
    });
    const endereco = window.location.href;
    const lerAntes = get.getMockImplementation()!;
    let falha = true;
    get.mockImplementation(async (url, opts) => {
      if (url !== detalhe) return lerAntes(url, opts);
      if (falha) throw new ApiError(503, "temporariamente_indisponivel", undefined, "teste");
      return { data: atual };
    });

    await reassinar();
    const tentar = await screen.findByRole("button", { name: recuperar });
    expect(screen.queryByRole("textbox", { name: "Resposta" })).toBeNull();
    expect(screen.queryByText("Fio da conversa aberta")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Nome da lista antiga" })).toBeNull();
    falha = false;
    fireEvent.click(tentar);

    expect(await screen.findByRole("heading", { name: "Nome conferido na API" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Resposta" })).toHaveValue("Resposta que ainda estou escrevendo");
    expect(window.location.href).toBe(endereco);
  });

  it("fecha os dados e tira a linha antiga quando a leitura confirma 404", async () => {
    montar();
    await abrirDaLista();
    const lerAntes = get.getMockImplementation()!;
    let responderHistorico!: () => void;
    const aguardandoHistorico = new Promise<void>((resolve) => { responderHistorico = resolve; });
    get.mockImplementation(async (url, opts) => {
      if (url === detalhe) return { data: atual };
      if (url.startsWith(`${detalhe}/messages`)) {
        await aguardandoHistorico;
        throw new ApiError(404, "not_found", undefined, "teste");
      }
      return lerAntes(url, opts);
    });

    await reassinar();
    await waitFor(() => expect(get.mock.calls.some(([url]) => url.startsWith(`${detalhe}/messages`))).toBe(true));
    expect(screen.queryByText("Fio da conversa aberta")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Resposta" })).toBeNull();
    expect(lida.mock.lastCall?.[0]).toBeNull();
    await act(async () => responderHistorico());

    expect(await screen.findByText(semAcesso)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Abrir Nome da lista antiga" })).toBeNull();
    expect(screen.getByRole("button", { name: "Abrir Outra conversa" })).toBeVisible();
    expect(window.location.search).toContain(`id=${id}`);
  });
});
