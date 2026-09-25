"use client";

import { ChatCircle, InstagramLogo, MessengerLogo, WhatsappLogo } from "@/lib/ui/icons";
import { channelBrand } from "@/lib/channels/presentation";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import type { ChannelSummary } from "@/hooks/inbox/useConversationsRealtime";

const brands = {
  whatsapp: { Icon: WhatsappLogo, label: "WhatsApp", color: "text-[#128c4a] dark:text-[#25d366]" },
  instagram: { Icon: InstagramLogo, label: "Instagram", color: "text-[#c13584] dark:text-[#f472b6]" },
  messenger: { Icon: MessengerLogo, label: "Messenger", color: "text-[#0866ff] dark:text-[#60a5fa]" },
  unknown: { Icon: ChatCircle, label: "Canal", color: "text-muted-foreground" },
};

export function ChannelLogo({ channel, size = 18, className }: {
  channel?: ChannelSummary | null;
  size?: number;
  className?: string;
}) {
  const t = useT();
  const { Icon, label, color } = brands[channelBrand(channel)];
  const name = label === "Canal" ? t("Canal") : label;
  return <span role="img" aria-label={name} title={name} className={cn("inline-flex shrink-0 items-center justify-center", color, className)}>
    <Icon size={size} weight="fill" aria-hidden />
  </span>;
}
