"use client";
import { useEffect, useState } from "react";
import { useT } from "@/hooks/i18n/useT";

import { fonteDeTemplates } from "@/lib/channels/templates-fonte";
import { Badge } from "@/components/ui/badge";
import {
  estadoDaJanela,
  formatarDecorrido,
  formatarRestante,
  LIMIAR_URGENTE_MS,
} from "@/lib/channels/janela";
import { cn } from "@/lib/utils";

/**
 * Quanto tempo resta para escrever livremente nesta conversa.
 *
 * ─── O que faltava ─────────────────────────────────────────────────────────
 *
 * A regra da janela de 24h existe e é aplicada — mas só no guardrail do agente
 * de IA. Quem atende não via nada: abria a conversa, não tinha como saber que
 * restavam vinte minutos, escrevia depois e recebia um `failed` com o código
 * 131047 da plataforma. Um número de cinco dígitos no lugar de "a janela
 * fechou; mande um modelo".
 *
 * ─── Por que o relógio conta minutos e não segundos ────────────────────────
 *
 * Um número que muda sozinho puxa o olho para o relógio em vez da conversa. E a
 * decisão que ele apoia — "escrevo agora ou mando modelo?" — não muda por causa
 * de trinta segundos. Recalcula a cada 30s para não travar num valor velho
 * enquanto a aba fica aberta a tarde inteira, que é o normal aqui.
 *
 * ─── Por que não aparece em todo canal ─────────────────────────────────────
 *
 * Número por QR não tem essa restrição. Mostrar um relógio nele inventaria uma
 * urgência que não existe — e a primeira vez que alguém percebesse que o
 * relógio não muda nada, pararia de olhar para ele em TODOS os canais.
 */
export function JanelaSelo({
  provider,
  lastInboundAt,
}: {
  provider: string | null | undefined;
  lastInboundAt: string | null;
}) {
  const t = useT();
  // O relógio do servidor não serve: o que importa é quanto falta AGORA, na
  // máquina de quem lê. `useState` com função para não recalcular a cada render.
  const [agora, setAgora] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setAgora(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const usaModelos = fonteDeTemplates(provider) !== null;
  const estado = estadoDaJanela(provider, lastInboundAt, agora);
  if (estado.tipo === "sem_restricao") return null;

  if (estado.tipo === "fechada") {
    // "Fechada há 3d" responde o que o operador realmente pergunta — "passei
    // muito?" —, e essa distância é o que decide se ainda vale insistir ou se a
    // conversa esfriou. "Fechada" sozinho não distingue vinte minutos de um mês.
    const quanto =
      estado.fechadaHaMs === null
        ? t("O cliente nunca escreveu")
        : `${t("Janela fechada há")} ${formatarDecorrido(estado.fechadaHaMs)}`;
    return (
      <Badge
        variant="outline"
        className="h-4 border-amber-400 px-1.5 text-[10px] text-amber-700 dark:border-amber-700 dark:text-amber-300"
        title={usaModelos ? t(
          "Passaram 24h desde a última mensagem do cliente. Só um modelo aprovado sai daqui — texto livre é recusado pela plataforma.",
        ) : t("Aguarde uma nova mensagem do cliente para reabrir o atendimento nesta rede.")}
      >
        {quanto} · {usaModelos ? t("só modelo") : t("aguardando o cliente")}
      </Badge>
    );
  }

  const urgente = estado.restanteMs <= LIMIAR_URGENTE_MS;
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-4 px-1.5 text-[10px]",
        urgente && "border-amber-400 text-amber-700 dark:border-amber-700 dark:text-amber-300",
      )}
      title={usaModelos ? t("Tempo restante para escrever texto livre. Depois disso, só modelo aprovado.") : t("Tempo restante para responder. Uma nova mensagem do cliente reabre a janela.")}
    >
      {t("Janela")} {formatarRestante(estado.restanteMs)}
    </Badge>
  );
}
