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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useMarcarSemInteresse } from "@/hooks/contacts/useSemInteresse";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";

/**
 * "MARCAR SEM INTERESSE" (decisão D3) — o mesmo gesto na ficha do contato e no painel
 * da conversa, num componente só, para o texto da confirmação nunca divergir entre os
 * dois lugares.
 *
 * Quem chama decide SE o botão aparece (papel, suporte somente leitura, contato
 * anonimizado, recusa já registrada): este componente só desenha e confirma. A
 * confirmação existe porque só um administrador desfaz (aba LGPD).
 */
export function BotaoMarcarSemInteresse({
  contactId,
  compacto = false,
  className,
  onMarcado,
}: {
  contactId: string;
  /** O tamanho dos botões do painel da conversa. */
  compacto?: boolean;
  className?: string;
  /** Chamado depois de gravar: o painel da conversa relê os negócios. */
  onMarcado?: () => void;
}) {
  const t = useT();
  const marcar = useMarcarSemInteresse(contactId);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          size={compacto ? "sm" : "default"}
          disabled={marcar.isPending}
          className={cn("shrink-0", compacto && "h-11 px-2 text-xs lg:h-7", className)}
          data-testid="marcar-sem-interesse"
        >
          <span>{t("Marcar sem interesse")}</span>
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Marcar este contato como sem interesse?")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              "O contato sai da prospecção e das campanhas. Os negócios da prospecção que ainda estão abertos vão para Perdido, e o follow-up da prospecção é encerrado. A conversa não é bloqueada: a equipe continua respondendo normalmente. Só um administrador desfaz, na aba LGPD.",
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => marcar.mutate(undefined, { onSuccess: () => onMarcado?.() })}>
            {t("Marcar sem interesse")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
