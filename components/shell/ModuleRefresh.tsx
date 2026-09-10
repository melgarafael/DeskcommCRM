"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
/** Outras abas convergem por foco/poll; a API sempre consulta a flag atual. */
export function ModuleRefresh({ orgId, enabled }: { orgId: string; enabled: boolean }) {
  const router = useRouter();
  useEffect(() => {
    let active = true;
    let pending = false;
    const check = async () => {
      if (document.visibilityState === "hidden" || pending) return;
      pending = true;
      try {
        const response = await fetch("/api/v1/modules", { cache: "no-store" });
        if (!response.ok) return;
        const result = await response.json();
        if (active && typeof result.data?.academia === "boolean" && result.data.academia !== enabled) router.refresh();
      } catch { /* Uma falha de rede não altera o estado; nova leitura no próximo foco/poll. */ }
      finally { pending = false; }
    };
    const refresh = () => { void check(); };
    const timer = setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [orgId, enabled, router]);
  return null;
}
