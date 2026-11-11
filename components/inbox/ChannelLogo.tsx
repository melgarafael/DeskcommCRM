"use client";

import { channelBrand } from "@/lib/channels/presentation";
import { marcaDoCanal } from "@/lib/channels/marca-do-canal";
import { useT } from "@/hooks/i18n/useT";
import { ChatCircle } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import type { ChannelSummary } from "@/hooks/inbox/useConversationsRealtime";

/**
 * O logo da rede na lista de conversas e no cabeçalho.
 *
 * A tabela de cores e ícones NÃO mora mais aqui: ela é `marcaDoCanal`
 * (`lib/channels/marca-do-canal.ts`), a mesma que o aviso de mensagem nova usa —
 * uma rede, uma identidade (#4094). A cor vem de token do tema, então claro e
 * escuro continuam legíveis sem par de classes por canal.
 */
export function ChannelLogo({ channel, size = 18, className }: {
  channel?: ChannelSummary | null;
  size?: number;
  className?: string;
}) {
  const t = useT();
  const marca = marcaDoCanal(channelBrand(channel));
  const name = t(marca.rotulo);
  // Sem rede conhecida, o balão genérico: este logo fica sobre o avatar, e sem
  // ícone sobraria um disco vazio. Só o aviso sai sem logo.
  const Icon = marca.Icone ?? ChatCircle;
  return <span role="img" aria-label={name} title={name} style={{ color: marca.cor }} className={cn("inline-flex shrink-0 items-center justify-center", className)}>
    <Icon size={size} weight="fill" aria-hidden />
  </span>;
}
