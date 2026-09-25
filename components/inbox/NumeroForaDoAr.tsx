"use client";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ReassignDialog } from "@/components/inbox/ReassignDialog";
import { useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useT } from "@/hooks/i18n/useT";
import { numeroForaDoArComSaida } from "@/lib/inbox/outros-numeros";

interface Props {
  conversationId: string;
  channelSessionId: string;
  contactId: string;
  contactPhone: string | null;
  onAbrirConversa: (id: string) => void;
}

/**
 * O telefone desta conversa caiu — e aqui está a saída.
 *
 * Sem esta faixa o atendente escrevia, a mensagem não saía, e nada na tela
 * dizia que havia outro número da empresa conectado. Ela só aparece quando há
 * para onde ir (`numeroForaDoArComSaida`); avisar a queda sem oferecer saída é
 * trabalho da Central de Conexões, não do Inbox.
 */
export function NumeroForaDoAr({
  conversationId,
  channelSessionId,
  contactId,
  contactPhone,
  onAbrirConversa,
}: Props) {
  const t = useT();
  const { data: sessoes } = useChannelSessions({ refetchInterval: 30_000 });
  const [aberto, setAberto] = useState(false);

  if (!numeroForaDoArComSaida(sessoes, channelSessionId)) return null;

  return (
    <div
      role="status"
      data-testid="numero-fora-do-ar"
      className="flex flex-wrap items-center justify-between gap-2 border-t bg-destructive/5 px-4 py-2 text-sm"
    >
      <span className="text-destructive">{t("O número desta conversa não está conectado.")}</span>
      <Button size="sm" variant="outline" onClick={() => setAberto(true)}>
        {t("Responder por outro número")}
      </Button>
      <ReassignDialog
        conversationId={conversationId}
        open={aberto}
        onOpenChange={setAberto}
        abaInicial="numero"
        numero={{ contactId, contactPhone, channelSessionId, onAbrirConversa }}
      />
    </div>
  );
}
