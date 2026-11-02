"use client";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Providers } from "@/app/providers";
import { definirOrgDaAba } from "@/lib/auth/org-da-aba";
import { encerrarPushDesteAparelho } from "@/lib/notifications/push_client";
import { createClient, resetRealtimeAuthentication } from "@/lib/supabase/browser";
import type { AuthUser, ActiveOrg, Role } from "@/lib/auth/types";
import { ROLE_RANK } from "@/lib/auth/types";

interface AuthCtx {
  user: AuthUser;
  activeOrg: ActiveOrg | null;
  isAuthenticated: true;
  refreshing: boolean;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({
  user,
  activeOrg,
  children,
}: {
  user: AuthUser;
  activeOrg: ActiveOrg | null;
  children: ReactNode;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const supabaseRef = useRef(createClient());

  useEffect(() => {
    resetRealtimeAuthentication();
    return resetRealtimeAuthentication;
  }, [user.id, activeOrg?.orgId, user.support?.id, user.support?.access_mode]);

  // A organização que ESTA aba acha que é — a mesma das props, fixas durante a
  // vida do documento. Registrada para o `apiClient` carimbá-la em toda
  // mutação (#2335, metade 2): o servidor compara com o cookie e recusa a
  // divergência. É estado POR DOCUMENTO, e por isso não pode morar no cookie —
  // duas abas do mesmo navegador discordam justamente nele.
  useEffect(() => {
    definirOrgDaAba(
      activeOrg ? { orgId: activeOrg.orgId, nome: activeOrg.name, idioma: user.idioma } : null,
    );
    return () => definirOrgDaAba(null);
  }, [activeOrg, user.idioma]);

  // Revogação/scope no banco também derrubam o snapshot aberto de UI/realtime.
  useEffect(() => {
    if (!user.support) return;
    const expected = `${user.support.id}:${user.support.access_mode}:${user.support.status}`;
    const check = async () => {
      const response = await fetch("/api/v1/auth/support", { cache: "no-store" }).catch(() => null);
      if (!response?.ok) return;
      const result = await response.json();
      if (result.data.signature !== expected) window.location.reload();
    };
    const timer = setInterval(() => { void check(); }, 15000);
    return () => clearInterval(timer);
  }, [user.support]);

  // Refresh session every 40 minutes (JWT default 1h, with margin).
  useEffect(() => {
    const interval = setInterval(
      async () => {
        setRefreshing(true);
        try {
          await supabaseRef.current.auth.refreshSession();
        } finally {
          setRefreshing(false);
        }
      },
      40 * 60 * 1000,
    );
    return () => clearInterval(interval);
  }, []);

  const value = useMemo<AuthCtx>(
    () => ({
      user,
      activeOrg,
      isAuthenticated: true,
      refreshing,
      signOut: async () => {
        resetRealtimeAuthentication();
        // Antes da action: o DELETE da inscrição precisa do cookie que ela
        // apaga. `encerrarPushDesteAparelho` nunca lança, então não segura a saída.
        await encerrarPushDesteAparelho();
        const { signOut } = await import("@/app/actions/auth/signOut");
        await signOut();
      },
    }),
    [user, activeOrg, refreshing],
  );

  return <Ctx.Provider value={value}>
    <Providers key={`${user.id}:${activeOrg?.orgId ?? "none"}:${user.support?.id ?? "normal"}:${user.support?.access_mode ?? ""}`}>{children}</Providers>
  </Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

export function useUser(): AuthUser {
  return useAuth().user;
}

export function useActiveOrg(): ActiveOrg | null {
  return useAuth().activeOrg;
}

/**
 * Permission gate based on role rank. Action mapping is intentionally
 * minimal here — feature-specific gates can extend with custom logic.
 */
const ACTION_MIN_ROLE: Record<string, Role> = {
  "inbox.view": "viewer",
  "inbox.reply": "agent",
  "inbox.claim": "agent",
  "contact.view": "viewer",
  "contact.create": "agent",
  "contact.update": "agent",
  "contact.delete": "manager",
  // Pôr o contato na carteira de alguém: o piso da rota `[id]/carteira`.
  "contact.carteira": "manager",
  "pipeline.view": "viewer",
  "pipeline.create": "manager",
  "pipeline.move_card": "agent",
  "team.invite": "admin",
  "team.change_role": "admin",
  "settings.write": "admin",
  "lgpd.execute_redact": "admin",
  "audit.view": "manager",
  "ai.automatico.view": "agent",
  "ai.inbox.view": "agent",
  "inbox.notes.view": "agent",
  // O cartão da passagem, dentro da conversa. `agent` e não `viewer` porque é o
  // piso que a policy de `passagens_de_atendimento` exige (migration 0291): o
  // briefing diz MAIS que a conversa — diz o que a IA concluiu sobre a pessoa.
  // Um `viewer` que sondasse esta rota levaria 403 em toda abertura de conversa.
  "inbox.passagens.view": "agent",
  // Quem participa da conversa (o cabeçalho do atendimento conjunto). `agent` e
  // não `viewer` pelo mesmo motivo das notas e das passagens: é o piso de quem
  // ATENDE. Reusar uma das duas permissões irmãs amarraria a lista a um recurso
  // que não é dela; uma permissão própria deixa o gate correto no dia em que a
  // lista mudar de piso. Sem ele, um `viewer` que abre QUALQUER conversa pede a
  // lista e a rota respondia com `authz.denied` a cada abertura.
  "inbox.participantes.view": "agent",
  "message-templates.view": "agent",
  "ai.agents.view": "manager",
  "ai.agents.write": "admin",
  "ai.memory.view": "manager",
  "ai.memory.publish": "admin",
  "ai.skills.view": "manager",
  "ai.skills.manage": "manager",
  "ai.routers.view": "manager",
  "ai.evolution.view": "manager",
  "ai.routers.manage": "admin",
  "ai.credentials.view": "manager",
  "ai.credentials.write": "admin",
  "webhooks.manage": "manager",
  // Mesmo mínimo de lib/navigation/catalogo.ts (destino /app/calls) e de
  // requireRole("manager") em app/api/v1/calls/route.ts — a RLS de crm_calls
  // é só por organização, então sem este gate o aviso ao vivo de ligação
  // chegaria pra viewer/agent, papéis que a tela nunca mostra pra eles.
  "calls.view": "manager",
  // Chamada de voz (spec 18). `agent` porque ligar e atender é ato de
  // atendimento, não de configuração — e porque é o piso que as rotas de
  // `app/api/v1/voice/calls/*` exigem. Quem não alcança este piso (viewer, e
  // acompanhamento administrativo somente-leitura, que é rebaixado a viewer em
  // `resolveActiveOrg`) não sonda, não assina e não vê telefone tocar: um
  // banner de chamada para quem não pode atendê-la é uma promessa falsa, e a
  // sondagem por trás dele levava 403 em toda navegação.
  "voice.call": "agent",
};

export function usePermission(action: string): boolean {
  const { user, activeOrg } = useAuth();
  if (user.is_platform_admin && !user.support) return true;
  if (!activeOrg) return false;
  const required = ACTION_MIN_ROLE[action];
  if (!required) return false;
  return ROLE_RANK[activeOrg.role] >= ROLE_RANK[required];
}

/**
 * O país da organização ativa, SEM exigir o provider: telas que também
 * renderizam isoladas (testes, prévias) leem `null` — o Brasil, o padrão de
 * todo leitor de país (`perfilDoPais(null)`) — em vez de lançar como
 * `useActiveOrg`.
 */
export function usePaisDaOrgAtiva(): string | null {
  return useContext(Ctx)?.activeOrg?.country ?? null;
}

/**
 * O idioma padrão da organização ativa (`organizations.locale`, o que o
 * instalador grava), tolerante como o leitor de país: fora do provider, `null`.
 * NÃO é o idioma da interface (`useIdioma`), que segue a preferência de quem opera.
 */
export function useLocaleDaOrgAtiva(): string | null {
  const ctx = useContext(Ctx);
  const orgId = ctx?.activeOrg?.orgId;
  return ctx?.user.organizations?.find((m) => m.organization_id === orgId)?.locale ?? null;
}

/**
 * A moeda da organização ativa (`organizations.currency`) — a do campo
 * personalizado de moeda. Tolerante como o leitor de país: fora do provider,
 * `null`, e quem lê cai no `MOEDA_PADRAO`.
 */
export function useMoedaDaOrgAtiva(): string | null {
  return useContext(Ctx)?.activeOrg?.currency ?? null;
}
