"use client";
import Link from "next/link";

import { ArrowCircleUp } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { useSystemVersion } from "@/hooks/system/useSystemVersion";
import { cn } from "@/lib/utils";

/**
 * Versão instalada no rodapé da sidebar. Vira um aviso clicável só para quem
 * é dono do servidor E tem versão nova — quem não pode atualizar não é
 * alertado sobre algo que não pode resolver.
 */
export function VersionFooter({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  /** Fecha a gaveta do mobile — é o único Link do drawer que não a recebia. */
  onNavigate?: () => void;
}) {
  const t = useT();
  const { data } = useSystemVersion();
  if (!data?.current_version) return null;

  const label = data.current_version.replace(/^v/i, "");
  // Só acende quando existe versão nova de verdade. `off_release` sozinho não
  // conta: uma instalação de desenvolvimento sem versão publicada mais nova
  // ficava com o ponto pulsando pra sempre, e o texto "Nova versão · " com o
  // número vazio, apontando para uma tela que não tem o que oferecer.
  const alerta = data.is_owner && data.update_available;

  if (!alerta) {
    return (
      <p
        className={cn("px-3 py-1 text-[11px] text-muted-foreground", collapsed && "px-0 text-center")}
        title={`${t("Versão")} ${label}`}
      >
        {collapsed ? label.split(".").slice(0, 2).join(".") : `${t("versão")} ${label}`}
      </p>
    );
  }

  const novo = data.latest_version?.replace(/^v/i, "") ?? "";
  return (
    <Link
      href="/app/settings/atualizacao"
      onClick={onNavigate}
      title={`${t("Nova versão")} ${novo} ${t("disponível")}`}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-2 text-xs text-foreground hover:bg-accent/50",
        collapsed && "justify-center px-2",
      )}
    >
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
      </span>
      {!collapsed && (
        <span className="truncate">
          {t("Nova versão")}{novo ? ` · ${novo}` : ""}
        </span>
      )}
      {collapsed && <ArrowCircleUp size={16} aria-hidden />}
    </Link>
  );
}
