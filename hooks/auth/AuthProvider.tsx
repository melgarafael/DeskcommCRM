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
