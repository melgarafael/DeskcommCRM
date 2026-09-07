"use client";
import { useCallback, useEffect, useRef } from "react";
import { useT } from "@/hooks/i18n/useT";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { lerInterface } from "@/lib/navigation/interface";
import type { ActiveOrg } from "@/lib/auth/types";
const isDocumentHidden = () => document.visibilityState === "hidden";
/** Invalidação apenas: refresh RSC preserva estado de formulários e URL aberta. */
export function InterfaceRefresh({
  userId,
  org,
  support,
}: {
  userId: string;
  org: ActiveOrg | null;
  support: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const expected = JSON.stringify(lerInterface(org?.interface_settings).settings);
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    const generation = ++epoch.current;
    inFlight.current = false;
    pending.current = false;
    return () => {
      epoch.current = generation + 1;
    };
  }, [userId, org?.orgId, support]);
  const check = useCallback(async () => {
    if (!org || support || isDocumentHidden()) return;
    if (inFlight.current) {
      pending.current = true;
      return;
    }
    const generation = epoch.current;
    inFlight.current = true;
    try {
      do {
        pending.current = false;
        try {
          const response = await fetch("/api/v1/auth/interface", { cache: "no-store" });
          if (response.ok) {
            const result = await response.json();
            if (generation !== epoch.current) return;
            if (result.data?.organization_id === org.orgId && result.data.signature !== expected) {
              router.refresh();
              toast.info(t("Sua navegação foi atualizada. Você pode continuar nesta tela."), {
                id: "interface-updated",
              });
            }
          }
        } catch {
          /* Poll/foco/reconexão repetem leitura, sem trocar contexto por falha. */
        }
        // Uma invalidação pode chegar depois do snapshot lido pela consulta em voo.
        // Consome-a em nova leitura, sem esperar o polling ou aceitar payload como estado.
      } while (generation === epoch.current && pending.current && !isDocumentHidden());
    } finally {
      if (generation === epoch.current) {
        inFlight.current = false;
        pending.current = false;
      }
    }
  }, [org, support, expected, router, t]);
  useRealtimeChannel({
    name: `interface:${userId}:${org?.orgId}`,
    enabled: !!org && !support,
    postgresChanges: {
      event: "UPDATE",
      table: "user_organizations",
      filter: `user_id=eq.${userId}`,
    },
    onChange: () => {
      void check();
    },
  });
  useEffect(() => {
    const refresh = () => {
      void check();
    };
    const timer = setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [check]);
  return null;
}
