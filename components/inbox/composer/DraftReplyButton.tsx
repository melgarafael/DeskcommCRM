"use client";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Sparkle } from "@/lib/ui/icons";
import { useDraftReply } from "@/hooks/inbox/useDraftReply";

interface Props {
  conversationId: string;
  onDraft: (text: string) => void;
  disabled?: boolean;
}

/** Onda 5.1: botão "Sugerir resposta" — gera rascunho via agente publicado, sem enviar. */
export function DraftReplyButton({ conversationId, onDraft, disabled }: Props) {
  const t = useT();
  const mutation = useDraftReply();

  return (
    // #3268: a dica do TERCEIRO ícone da linha de ações — o "+" e o emoji já a
    // têm (AttachMenu/EmojiButton). Mesmo componente (`components/ui/tooltip`)
    // e mesmo Provider LOCAL, como em MessageBubble.tsx: o painel do inbox não
    // tem TooltipProvider ancestral e o Radix lança sem ele — o throw derruba a
    // árvore inteira, não só a dica. Provider/Tooltip/Trigger não criam nó
    // nenhum: quem entra na linha de ações continua sendo o mesmo botão
    // `size="icon"`, então a altura dela não muda. `aria-label` fica: o balão
    // é enfeite para quem usa ponteiro, o rótulo é a fonte para o leitor de
    // tela (e o Radix abre a dica no FOCO por teclado também).
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-9 w-9 shrink-0"
            aria-label={t("Sugerir resposta")}
            aria-busy={mutation.isPending}
            disabled={disabled || mutation.isPending}
            onClick={() => {
              mutation.mutate(conversationId, {
                onSuccess: (res) => onDraft(res.data.draft),
              });
            }}
          >
            <Sparkle size={18} weight={mutation.isPending ? "duotone" : "regular"} aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("Sugerir resposta")}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
