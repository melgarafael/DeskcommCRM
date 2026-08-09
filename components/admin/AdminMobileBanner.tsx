import { Warning } from "@/lib/ui/icons";

/**
 * Doc de responsividade: super-admin (cross-tenant) degrada intencionalmente
 * em mobile — a operação de triagem séria assume desktop. Este banner é o
 * "read-only" comunicado; PLATFORM_ADMIN continua podendo navegar e ler tudo
 * (inbox cross-tenant inclusive), só não é o lugar pra mutações destrutivas
 * (criar tenant, impersonate, reassign batch) num celular.
 */
export function AdminMobileBanner() {
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-warning/30 bg-warning-bg px-4 py-2 text-xs text-warning-fg md:hidden"
    >
      <Warning size={16} weight="fill" aria-hidden className="shrink-0" />
      <span>
        Plataforma otimizada pra desktop. Algumas ações estão desabilitadas.
      </span>
    </div>
  );
}
