"use client";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Phone } from "@/lib/ui/icons";
import { useVoiceCall } from "@/components/voice/VoiceCallContext";
import { useVoiceSessionStatus } from "@/hooks/voice/useVoiceSessionStatus";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  contactId: string;
  /** Contato sem telefone não tem pra onde ligar — o chamador já sabe disso. */
  hasPhone: boolean;
  /**
   * Renderiza como ITEM DE MENU (#3003) em vez de botão de barra. A decisão de
   * EXISTIR continua aqui dentro: `configured && paired && hasPhone`, os mesmos
   * três fatos de sempre. Se o `ConversationHeader` recalculasse isso para
   * desenhar o item, a regra passaria a viver em dois lugares — e o primeiro a
   * mudar deixaria o outro mentindo, oferecendo uma ligação que a org não
   * pareou.
   */
  comoItemDeMenu?: boolean;
}

/**
 * Botão "Ligar" do Customer 360 (spec §5.1). Só aparece quando a org pareou
 * chamada de voz — feature opt-in (§1.2), nunca ligada por padrão.
 */
export function DialButton({ contactId, hasPhone, comoItemDeMenu = false }: Props) {
  const { data: sessionStatus } = useVoiceSessionStatus();
  const { call, startCall } = useVoiceCall();
  const t = useT();

  if (!sessionStatus?.configured || !sessionStatus.paired || !hasPhone) return null;

  const jaEmLigacao = !!call && call.status !== "ended";
  const rotulo = jaEmLigacao ? t("Em ligação") : t("Chamar");
  /**
   * A guia diz o EFEITO (#3003), não o gesto repetido: "Chamar" sozinho não
   * conta que a chamada sai pelo navegador de quem atende, nem que ela toca o
   * telefone da FICHA — que pode não ser o número por onde a conversa chegou.
   */
  const guia = t("Liga para o telefone deste contato pelo navegador.");

  if (comoItemDeMenu) {
    return (
      <DropdownMenuItem
        data-testid="acao-chamar"
        disabled={jaEmLigacao}
        title={guia}
        onSelect={() => void startCall(contactId)}
      >
        <Phone size={16} weight="bold" aria-hidden className="mr-2" />
        {rotulo}
      </DropdownMenuItem>
    );
  }

  return (
    <Button
      variant="outline"
      className="shrink-0"
      disabled={jaEmLigacao}
      title={guia}
      data-testid="acao-chamar"
      onClick={() => void startCall(contactId)}
    >
      <Phone size={16} weight="bold" aria-hidden />
      <span>{rotulo}</span>
    </Button>
  );
}
