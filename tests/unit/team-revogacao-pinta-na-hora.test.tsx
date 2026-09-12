import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TeamMember } from "@/hooks/team/useTeamMembers";

/**
 * REVOGAR E DEVOLVER ACESSO PINTAM A LINHA NA HORA.
 *
 * ─── O defeito, achado pela tela ────────────────────────────────────────────
 *
 * Enquanto o revogado SUMIA da lista (a rota o filtrava fora), qualquer atraso
 * de atualização parecia efeito: a linha desaparecia e pronto. Depois que ele
 * passou a FICAR na lista e só o ESTADO mudar, só invalidar a query deixava a
 * linha parada até alguém recarregar a página — quem clicava não via nada
 * acontecer e clicava de novo.
 *
 * ─── Por que o rollback importa tanto quanto a pintura ──────────────────────
 *
 * Pintar sem desfazer é pior que não pintar: uma recusa do servidor deixaria a
 * tela dizendo "ativo" para quem NÃO foi reativado. Os dois lados são cobrados
 * aqui, nos dois hooks.
 *
 * ─── O que este arquivo cobre, e o que não ──────────────────────────────────
 *
 * Cobre o CACHE — que é o que a linha lê. Não cobre pixel: a prova de tela do
 * fluxo de equipe é do Playwright, e está declarada no corpo do PR.
 *
 * ⚠️ O momento é o ponto. `apiClient.post` fica PENDENTE de propósito nos casos
 * de pintura: assertar o cache depois que a promessa resolve não distingue
 * "pintou na hora" de "recarregou no fim" — que é exatamente o defeito. Quem
 * tirar o `onMutate` e deixar só o `invalidateQueries` passa numa asserção
 * feita tarde demais.
 */

const post = vi.fn();
const toastSuccess = vi.fn();
const erroMostrado = vi.fn();

vi.mock("@/lib/api/client", () => ({ apiClient: { post: (...a: unknown[]) => post(...a) } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({
  showApiError: (...a: unknown[]) => erroMostrado(...a),
}));
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a) } }));
// O dicionário tem contexto próprio; aqui o texto degrada para ele mesmo, que é
// o contrato de `traduzir` quando não há entrada.
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

import { useReactivateMember } from "@/hooks/team/useReactivateMember";
import { useRevokeMember } from "@/hooks/team/useRevokeMember";

const MEMBERS_KEY = ["team", "members"] as const;
const ANA = "11111111-1111-4111-8111-111111111111";
const BRUNO = "22222222-2222-4222-8222-222222222222";

function membro(userId: string, revokedAt: string | null): TeamMember {
  return {
    user_id: userId,
    role: "agent",
    invited_at: null,
    accepted_at: "2026-09-01T12:00:00.000Z",
    revoked_at: revokedAt,
    created_at: "2026-09-01T12:00:00.000Z",
    email: `${userId.slice(0, 4)}@exemplo.com.br`,
    full_name: null,
    last_sign_in_at: null,
  };
}

let qc: QueryClient;

/** Uma promessa que EU decido quando (e como) termina. */
function pendente() {
  let resolver!: (v: unknown) => void;
  let rejeitar!: (e: unknown) => void;
  const promessa = new Promise((res, rej) => {
    resolver = res;
    rejeitar = rej;
  });
  post.mockImplementation(() => promessa);
  // A promessa é rejeitada de propósito em alguns casos; sem este `catch` o
  // Node acusa rejeição não tratada e derruba a suíte por fora do teste.
  promessa.catch(() => undefined);
  return { resolver, rejeitar };
}

const linha = (userId: string) =>
  qc.getQueryData<{ data: TeamMember[] }>(MEMBERS_KEY)?.data.find((m) => m.user_id === userId);

function envolve({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  vi.clearAllMocks();
  qc = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  // Ana ATIVA, Bruno REVOGADO — os dois sentidos partem daqui.
  qc.setQueryData(MEMBERS_KEY, {
    data: [membro(ANA, null), membro(BRUNO, "2026-09-05T09:00:00.000Z")],
  });
});

describe("CONTROLE do instrumento", () => {
  it("o cache semeado parte do estado que os casos assumem", () => {
    // Sem isto, um `setQueryData` com chave errada deixaria `linha()` sempre
    // `undefined` e as asserções de estado passariam sobre nada.
    expect(linha(ANA)?.revoked_at).toBeNull();
    expect(linha(BRUNO)?.revoked_at).toBe("2026-09-05T09:00:00.000Z");
  });
});

describe("useRevokeMember", () => {
  it("pinta a linha ANTES de o servidor responder", async () => {
    const { resolver } = pendente();
    const { result } = renderHook(() => useRevokeMember(), { wrapper: envolve });

    act(() => result.current.mutate(ANA));

    await waitFor(() =>
      expect(
        linha(ANA)?.revoked_at,
        "a linha só mudou depois da resposta — quem clicou ficou sem retorno, " +
          "que é o defeito inteiro desta correção",
      ).not.toBeNull(),
    );
    // E o vizinho não foi arrastado junto.
    expect(linha(BRUNO)?.revoked_at).toBe("2026-09-05T09:00:00.000Z");

    await act(async () => {
      resolver({ data: { user_id: ANA } });
    });
  });

  it("DESFAZ quando o servidor recusa — senão a tela mente", async () => {
    const { rejeitar } = pendente();
    const { result } = renderHook(() => useRevokeMember(), { wrapper: envolve });

    act(() => result.current.mutate(ANA));
    await waitFor(() => expect(linha(ANA)?.revoked_at).not.toBeNull());

    await act(async () => {
      rejeitar(new Error("403"));
    });

    await waitFor(() =>
      expect(
        linha(ANA)?.revoked_at,
        "o servidor recusou e a tela continuou dizendo que o acesso foi revogado",
      ).toBeNull(),
    );
    expect(erroMostrado).toHaveBeenCalledTimes(1);
  });
});

describe("useReactivateMember", () => {
  it("pinta a linha ANTES de o servidor responder", async () => {
    const { resolver } = pendente();
    const { result } = renderHook(() => useReactivateMember(), { wrapper: envolve });

    act(() => result.current.mutate(BRUNO));

    await waitFor(() => expect(linha(BRUNO)?.revoked_at).toBeNull());
    expect(linha(ANA)?.revoked_at).toBeNull();

    await act(async () => {
      resolver({ data: { user_id: BRUNO } });
    });
  });

  it("AVISA que deu certo — revogar avisava, devolver não", async () => {
    // É a ação que se faz com receio de ter errado: sem confirmação, quem clicou
    // não sabe se valeu.
    const { resolver } = pendente();
    const { result } = renderHook(() => useReactivateMember(), { wrapper: envolve });

    act(() => result.current.mutate(BRUNO));
    await act(async () => {
      resolver({ data: { user_id: BRUNO } });
    });

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(toastSuccess).toHaveBeenCalledWith("Acesso devolvido.");
  });

  it("recusa do servidor desfaz E não comemora", async () => {
    const { rejeitar } = pendente();
    const { result } = renderHook(() => useReactivateMember(), { wrapper: envolve });

    act(() => result.current.mutate(BRUNO));
    await waitFor(() => expect(linha(BRUNO)?.revoked_at).toBeNull());

    await act(async () => {
      rejeitar(new Error("403"));
    });

    await waitFor(() => expect(linha(BRUNO)?.revoked_at).toBe("2026-09-05T09:00:00.000Z"));
    expect(
      toastSuccess,
      "avisou que o acesso foi devolvido depois de o servidor recusar",
    ).not.toHaveBeenCalled();
    expect(erroMostrado).toHaveBeenCalledTimes(1);
  });
});
