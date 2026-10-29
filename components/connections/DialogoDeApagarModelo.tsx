"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useT } from "@/hooks/i18n/useT";

/**
 * APAGAR UM MODELO, em dois passos — confirmar, e — se ele está em uso num
 * follow-up ou no prompt do agente — ver ONDE antes de confirmar de novo.
 *
 * Mora num componente próprio porque as duas telas de modelos (parceiro e canal
 * oficial direto, #3635) apagam pelo mesmo caminho: `POST …/templates` com
 * `acao: "apagar"`, a mesma pergunta de usos, a mesma confirmação. A rota
 * responde `template_in_use` (409) com a lista; é ela que vira esta caixa.
 *
 * A tela NÃO fecha sozinha quando a resposta é "em uso": se fechasse, o operador
 * perderia justamente a informação que a rota devolveu.
 */
export interface AlvoDoApagamento {
  name: string;
  language: string;
  /**
   * `null` = primeira confirmação (ainda não perguntamos os usos).
   * `[]`  = a rota disse que não está em uso, e o operador confirmou assim mesmo.
   * `[…]` = onde está em uso, para ele decidir com a lista à vista.
   */
  usos: string[] | null;
}

export function DialogoDeApagarModelo({
  alvo,
  apagando = false,
  onCancelar,
  onConfirmar,
}: {
  alvo: AlvoDoApagamento | null;
  apagando?: boolean;
  onCancelar: () => void;
  onConfirmar: (confirmado: boolean) => void;
}) {
  const t = useT();
  const emUso = (alvo?.usos?.length ?? 0) > 0;

  return (
    <AlertDialog open={alvo !== null} onOpenChange={(v) => !v && !apagando && onCancelar()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("Apagar o modelo")} <span className="font-mono">{alvo?.name}</span>?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              "Ele é apagado também na plataforma do WhatsApp, e não dá para desfazer. A Meta não deixa usar o mesmo nome de novo por 30 dias.",
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {emUso && (
          <div className="rounded-md border border-amber-300 bg-amber-50/50 p-2 text-sm dark:border-amber-800/60 dark:bg-amber-950/20">
            <p className="font-medium">{t("Este modelo está em uso:")}</p>
            <ul className="mt-1 list-disc pl-5">
              {(alvo?.usos ?? []).map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(
                "Sem ele, esse passo do follow-up é pulado e o agente não consegue mandá-lo. Troque antes, ou apague assim mesmo.",
              )}
            </p>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={apagando}>{t("Cancelar")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={apagando}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(e) => {
              // Não fecha sozinho: se a rota responder "em uso", o diálogo
              // continua aberto mostrando onde.
              e.preventDefault();
              onConfirmar(alvo?.usos !== null && alvo?.usos !== undefined);
            }}
          >
            {apagando
              ? t("Apagando…")
              : emUso
                ? t("Apagar assim mesmo")
                : t("Apagar")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
