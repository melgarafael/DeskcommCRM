"use client";

import { useQuery } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import Link from "next/link";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { rotuloDoProvedor } from "@/lib/ai/pontos/provedores";
import type { AvisoDeSaldoDaIa } from "@/lib/ai/saude-do-saldo";
import { apiClient } from "@/lib/api/client";
import { roleAtLeast } from "@/lib/auth/types";
import { cn } from "@/lib/utils";

export function SaldoDaIaBanner() {
  const t = useT();
  const { activeOrg } = useAuth();
  const podeVerAviso = Boolean(activeOrg && roleAtLeast(activeOrg.role, "agent"));
  const { data, isError, isPaused } = useQuery({
    queryKey: ["ai-credit-health", activeOrg?.orgId],
    enabled: podeVerAviso,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () =>
      (await apiClient.get<{ data: { orgId: string; avisos: AvisoDeSaldoDaIa[] } }>("/api/v1/ai/credit-health")).data,
  });

  if (!activeOrg || !podeVerAviso || isError || isPaused
      || data?.orgId !== activeOrg.orgId || !data.avisos.length) return null;

  const nomes = data.avisos.map(({ provider }) => rotuloDoProvedor(provider) ?? provider);
  const atendimento = data.avisos.some((aviso) => aviso.atendimento);
  const podeAbrirProvedores = roleAtLeast(activeOrg.role, "manager");

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-4 py-2 text-sm backdrop-blur",
        atendimento
          ? "border-red-300 bg-red-100/95 text-red-950 dark:border-red-800/60 dark:bg-red-950/80 dark:text-red-50"
          : "border-amber-300 bg-amber-100/95 text-amber-950 dark:border-amber-800/60 dark:bg-amber-950/80 dark:text-amber-50",
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span className="break-words">
          <strong>{atendimento
            ? t("Saldo insuficiente para o atendimento automático")
            : t("Saldo insuficiente em uma etapa da IA")}</strong>
          {" ("}{nomes.join(", ")}{"). "}
          {atendimento && t("Enquanto isso, responda pelo Inbox.")}
          {" "}{podeAbrirProvedores
            ? t("Recarregue o saldo na conta do provedor.")
            : t("Avise quem administra o CRM.")}
        </span>
      </div>
      {podeAbrirProvedores && (
        <Link
          href="/app/ai/providers"
          className="rounded-md border border-current px-3 py-1 font-medium hover:bg-black/5 dark:hover:bg-white/10"
        >
          {t("Ver provedores de IA")}
        </Link>
      )}
    </div>
  );
}
