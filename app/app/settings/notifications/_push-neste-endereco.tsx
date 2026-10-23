"use client";

import { useSyncExternalStore } from "react";

import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";

const nadaMuda = () => () => {};
/** Só https (ou localhost) tem `PushManager`: em http://IP nenhum navegador entrega push. */
const pushNesteEndereco = () => window.isSecureContext && "PushManager" in window;
// O servidor não vê o endereço pelo qual o navegador chegou: na hidratação vale
// o que ele sabe (o par existe) e, logo depois, o que o navegador diz.
const peloServidor = () => true;

/**
 * O cartão de quando o par VAPID existe. O par é condição do servidor; a outra
 * metade é do navegador, e numa instalação em http://IP a tela não pode
 * prometer aviso com a aba fechada (ADR-0006, decisão c).
 */
export function PushProntoNesteEndereco() {
  const t = useT();
  const funciona = useSyncExternalStore(nadaMuda, pushNesteEndereco, peloServidor);
  if (!funciona) {
    return (
      <Card
        data-testid="push-status-sem-https"
        className="border-amber-500/40 bg-amber-50/40 p-4 text-sm dark:bg-amber-900/10"
      >
        <p className="font-medium">{t("Nesta instalação, os avisos só aparecem com o site aberto.")}</p>
        <p className="mt-2 text-muted-foreground">
          {t(
            "Este endereço não usa conexão segura (https), e sem ela nenhum navegador entrega aviso com o site fechado. Quem administra o servidor pode ligar um domínio com https.",
          )}
        </p>
      </Card>
    );
  }
  return (
    <Card
      data-testid="push-status-pronto"
      className="border-amber-500/40 bg-amber-50/40 p-4 text-sm dark:bg-amber-900/10"
    >
      {t(
        "Email ainda não está disponível. In-app (toast) e Push (Chrome) já funcionam para as cinco categorias, inclusive com a aba fechada.",
      )}
    </Card>
  );
}
