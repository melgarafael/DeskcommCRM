"use client";
import Link from "next/link";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { destinosDaInterface } from "@/lib/navigation/interface";

import { useAgentInbox } from "@/hooks/ai/useAgentInbox";
import { usePrefetchPorIntencao } from "@/hooks/navigation/prefetchPorIntencao";
import { useSonsDaCentral } from "@/hooks/notifications/useSonsDaCentral";
import { useT } from "@/hooks/i18n/useT";
import { Bell } from "@/lib/ui/icons";

/**
 * Sino da central de avisos (Operação Visível F1): contador de avisos abertos
 * do runtime do agente no header; clique leva a /app/ai/inbox.
 */
export function AlertsBell() {
  const { user, activeOrg } = useAuth();
  if (
    !destinosDaInterface(
      activeOrg?.interface_settings,
      user.is_platform_admin && !user.support,
      activeOrg?.role ?? null,
    ).some((d) => d.href === "/app/ai/inbox")
  )
    return null;
  return <VisibleAlertsBell />;
}
function VisibleAlertsBell() {
  const t = useT();
  const { data } = useAgentInbox("open");
  // O som da organização para a etapa que avisa e o pedido de pessoa.
  useSonsDaCentral(data?.items);
  const count = data?.open_count ?? 0;
  /**
   * O sino aparece em TODA tela de `/app`, e o `<Link>` do App Router prefetcharia
   * `/app/ai/inbox` sozinho na montagem — um render RSC completo (`proxy.ts` +
   * `loadAuthUser` + as consultas do layout) por tela, para devolver a casca de
   * uma rota `force-dynamic`. O pedido passa a sair no ponteiro/foco, que chegam
   * dezenas de milissegundos antes do clique: quem só passa o olho pela tela não
   * paga nada (#3170, mesmo gancho do menu — `hooks/navigation/prefetchPorIntencao.ts`).
   *
   * O CONTADOR continua consultando na montagem de propósito: o número no sino é
   * o que a pessoa veio ver, e adiá-lo para o ponteiro trocaria um render do
   * servidor por um sino mudo.
   */
  const intencao = usePrefetchPorIntencao();

  return (
    <Link
      href="/app/ai/inbox"
      {...intencao("/app/ai/inbox")}
      aria-label={
        count > 0
          ? `${t("Central de avisos")} — ${count} ${t("em aberto")}`
          : t("Central de avisos")
      }
      data-testid="alerts-bell"
      className="relative inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:h-9 lg:w-9"
    >
      <Bell size={18} aria-hidden />
      {count > 0 ? (
        <span
          data-testid="alerts-bell-count"
          className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-none font-semibold text-destructive-foreground"
        >
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </Link>
  );
}
