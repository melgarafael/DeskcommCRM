"use client";

import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { EmptyState, type EmptyStateAction } from "@/components/empty/EmptyState";

/**
 * Camada de identidade sobre o `EmptyState` canônico: mesma API, para que as
 * páginas migrem sem reaprender. Não duplicar layout de estado vazio.
 */
export function NexusEmptyState({
  icon,
  headline,
  subcopy,
  primary,
  secondary,
}: {
  icon: PhosphorIcon;
  headline: string;
  subcopy?: string;
  primary?: EmptyStateAction;
  secondary?: EmptyStateAction;
}) {
  return (
    <EmptyState
      icon={icon}
      headline={headline}
      subcopy={subcopy}
      primary={primary}
      secondary={secondary}
    />
  );
}
