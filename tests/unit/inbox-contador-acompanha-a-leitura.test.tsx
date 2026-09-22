/**
 * #998 — abrir uma conversa não lida tirava o negrito dela, mas deixava o
 * contador de não lidas do topo parado no número velho: só batia depois de
 * recarregar a página.
 *
 * O contador é uma consulta própria — `useConversationCounts`, chave
 * `["conversation-counts", orgId, sufixo]`, onde o sufixo é o filtro que a barra
 * tem ligado. Quem marca a leitura (`useMarkAsRead`) avisava só
 * `["conversations"]` e `["conversation", id]`, e o casamento por prefixo do
 * React Query compara elemento a elemento: nenhuma das duas chaves alcança a do
 * contador — ele nunca repergunta, e o número fica velho na tela.
 *
 * Aqui roda o caminho inteiro: a barra de verdade (que desenha o número), o hook
 * de leitura de verdade e um QueryClient de verdade. Só a camada de rede é
 * dublada, e o servidor de mentira imita o banco — o POST da leitura derruba em 1
 * a contagem de não lidas, como a contagem por assignee faz de verdade.
 *
 * O terceiro caso é o que separa o conserto da INSTÂNCIA (o sufixo que o operador
 * tinha ligado) do conserto da CLASSE (toda a família `conversation-counts`,
 * qualquer sufixo que esteja na tela).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InboxFilters, type InboxFiltersValue } from "@/components/inbox/InboxFilters";
import { useConversationCounts } from "@/hooks/inbox/useConversationCounts";
import { useMarkAsRead } from "@/hooks/inbox/useMarkAsRead";
import { useResumeAiAttendance } from "@/hooks/inbox/useResumeAiAttendance";
import type { ActiveOrg } from "@/lib/auth/types";
import type * as CanaisModule from "@/hooks/channels/useChannelSessions";

const orgRef: { current: ActiveOrg | null } = { current: null };

/**
 * O servidor de mentira. `naoLidas` é a contagem da visão COM o filtro "só não
 * lidos" ligado — a que cai quando uma conversa é lida. `naVisao` é a contagem
 * sem esse filtro, que uma leitura não muda. `consultas` guarda toda pergunta de
 * contagem que chegou, para conferir quem repergunta depois do POST.
 */
const servidor = {
  naoLidas: 3,
  naVisao: 8,
  consultas: [] as string[],
};

const URL_DA_CONTAGEM = "/api/v1/conversations/counts";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "u-1", support: null }, activeOrg: orgRef.current }),
}));
// Só a listagem de números é dublada: `channelLabel` do módulo real é quem
// resolve o rótulo das opções do alternador e não tem nada a ver com o defeito.
vi.mock("@/hooks/channels/useChannelSessions", async (original) => {
  const real = await original<typeof CanaisModule>();
  return { ...real, useChannelSessions: () => ({ data: [] }) };
});
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (url: string) => {
      // A barra passou a perguntar também o vocabulário de etiquetas de CONTATO
      // (`useContactTagVocabulary`, chamado por `InboxFilters`), que não é
      // contagem: responder lista vazia mantém o dublê no papel de rede — e o
      // objeto de contagens não vira o array que a barra combina nas etiquetas.
      if (url.startsWith("/api/v1/contact-tags")) return Promise.resolve({ data: [] });
      servidor.consultas.push(url);
      const n = url.includes("unread=true") ? servidor.naoLidas : servidor.naVisao;
      return Promise.resolve({
        data: { fila: n, automatico: 0, unassigned: n, mine: n, all: n, closed: 0 },
      });
    },
    post: (url: string) => {
      servidor.consultas.push(url);
      if (url.endsWith("/mark-read")) servidor.naoLidas -= 1;
      return Promise.resolve({ data: {} });
    },
  },
}));

/** A tela do inbox: o hook que marca a leitura em cima, a barra de abas embaixo. */
function Tela({
  conversa,
  naoLidas,
  barra,
}: {
  conversa: string | null;
  naoLidas: number;
  barra: InboxFiltersValue;
}) {
  useMarkAsRead(conversa, naoLidas);
  return <InboxFilters value={barra} onChange={() => {}} />;
}

const BARRA_SO_NAO_LIDAS: InboxFiltersValue = { tab: "all", search: "", onlyUnread: true };
const BARRA_SEM_FILTRO: InboxFiltersValue = { tab: "all", search: "", onlyUnread: false };

function montar(barra: InboxFiltersValue) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Tela conversa="conversa-1" naoLidas={1} barra={barra} />
    </QueryClientProvider>,
  );
}

/** O número que o operador vê na aba "Todas" — o badge é o `<span>` da aba. */
function contadorDaAbaTodas(): string | null {
  const aba = screen.getByRole("tab", { name: /Todas/ });
  return aba.querySelector("span")?.textContent ?? null;
}

function perguntasDe(url: string): string[] {
  return servidor.consultas.filter((u) => u === url);
}

beforeEach(() => {
  orgRef.current = { orgId: "org-1", name: "Org", role: "manager", visibility_mode: "all" };
  servidor.naoLidas = 3;
  servidor.naVisao = 8;
  servidor.consultas = [];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("#998 — o contador de não lidas acompanha a leitura", () => {
  it("derruba o número do topo quando a leitura da conversa sai", { timeout: 20_000 }, async () => {
    montar(BARRA_SO_NAO_LIDAS);

    // A barra desenha a contagem da visão de não lidos: 3.
    await waitFor(() => expect(contadorDaAbaTodas()).toBe("3"));

    // O operador fica na conversa e a leitura é registrada (debounce de 1,5s).
    // Sem o conserto o número fica em "3" aqui — e é isso que o operador via
    // como "contador parado" até recarregar a página (o `refetchInterval` da
    // contagem é de 30s, muito depois de qualquer espera razoável na tela).
    await waitFor(() => expect(contadorDaAbaTodas()).toBe("2"), { timeout: 8_000 });
  });

  it("não mexe no número que a leitura de fato não muda", { timeout: 20_000 }, async () => {
    // Controle: a mesma leitura, numa barra sem o filtro de não lidos. O número
    // não pode se mover — se mover, o conserto estaria recalculando na mão em vez
    // de reperguntar a contagem.
    montar(BARRA_SEM_FILTRO);

    await waitFor(() => expect(contadorDaAbaTodas()).toBe("8"));

    // A leitura acontece de verdade (o POST some da fila) e o número continua 8.
    await waitFor(() => expect(perguntasDe(URL_DA_CONTAGEM).length).toBeGreaterThan(0));
    await waitFor(
      () => expect(servidor.consultas.some((u) => u.endsWith("/mark-read"))).toBe(true),
      { timeout: 8_000 },
    );
    expect(contadorDaAbaTodas()).toBe("8");
  });

  it("repergunta TODA contagem da família, não só o sufixo que estava na tela", { timeout: 20_000 }, async () => {
    // A classe do defeito: `conversation-counts` é uma família — o sufixo é o
    // filtro ligado. O conserto vale para a família inteira (invalidação por
    // prefixo em `["conversation-counts"]`), então a contagem SEM filtro, que
    // está na tela, também tem de ser reperguntada depois da leitura — mesmo que
    // o número dela não mude.
    montar(BARRA_SEM_FILTRO);

    await waitFor(() => expect(contadorDaAbaTodas()).toBe("8"));
    expect(perguntasDe(URL_DA_CONTAGEM)).toHaveLength(1);

    await waitFor(() => expect(perguntasDe(URL_DA_CONTAGEM)).toHaveLength(2), { timeout: 8_000 });
    expect(contadorDaAbaTodas()).toBe("8");
  });
});

describe("#998 (irmão do par) — retomar a IA também move o número do bucket", () => {
  it(
    "repergunta a contagem da família quando a conversa volta ao automático",
    { timeout: 20_000 },
    async () => {
      // `usePauseAiAttendance` já invalidava a contagem; o par dele — devolver a
      // conversa ao automático — mandava aviso só para a lista. Os dois hooks aqui
      // são os de verdade; o que se observa é a pergunta que sai para o servidor.
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      );

      const contagem = renderHook(() => useConversationCounts("org-1", { unread: true }), {
        wrapper,
      });
      await waitFor(() => expect(contagem.result.current.data).toBeTruthy());

      const pergunta = `${URL_DA_CONTAGEM}?unread=true`;
      expect(perguntasDe(pergunta)).toHaveLength(1);

      const retomada = renderHook(() => useResumeAiAttendance(), { wrapper });
      await retomada.result.current.mutateAsync({ conversation_id: "conversa-1" });

      await waitFor(() => expect(perguntasDe(pergunta).length).toBeGreaterThan(1), {
        timeout: 8_000,
      });
    },
  );
});
