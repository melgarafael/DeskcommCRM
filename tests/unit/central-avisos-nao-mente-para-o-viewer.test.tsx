/**
 * A CENTRAL DE AVISOS NÃO DIZ A QUEM NÃO A ALCANÇA QUE NÃO HÁ AVISO NENHUM
 * (issue #3147).
 *
 * ─── O defeito, na tela ─────────────────────────────────────────────────────
 *
 * A Central exige o papel `agent` (`PAPEL_MINIMO_DA_CENTRAL`, que as três rotas
 * de `/api/v1/ai/inbox` passam a `requireRole`). Para um `viewer` a consulta do
 * hook fica DESABILITADA (`enabled: podeConsultar`) e a API responderia 403 —
 * ou seja, a tela não tinha dado, não tinha erro e não estava carregando. Caía
 * então no estado vazio e imprimia `Nenhum aviso em aberto`: uma frase FALSA,
 * porque os avisos existem; o papel é que não os alcança.
 *
 * A segurança sempre esteve certa. O que enganava era o texto.
 *
 * ─── Por que este arquivo monta a árvore de verdade ─────────────────────────
 *
 * O alvo é a FRASE que chega ao olho, e quem decide qual delas sai é a permissão
 * real do hook (`usePermission("ai.inbox.view")`). Um duble do hook provaria só
 * que o componente obedece ao campo que o teste inventou. Aqui:
 *
 *   - o `AuthProvider` é o de verdade, com o PAPEL de verdade (`viewer` é um
 *     rank abaixo de `agent`, que é o mínimo da Central);
 *   - `useAgentInbox` e `AgentInboxList` são os de verdade;
 *   - o duble é o TRANSPORTE HTTP (`apiClient`) — entrada da tela, não o alvo —
 *     e é ele que prova o outro lado: com `viewer` a Central não é sondada.
 *
 * É o mesmo desenho de `tests/unit/voz-so-sonda-quem-pode-atender.test.tsx`,
 * que guarda a mesma família de defeito noutra tela.
 *
 * ─── O que a sabotagem prova ────────────────────────────────────────────────
 *
 * Tirada a condição de papel, o caso do `viewer` volta a imprimir a frase falsa
 * e fica VERMELHO — que é o defeito original, reprovando. O caso do `agent`
 * (estado vazio legítimo) segue verde, e é ele que impede o conserto de virar
 * "nunca mostre o estado vazio".
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const espiao = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn() }));

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: espiao.get, patch: espiao.patch, post: espiao.post },
}));
// O `AuthProvider` real renderiza `<Providers>` (react-query, tema…) e instancia
// o client do browser. Nada disso participa da decisão sob teste.
vi.mock("@/app/providers", () => ({
  Providers: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/supabase/browser", () => ({
  createClient: () => ({ auth: { refreshSession: vi.fn() } }),
  resetRealtimeAuthentication: vi.fn(),
}));

import { AgentInboxList } from "@/app/app/ai/inbox/_components/AgentInboxList";
import { AuthProvider } from "@/hooks/auth/AuthProvider";
import { ROLE_RANK, type ActiveOrg, type AuthUser, type Role } from "@/lib/auth/types";

const ORG = "11111111-1111-4111-8111-111111111111";
/** A frase que mente para quem não alcança a Central. */
const FRASE_FALSA = "Nenhum aviso em aberto";
/** A frase que diz o que é verdade. */
const FRASE_VERDADEIRA = "A Central de avisos é para quem atende";
/** A segunda linha do estado vazio legítimo, que só quem alcança deve ler. */
const EXPLICACAO_DO_ESTADO_VAZIO = "Quando o assistente precisar de você, o aviso aparece aqui.";

function usuario(): AuthUser {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    email: "quem@exemplo.com",
    full_name: "Quem Testa",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [],
  } as AuthUser;
}

function org(role: Role): ActiveOrg {
  return { orgId: ORG, name: "Org de teste", role };
}

function montar(role: Role) {
  const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider user={usuario()} activeOrg={org(role)}>
      <QueryClientProvider client={cliente}>
        <AgentInboxList canResolve={ROLE_RANK[role] >= ROLE_RANK.agent} />
      </QueryClientProvider>
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // A API responderia isto — "nenhum aviso" na organização: é justamente o dado
  // que NÃO pode virar frase de tela para quem o papel não deixa ver.
  espiao.get.mockResolvedValue({ data: { items: [], open_count: 0 } });
});

describe("a Central de avisos não mente para quem não a alcança", () => {
  it("atendente (agent) segue com o estado vazio LEGÍTIMO — e a Central é sondada", async () => {
    montar("agent");

    await waitFor(() => expect(espiao.get).toHaveBeenCalledTimes(1));
    expect(espiao.get.mock.calls[0]?.[0]).toContain("/api/v1/ai/inbox");

    expect(await screen.findByText(FRASE_FALSA)).toBeVisible();
    expect(screen.getByText(EXPLICACAO_DO_ESTADO_VAZIO)).toBeVisible();
    expect(
      screen.queryByText(FRASE_VERDADEIRA),
      "a frase feita para quem NÃO alcança apareceu para quem alcança",
    ).toBeNull();
  });

  it("viewer (rank abaixo do mínimo) NÃO lê 'Nenhum aviso em aberto'", async () => {
    montar("viewer");

    expect(await screen.findByText(FRASE_VERDADEIRA)).toBeVisible();
    expect(
      screen.queryByText(FRASE_FALSA),
      "a tela afirmou que não há aviso aberto para quem não pode ver aviso nenhum",
    ).toBeNull();
    expect(screen.queryByText("Nenhum aviso resolvido")).toBeNull();
    expect(screen.queryByText(EXPLICACAO_DO_ESTADO_VAZIO)).toBeNull();
    // Sem abas: as duas mostrariam a mesma frase, porque não há lista a alternar
    // (a leitura está desabilitada). Controle que não controla nada é a mesma
    // família do defeito — a tela oferecendo o que ela não faz.
    expect(screen.queryByRole("tab")).toBeNull();
    // E nem sonda a Central: a leitura é desabilitada e a API recusaria com 403.
    expect(espiao.get).not.toHaveBeenCalled();
  });
});
