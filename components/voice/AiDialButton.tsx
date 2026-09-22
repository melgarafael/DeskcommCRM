"use client";

import { Button } from "@/components/ui/button";
import { useVoiceCall } from "@/components/voice/VoiceCallContext";
import { useVoiceSessionStatus } from "@/hooks/voice/useVoiceSessionStatus";
import { useT } from "@/hooks/i18n/useT";
import { Robot } from "@/lib/ui/icons";

interface Props {
  conversationId: string;
  contactId: string;
  hasPhone: boolean;
}

/** Porta explícita da ligação conduzida pelo funcionário de IA via WaCalls. */
export function AiDialButton({ conversationId, contactId, hasPhone }: Props) {
  const t = useT();
  const { data: voice } = useVoiceSessionStatus();
  const { call, startAiCall } = useVoiceCall();

  if (!voice?.configured || !voice.paired || !hasPhone) return null;

  const busy = !!call && call.status !== "ended";
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      data-testid="ligar-com-ia"
      title={t("O funcionário de IA conversa por voz usando o número conectado ao WaCalls.")}
      onClick={() => void startAiCall(conversationId, contactId)}
    >
      <Robot size={15} weight="duotone" aria-hidden />
      {busy ? t("Em ligação") : t("Ligar com IA")}
    </Button>
  );
}
