import type { ReactNode } from "react";
import { PageHeader } from "@/components/layout/PageHeader";

/**
 * Cabeçalho de página Nexus: título + descrição + ações contextuais + slot
 * opcional de navegação (breadcrumb / tabs). Identidade única, sem reaprender.
 */
export function NexusPageHeader({
  title,
  subtitle,
  actions,
  navigation,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  navigation?: ReactNode;
}) {
  return (
    <div className="space-y-3">
      {navigation ? <div className="text-sm text-muted-foreground">{navigation}</div> : null}
      <PageHeader title={title} subtitle={subtitle} actions={actions} />
    </div>
  );
}
