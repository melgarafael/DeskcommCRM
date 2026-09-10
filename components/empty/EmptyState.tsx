"use client";

import Link from "next/link";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";

export interface EmptyStateAction {
  label: string;
  onClick?: () => void;
  href?: string;
}

export interface EmptyStateProps {
  icon: PhosphorIcon;
  headline: string;
  subcopy?: string;
  primary?: EmptyStateAction;
  secondary?: EmptyStateAction;
}

function ActionButton({
  action,
  variant,
}: {
  action: EmptyStateAction;
  variant?: "default" | "outline";
}) {
  if (action.href) {
    return (
      <Button asChild variant={variant}>
        <Link href={action.href}>{action.label}</Link>
      </Button>
    );
  }
  return (
    <Button type="button" onClick={action.onClick} variant={variant}>
      {action.label}
    </Button>
  );
}

export function EmptyState({
  icon: Icon,
  headline,
  subcopy,
  primary,
  secondary,
}: EmptyStateProps) {
  // A tradução mora AQUI, no ponto de render, e não em `variants.tsx`: as
  // variantes são chamadas de função com texto literal, e envolvê-las uma a uma
  // deixaria a próxima variante nova sem tradução por esquecimento. Aqui todas
  // passam pelo mesmo lugar — e `t()` devolve a chave intacta para as que ainda
  // não têm entrada, então nenhuma variante piora.
  const t = useT();
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground dark:bg-[rgba(109,40,217,0.10)] dark:text-[#9061f9] dark:shadow-[0_0_14px_rgba(144,97,249,0.22)]">
        <Icon size={24} weight="duotone" />
      </div>
      <h3 className="text-base font-semibold">{t(headline)}</h3>
      {subcopy ? (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{t(subcopy)}</p>
      ) : null}
      {(primary || secondary) && (
        <div className="mt-4 flex gap-2">
          {secondary ? <ActionButton action={secondary} variant="outline" /> : null}
          {primary ? <ActionButton action={primary} variant="default" /> : null}
        </div>
      )}
    </div>
  );
}
