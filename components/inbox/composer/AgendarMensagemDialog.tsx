"use client";
/**
 * O diálogo de "agendar mensagem" (#3118) — o passo entre escrever e a hora
 * marcada.
 *
 * ─── O que ele é, e o que ele NÃO é ─────────────────────────────────────────
 *
 * É a porta da MESMA mensagem que o compositor já sabe escrever: texto único,
 * hora absoluta, cancela se o contato responder. Não é campanha, não é
 * recorrência, não é anexo — as três têm outra porta (ou não têm porta ainda).
 * Manter o diálogo pequeno é o que faz o gesto caber no meio do atendimento.
 *
 * ─── A validação é a do SERVIDOR, chamada aqui ─────────────────────────────
 *
 * `validaAgendamento` é a régua única (piso de 30 s, teto de um ano, corpo de
 * 4096), lida pela rota, pelo MCP e pelo worker. Chamá-la no cliente não é
 * duplicar a regra: é a mesma função, importada, para o operador ver o motivo
 * antes de a requisição sair — e para o erro não depender do 422 voltar em
 * português de servidor.
 *
 * O que o cliente ACRESCENTA é só a conversão de hora de parede para instante
 * (`instanteDoCampo`), que o servidor não tem como fazer: ele não conhece o
 * fuso do aparelho de quem agendou.
 */
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { useAgendarMensagem } from "@/hooks/inbox/useMensagensAgendadas";
import {
  fusoDoNavegador,
  instanteDoCampo,
  sugestaoDeHorario,
} from "@/lib/inbox/agendamento-na-conversa";
import { validaAgendamento } from "@/lib/mensagem-agendada/regras";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  /** O que já está escrito no compositor — o caso comum é agendar o que se acabou de redigir. */
  textoInicial?: string;
  /** Chamado quando o pacote foi criado: o compositor limpa o campo. */
  onAgendado?: () => void;
}

/**
 * Recusa → frase de tela.
 *
 * Só os códigos que o operador consegue provocar aqui; o resto cai na frase
 * genérica, porque um código novo na régua não pode virar caixa vazia na cara
 * de quem está atendendo.
 */
function avisoDaRecusa(codigo: string, t: (texto: string) => string): string {
  switch (codigo) {
    case "instante_invalido":
      return t("Escolha um dia e um horário para a mensagem sair.");
    case "instante_no_passado":
      return t("Escolha um horário pelo menos 30 segundos à frente de agora.");
    case "instante_longe_demais":
      return t("O agendamento vale por até um ano. Escolha um horário mais próximo.");
    case "parte_vazia":
    case "sem_partes":
      return t("Escreva a mensagem antes de agendar.");
    case "corpo_longo_demais":
      return t("A mensagem passa de 4096 caracteres. Encurte antes de agendar.");
    case "fuso_invalido":
      return t("O fuso do seu aparelho não foi reconhecido. Recarregue a página e tente de novo.");
    default:
      return t("Não foi possível agendar. Revise o horário e o texto.");
  }
}

export function AgendarMensagemDialog({
  open,
  onOpenChange,
  conversationId,
  textoInicial = "",
  onAgendado,
}: Props) {
  const t = useT();
  const agendar = useAgendarMensagem(conversationId);
  const [texto, setTexto] = useState(textoInicial);
  const [quando, setQuando] = useState(sugestaoDeHorario());
  const [cancelarSeResponder, setCancelarSeResponder] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  /**
   * Cada abertura começa do estado de agora.
   *
   * Sem isto, o segundo agendamento da mesma conversa abriria com a hora do
   * primeiro (já pode ter passado) e com o aviso do erro anterior na tela —
   * dois fantasmas que o operador teria de apagar à mão.
   */
  useEffect(() => {
    if (!open) return;
    setTexto(textoInicial);
    setQuando(sugestaoDeHorario());
    setCancelarSeResponder(false);
    setAviso(null);
  }, [open, textoInicial]);

  function confirmar() {
    const instante = instanteDoCampo(quando);
    const avaliacao = validaAgendamento({
      conversation_id: conversationId,
      scheduled_for: instante ?? "",
      tz: fusoDoNavegador(),
      cancel_if_contact_replies: cancelarSeResponder,
      parts: [{ body: texto }],
    });
    if (!avaliacao.ok) {
      setAviso(avisoDaRecusa(avaliacao.codigo, t));
      return;
    }
    setAviso(null);
    agendar.mutate(
      {
        conversation_id: conversationId,
        // O instante VALIDADO é o mesmo que a régua acabou de aprovar — mandar
        // o texto cru do campo faria a rota reconverter pelo fuso do servidor.
        scheduled_for: avaliacao.quando.toISOString(),
        tz: avaliacao.tz,
        body: texto.trim(),
        cancel_if_contact_replies: cancelarSeResponder,
      },
      {
        onSuccess: () => {
          toast.success(t("Mensagem agendada."));
          onOpenChange(false);
          onAgendado?.();
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Agendar mensagem")}</DialogTitle>
          <DialogDescription>
            {t("A mensagem sai sozinha no horário marcado, mesmo com o navegador fechado.")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="agendar-quando">{t("Quando enviar")}</Label>
            <Input
              id="agendar-quando"
              type="datetime-local"
              value={quando}
              onChange={(e) => {
                setQuando(e.target.value);
                setAviso(null);
              }}
            />
            <p className="text-xs text-muted-foreground">{t("No fuso do seu aparelho.")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="agendar-texto">{t("Mensagem")}</Label>
            <Textarea
              id="agendar-texto"
              value={texto}
              onChange={(e) => {
                setTexto(e.target.value);
                setAviso(null);
              }}
              rows={4}
              maxLength={4096}
              placeholder={t("Escreva a mensagem que vai sair no horário marcado…")}
            />
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={cancelarSeResponder}
              onChange={(e) => setCancelarSeResponder(e.target.checked)}
            />
            <span className="min-w-0 flex-1">
              {t("Cancelar se o contato responder antes")}
              <span className="block text-xs text-muted-foreground">
                {t("Se ele responder, o agendamento é desmarcado sozinho.")}
              </span>
            </span>
          </label>

          {aviso && (
            <p data-testid="aviso-agendamento" className="text-xs text-destructive">
              {aviso}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("Cancelar")}
          </Button>
          <Button
            type="button"
            onClick={confirmar}
            disabled={agendar.isPending || texto.trim() === ""}
          >
            {agendar.isPending ? t("Agendando…") : t("Agendar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
