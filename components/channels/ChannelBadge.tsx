import type { ComponentProps } from "react";

import { Badge } from "@/components/ui/badge";
import {
  InstagramLogo,
  MessengerLogo,
  Phone,
  WhatsappLogo,
} from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface Props extends Omit<ComponentProps<typeof Badge>, "children"> {
  channel: string | null | undefined;
  label: string;
}

const IDENTIDADE_DO_CANAL = {
  whatsapp: {
    data: "whatsapp",
    classe: "channel-whatsapp",
    Icone: WhatsappLogo,
  },
  instagram: {
    data: "instagram",
    classe: "channel-instagram",
    Icone: InstagramLogo,
  },
  messenger: {
    // O canal do banco se chama Messenger; visualmente ele pertence à família
    // azul do Facebook, mas leva o balão correto para não prometer que é feed.
    data: "facebook",
    classe: "channel-facebook",
    Icone: MessengerLogo,
  },
} as const;

/**
 * Identidade visual da origem da conversa.
 *
 * A palavra continua no selo: cor nunca é a única informação. Os ícones são
 * SVGs do barril canônico e as cores vivem no CSS para respeitar claro/escuro.
 */
export function ChannelBadge({ channel, label, className, ...props }: Props) {
  const identidade =
    IDENTIDADE_DO_CANAL[channel?.toLowerCase() as keyof typeof IDENTIDADE_DO_CANAL];
  const Icone = identidade?.Icone ?? Phone;

  return (
    <Badge
      variant="outline"
      data-channel={identidade?.data ?? "outro"}
      className={cn(
        "h-4 gap-1 px-1.5 text-[10px] font-medium",
        identidade?.classe,
        className,
      )}
      {...props}
    >
      <Icone size={10} weight="fill" aria-hidden />
      {label}
    </Badge>
  );
}
