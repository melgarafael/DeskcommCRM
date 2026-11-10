"use client";

/**
 * O número está de pé, mas não inteiro — dito no cartão da conexão.
 *
 * O cartão mostrava "Conectado" para um número que a plataforma diz que não
 * recebe mensagens, ou que está com o envio restrito (pagamento, conta
 * bloqueada, política). O status continua `WORKING` de propósito — barrar o
 * envio seria pior (`lib/channels/health.ts`) —, então o defeito chega aqui
 * pelo MOTIVO (`channel_sessions.status_reason`), que o vigia de saúde grava e
 * limpa. O aviso da Central diz o mesmo, com o que fazer.
 */
import { defeitoDoNumero } from "@/lib/channels/defeito-do-numero";
import { useT } from "@/hooks/i18n/useT";

/** O selo do cartão: "Atenção" no lugar de "Conectado" quando o número de pé tem defeito. */
export function numeroComDefeito(status: string | null | undefined, motivo: string | null | undefined): boolean {
  return status === "WORKING" && defeitoDoNumero(motivo) !== null;
}

export function DefeitoDoNumero({
  status,
  motivo,
}: {
  status: string | null | undefined;
  motivo: string | null | undefined;
}) {
  const t = useT();
  if (status !== "WORKING") return null;
  const defeito = defeitoDoNumero(motivo);
  if (!defeito) return null;
  return (
    <p
      role="alert"
      data-testid="defeito-do-numero"
      className="rounded-md border border-warning bg-warning-bg p-2 text-xs text-warning-fg"
    >
      {defeito.tipo === "nao_recebe"
        ? t("A Meta informa que este número não recebe mensagens. Reconecte o número.")
        : t("A Meta restringiu o envio deste número (código {codigo}).").replace("{codigo}", defeito.codigo)}
    </p>
  );
}
