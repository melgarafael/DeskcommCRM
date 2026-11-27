"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { CalendarBlank, Warning } from "@/lib/ui/icons";

/** O que a volta da Microsoft (`?outlook=`) quer dizer, na língua de quem usa. */
function desfechosDoOutlook(t: (texto: string) => string): Record<string, string> {
  return {
    conectada: t("Agenda do Outlook conectada."),
    conexao_cancelada: t("Você cancelou a conexão. Nada mudou."),
    precisa_do_administrador: t("A sua empresa exige que o administrador de TI aprove o aplicativo antes de conectar."),
    recusada: t("A Microsoft recusou a conexão. Tente de novo."),
    nao_configurado: t("Esta instalação ainda não tem a conexão com a Microsoft configurada."),
    credencial_recusada: t("A Microsoft recusou o aplicativo desta instalação. Quem instalou o sistema precisa conferir o segredo."),
    cifra_indisponivel: t("Falta uma chave de segurança nesta instalação. Quem instalou o sistema precisa resolver."),
    segredo_indisponivel: t("Falta uma chave de segurança nesta instalação. Quem instalou o sistema precisa resolver."),
    retorno_nao_verificavel: t("A conexão demorou demais e expirou. Conecte de novo."),
    troca_de_codigo_falhou: t("A Microsoft não confirmou a conexão. Tente de novo."),
    conta_indisponivel: t("Não consegui ler os dados da conta Microsoft. Tente de novo."),
    permissao_incompleta: t("Faltou a permissão de leitura da agenda. Conecte de novo e aceite o pedido."),
    nao_consegui_guardar: t("A conexão funcionou, mas não consegui salvar. Tente de novo."),
  };
}

/**
 * Cada pessoa conecta a PRÓPRIA conta. Sem aplicativo cadastrado e sem conta
 * conectada, nada aparece — a não ser o aviso de uma volta com erro.
 */
export function CartaoDaConexaoOutlook({
  configurado,
  conta,
  precisaReconectar,
}: {
  configurado: boolean;
  conta?: string | null;
  precisaReconectar?: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const codigo = useSearchParams()?.get("outlook");
  const [desconectando, setDesconectando] = useState(false);
  const [falhou, setFalhou] = useState(false);
  const desfecho = codigo
    ? (desfechosDoOutlook(t)[codigo] ?? t("Não consegui conectar sua agenda do Outlook."))
    : null;

  if (!configurado && !conta && !desfecho) return null;

  return (
    <div data-testid="cartao-outlook" className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
      {desfecho && (
        <p role="status" data-testid="aviso-conexao-outlook" className="text-sm font-medium text-text">
          {desfecho}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {precisaReconectar ? (
          <Warning size={16} weight="fill" className="shrink-0 text-warning" aria-hidden />
        ) : (
          <CalendarBlank size={16} weight="bold" className="shrink-0 text-text-muted" aria-hidden />
        )}
        <p className="min-w-0 flex-1 text-sm">
          {conta ? (
            <>
              <span className="text-text-muted">
                {precisaReconectar ? t("A agenda do Outlook precisa ser reconectada:") : t("Agenda do Outlook conectada:")}{" "}
              </span>
              <span className="font-medium">{conta}</span>
            </>
          ) : (
            <span className="text-text-muted">
              {t("Conecte sua agenda do Outlook para o horário ocupado lá não ser oferecido aqui.")}
            </span>
          )}
        </p>
        {conta && (
          <a href="/app/settings/tenant/agenda" className="text-xs underline">
            {t("Configurar suas agendas")}
          </a>
        )}
        {configurado && (!conta || precisaReconectar) && (
          <Button variant="outline" size="sm" data-testid="conectar-outlook" asChild>
            <a href="/api/v1/agenda/microsoft/connect">
              {conta ? t("Reconectar Outlook") : t("Conectar Outlook")}
            </a>
          </Button>
        )}
        {conta && (
          <Button
            variant="outline"
            size="sm"
            data-testid="desconectar-outlook"
            disabled={desconectando}
            onClick={() => {
              setDesconectando(true);
              setFalhou(false);
              void fetch("/api/v1/agenda/microsoft/desconectar", { method: "DELETE" })
                .then((r) => {
                  if (!r.ok) throw new Error(String(r.status));
                  router.replace("/app/agenda");
                  router.refresh();
                })
                .catch(() => setFalhou(true))
                .finally(() => setDesconectando(false));
            }}
          >
            {desconectando ? t("Desconectando…") : t("Desconectar")}
          </Button>
        )}
      </div>
      {falhou && (
        <p role="alert" className="text-xs text-warning">
          {t("Não foi possível desconectar.")}
        </p>
      )}
    </div>
  );
}
