"use client";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Clock } from "@/lib/ui/icons";
import { useSnoozeConversation } from "@/hooks/inbox/useSnoozeConversation";

interface Props {
  conversationId: string;
  snoozeUntil: string | null;
  disabled?: boolean;
  /**
   * `"barra"` (padrão): botão próprio com o menu de durações, como sempre foi.
   * `"submenu"` (#3003): a MESMA lista vira submenu dentro do ⋯ do cabeçalho.
   *
   * A duração e a escolha entre "adiar" e "cancelar o lembrete" continuam
   * decididas aqui — o cabeçalho não sabe que existem três durações, só monta a
   * ação. Duplicar a lista lá seria a segunda régua que o primeiro ajuste
   * deixaria divergente.
   */
  modo?: "barra" | "submenu";
}

const DURATIONS: Array<{ hours: 1 | 3 | 24; label: string }> = [
  { hours: 1, label: "Em 1 hora" },
  { hours: 3, label: "Em 3 horas" },
  { hours: 24, label: "Em 24 horas" },
];

function isSnoozeActive(snoozeUntil: string | null): boolean {
  return snoozeUntil != null && new Date(snoozeUntil).getTime() > Date.now();
}

export function SnoozeButton({ conversationId, snoozeUntil, disabled, modo = "barra" }: Props) {
  const t = useT();
  const { snooze, cancel } = useSnoozeConversation();
  const isActive = isSnoozeActive(snoozeUntil);
  const isPending = snooze.isPending || cancel.isPending;
  const rotulo = isActive ? t("Lembrete ativo") : t("Lembrar");
  /**
   * GUIA CURTA (#3003): "Lembrar" descreve o gesto e esconde o que a conversa
   * faz enquanto isso — ela sai da frente e VOLTA sozinha no horário. Quem não
   * sabe disso adia achando que está arquivando.
   */
  const guia = t("Tira a conversa da fila até o horário escolhido; depois ela volta sozinha.");

  const opcoes = isActive ? (
    <DropdownMenuItem onClick={() => cancel.mutate({ conversation_id: conversationId })}>
      {t("Cancelar lembrete")}
    </DropdownMenuItem>
  ) : (
    DURATIONS.map((d) => (
      <DropdownMenuItem
        key={d.hours}
        onClick={() => snooze.mutate({ conversation_id: conversationId, duration_hours: d.hours })}
      >
        {t(d.label)}
      </DropdownMenuItem>
    ))
  );

  if (modo === "submenu") {
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger
          data-testid="acao-lembrar"
          title={guia}
          disabled={disabled || isPending}
          className="gap-2"
        >
          <Clock size={16} weight="regular" aria-hidden />
          {rotulo}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>{opcoes}</DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || isPending}
          title={guia}
          data-testid="acao-lembrar"
          className="flex items-center gap-1"
        >
          <Clock size={12} weight="regular" aria-hidden />
          {rotulo}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{opcoes}</DropdownMenuContent>
    </DropdownMenu>
  );
}
