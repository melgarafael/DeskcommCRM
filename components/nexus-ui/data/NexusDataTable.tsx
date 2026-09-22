import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { nexusTableContainerClass } from "@/lib/nexus/tokens";
import { NexusTableSkeleton } from "@/components/nexus-ui/feedback/NexusSkeleton";
import { NexusErrorState } from "@/components/nexus-ui/feedback/NexusErrorState";

/**
 * Contêiner canônico de tabela/lista: um só lugar para os estados
 * loading / empty / error + paginação + fallback mobile (cards).
 *
 * A tabela em si continua sendo `components/ui/table` (server ou client).
 * Este componente só resolve o entorno duplicado em ~10 páginas.
 */
export type NexusDataState = "idle" | "loading" | "error" | "empty" | "ready";

export function NexusDataTable<T>({
  state,
  table,
  empty,
  onRetry,
  errorTitle,
  errorDescription,
  pagination,
  renderCard,
  items,
  keyOf,
  className,
}: {
  state: NexusDataState;
  table: ReactNode;
  empty: ReactNode;
  onRetry?: () => void;
  errorTitle?: string;
  errorDescription?: string;
  pagination?: ReactNode;
  /** Render mobile: quando presente, `<md` mostra cards em vez da tabela. */
  renderCard?: (item: T) => ReactNode;
  items?: T[];
  keyOf?: (item: T, index: number) => string;
  className?: string;
}) {
  if (state === "loading") return <NexusTableSkeleton className={className} />;
  if (state === "error")
    return (
      <NexusErrorState
        title={errorTitle}
        description={errorDescription}
        onRetry={onRetry}
        className={className}
      />
    );
  if (state === "empty") return <>{empty}</>;

  // `ready` | `idle`: tabela no desktop, cards no mobile (quando fornecidos).
  if (renderCard && items) {
    return (
      <div className={className}>
        <div className={cn(nexusTableContainerClass, "hidden md:block")}>{table}</div>
        <ul className="space-y-3 md:hidden">
          {items.map((item, i) => (
            <li
              key={keyOf ? keyOf(item, i) : i}
              className="rounded-lg border border-border bg-surface p-4 shadow-xs"
            >
              {renderCard(item)}
            </li>
          ))}
        </ul>
        {pagination ? <div className="mt-4">{pagination}</div> : null}
      </div>
    );
  }

  return (
    <div className={className}>
      <div className={nexusTableContainerClass}>{table}</div>
      {pagination ? <div className="mt-4">{pagination}</div> : null}
    </div>
  );
}
