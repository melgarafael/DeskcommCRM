import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Peça fina e compartilhada pro padrão "tabela em desktop, cards em mobile".
 * Não é uma tabela genérica dirigida por config de colunas — cada tela
 * continua decidindo o que mostrar; isto só dá o invólucro visual comum.
 * Uso: `<Table className="hidden md:table">…` ao lado de
 * `<MobileCardList className="md:hidden">…<MobileCardRow .../>…</MobileCardList>`.
 */
export function MobileCardList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("flex flex-col gap-2", className)}>{children}</div>;
}

export function MobileCardRow({
  children,
  onClick,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <Card
      className={cn("p-3", onClick && "cursor-pointer active:bg-accent/10", className)}
      onClick={onClick}
    >
      <dl className="flex flex-col gap-1.5">{children}</dl>
    </Card>
  );
}

/** Uma linha label→valor dentro de `MobileCardRow`. */
export function MobileCardField({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3", className)}>
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right text-sm">{children}</dd>
    </div>
  );
}
