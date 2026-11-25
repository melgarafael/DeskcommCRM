import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { ComposerHandle, RascunhoDoComposer } from "@/components/inbox/Composer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import { InboxLayout } from "@/components/inbox/InboxLayout";

const { orgId, id, vizinha, eventos, get, post, lista, lida } = vi.hoisted(() => ({
  orgId: "00000000-0000-4000-8000-000000000450",
  id: "00000000-0000-4000-8000-000000000458",
  vizinha: "00000000-0000-4000-8000-000000000459",
  eventos: new Map<string, (payload: unknown) => void>(),
  post: vi.fn(async () => ({ data: {} })),
  get: vi.fn<(url: string, opts?: { signal?: AbortSignal }) => Promise<unknown>>(),
  lista: { data: { pages: [{ data: [] as LinhaDaLista[], consultaIniciadaEm: 0 }], pageParams: [undefined] } },
  lida: vi.fn(),
}));

type LinhaDaLista = {
  id: string;
  organization_id: string;
  contact_id: string;
  status: string;
  tags: string[];
  unread_count_for_assignee: number;
  contacts: { id: string; display_name: string; name: string; tags: string[] };
};

function conversa(conversaId: string, nome: string): LinhaDaLista {
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

vi.mock("@/lib/api/client", () => ({ apiClient: { get, post } }));
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
  ConversationList: ({ listQuery, onSelect, onVisibleChange }: {
    listQuery: typeof lista;
    onSelect: (id: string) => void;
    onVisibleChange: (ids: string[]) => void;
  }) => {
    useEffect(() => onVisibleChange(listQuery.data.pages.flatMap((p) => p.data.map((c) => c.id))),
      [listQuery.data, onVisibleChange]);
    return listQuery.data.pages.flatMap((p) => p.data).map((c) => (
      <button key={c.id} onClick={() => onSelect(c.id)}>Abrir {c.contacts.display_name}</button>
    ));
  },
}));
vi.mock("@/components/inbox/ConversationHeader", () => ({
  ConversationHeader: ({ conversation }: { conversation: ReturnType<typeof conversa> }) => (
    <h2>{conversation.contacts.display_name}</h2>
  ),
}));
vi.mock("@/components/inbox/ChatThread", () => ({ ChatThread: () => <p>Fio da conversa aberta</p> }));
vi.mock("@/components/inbox/Composer", () => ({
  Composer: ({ suspenso, ref, rascunhoGuardado }: {
    suspenso?: boolean; ref?: Ref<ComposerHandle>; rascunhoGuardado?: RascunhoDoComposer | null;
  }) => {
    const [texto, setTexto] = useState(rascunhoGuardado?.texto ?? "");
    const campo = useRef<HTMLTextAreaElement | null>(null);
    useImperativeHandle(ref, () => ({
      focus: () => campo.current?.focus(),
      estaEditando: () => campo.current === document.activeElement,
      guardarRascunho: () => ({ texto, arquivos: [], legenda: null, modo: "reply", modoDosArquivos: "reply",
        mencoes: [], cursor: texto.length, sugestaoUsada: false }),
    }));
    return suspenso ? null : (
      <textarea ref={campo} aria-label="Resposta" value={texto} onChange={(e) => setTexto(e.target.value)} />
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
  lista.data.pages[0]!.data = [antiga, conversa(vizinha, "Outra conversa")];
  lista.data.pages[0]!.consultaIniciadaEm = 0;
  eventos.clear();
  lida.mockClear();
  get.mockReset();
  post.mockClear();
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
      lista.data.pages[0]!.data = [];
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
    const chaveDaLista = ["conversations", { status: "open" }];
    const listaAntiga = lista.data;
    qc.setQueryData(chaveDaLista, listaAntiga);
    let responderLista!: () => void;
    const aguardandoLista = new Promise<void>((resolve) => { responderLista = resolve; });
    const listaEmVoo = qc.fetchQuery({ queryKey: chaveDaLista, queryFn: async () => {
      await aguardandoLista;
      return listaAntiga;
    } }).catch(() => undefined);
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
    await act(async () => {
      responderLista();
      await listaEmVoo;
    });
    expect(qc.getQueryData<typeof listaAntiga>(chaveDaLista)?.pages[0]?.data.map((c) => c.id)).toEqual([vizinha]);
  });

  it("aceita uma nova leitura da lista após a perda de acesso", async () => {
    const tela = montar();
    await abrirDaLista();
    const lerAntes = get.getMockImplementation()!;
    let podeVer = false;
    get.mockImplementation(async (url, opts) => {
      if (url !== detalhe) return lerAntes(url, opts);
      if (!podeVer) throw new ApiError(404, "not_found", undefined, "teste");
      return { data: atual };
    });
    await reassinar();
    await screen.findByText(semAcesso);

    podeVer = true;
    lista.data = { ...lista.data, pages: [{ ...lista.data.pages[0]!, consultaIniciadaEm: performance.now() }] };
    await act(async () => tela.rerender(<QueryClientProvider client={qc}><InboxLayout /></QueryClientProvider>));
    expect(await screen.findByRole("heading", { name: "Nome conferido na API" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Abrir Nome da lista antiga" })).toBeVisible();
  });

  it("mostra a entrada de login e descarta o rascunho se a sessão foi revogada", async () => {
    montar();
    await abrirDaLista();
    fireEvent.change(screen.getByRole("textbox", { name: "Resposta" }), { target: { value: "Rascunho anterior" } });
    const lerAntes = get.getMockImplementation()!;
    get.mockImplementation(async (url, opts) => {
      if (url === detalhe) throw new ApiError(401, "unauthenticated", undefined, "teste");
      return lerAntes(url, opts);
    });
    await reassinar();
    expect(await screen.findByRole("link", { name: "Entrar" })).toHaveAttribute("href", expect.stringContaining("/login?next="));
    expect(screen.queryByRole("textbox", { name: "Resposta" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Abrir/ })).toBeNull();
  });


  it("preserva o foco da resposta e bloqueia atalhos enquanto confirma o acesso", async () => {
    montar();
    await abrirDaLista();
    const campo = screen.getByRole("textbox", { name: "Resposta" });
    campo.focus();
    fireEvent.change(campo, { target: { value: "Resposta pela metade" } });
    const antes = get.getMockImplementation()!;
    let responder!: () => void;
    const leitura = new Promise<void>((resolve) => { responder = resolve; });
    get.mockImplementation(async (url, opts) => {
      if (url !== detalhe) return antes(url, opts);
      await leitura;
      return { data: atual };
    });
    const endereco = window.location.href;
    await reassinar();
    fireEvent.keyDown(document.body, { key: "j", code: "KeyJ" });
    fireEvent.keyDown(document.body, { key: "a", code: "KeyA" });
    expect(window.location.href).toBe(endereco);
    expect(post).not.toHaveBeenCalled();
    await act(async () => responder());

    const restaurado = await screen.findByRole("textbox", { name: "Resposta" });
    expect(restaurado).toHaveFocus();
    expect(restaurado).toHaveValue("Resposta pela metade");
    fireEvent.keyDown(restaurado, { key: "a", code: "KeyA" });
    expect(post).not.toHaveBeenCalled();
  });

  it("mantém o editor na navegação normal entre conversas da lista", async () => {
    montar();
    await abrirDaLista();
    const campo = screen.getByRole("textbox", { name: "Resposta" });
    fireEvent.change(campo, { target: { value: "Rascunho aberto" } });
    fireEvent.click(screen.getByRole("button", { name: "Abrir Outra conversa" }));
    expect(await screen.findByRole("heading", { name: "Outra conversa" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Resposta" })).toBe(campo);
    fireEvent.click(screen.getByRole("button", { name: "Abrir Nome da lista antiga" }));
    expect(campo).toHaveValue("Rascunho aberto");
  });


  it("recupera cada rascunho ao voltar para a conversa em uma rodada de reconexão", async () => {
    montar();
    await abrirDaLista();
    const antes = get.getMockImplementation()!;
    get.mockImplementation(async (url, opts) => {
      if (url === detalhe) return { data: atual };
      if (url === `/api/v1/conversations/${vizinha}`) return { data: conversa(vizinha, "Outra conversa") };
      return antes(url, opts);
    });
    await reassinar();
    await screen.findByRole("heading", { name: "Nome conferido na API" });
    fireEvent.change(screen.getByRole("textbox", { name: "Resposta" }), { target: { value: "Rascunho de A" } });
    fireEvent.click(screen.getByRole("button", { name: "Abrir Outra conversa" }));
    await screen.findByRole("heading", { name: "Outra conversa" });
    const campoB = screen.getByRole("textbox", { name: "Resposta" });
    expect(campoB).toHaveValue("");
    fireEvent.change(campoB, { target: { value: "Rascunho de B" } });
    fireEvent.click(screen.getByRole("button", { name: "Abrir Nome da lista antiga" }));
    await screen.findByRole("heading", { name: "Nome conferido na API" });
    expect(screen.getByRole("textbox", { name: "Resposta" })).toHaveValue("Rascunho de A");
    fireEvent.click(screen.getByRole("button", { name: "Abrir Outra conversa" }));
    await screen.findByRole("heading", { name: "Outra conversa" });
    expect(screen.getByRole("textbox", { name: "Resposta" })).toHaveValue("Rascunho de B");
  });

});
