"use client";
/**
 * A faixa "Agendadas" do compositor (#3118).
 *
 * ─── Por que uma faixa acima do campo, e não um balão no fio ────────────────
 *
 * O pacote agendado ainda NÃO é mensagem: não tem `external_id`, não foi
 * entregue, e desenhá-lo no fio faria o operador achar que o cliente já recebeu.
 * A faixa fica onde o texto está sendo escrito — é ali que a decisão "mando
 * agora ou deixo para as 9h" acontece — e some quando não há nada agendado, sem
 * ocupar altura nenhuma na conversa.
 *
 * ─── O que ela mostra, e o motivo de cada estado ────────────────────────────
 *
 *   • `scheduled` — a hora marcada e o começo do texto; o `x` desmarca.
 *   • `sending`   — já está saindo: a hora vira "enviando", sem botão. Cancelar
 *                   aqui seria mentira: o que saiu não volta.
 *   • `partial`   — parte saiu, parte não. Fica visível justamente porque
 *                   alguém precisa decidir o que fazer com o que faltou.
 *   • `failed`    — nada saiu. Mesmo argumento, com o motivo do servidor.
 *
 * `sent`/`cancelled` ficam de fora: viraram história, e a conversa já a conta.
 *
 * ─── Quem decide se dá para cancelar ────────────────────────────────────────
 *
 * `podeCancelar` de `lib/mensagem-agendada/regras.ts` — a MESMA função que a
 * rota e o MCP leem. A tela não repete `status === "scheduled"`: uma segunda
 * condição escrita aqui divergiria da primeira no dia em que a régua mudasse, e
 * o botão ofereceria um gesto que o servidor recusa com 409.
 */
import { format } from "date-fns";
import { CalendarX, Clock } from "@/lib/ui/icons";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import {
  useCancelarAgendada,
  useMensagensAgendadas,
} from "@/hooks/inbox/useMensagensAgendadas";
import {
  apareceNaFaixa,
  previaDoPacote,
  type PacoteAgendado,
} from "@/lib/inbox/agendamento-na-conversa";
import { podeCancelar, type StatusDoPacote } from "@/lib/mensagem-agendada/regras";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface Props {
  conversationId: string;
  /** Caixa travada (bloqueio de canal, até assumir): o `x` também para. */
  desabilitado?: boolean;
}

/** O rótulo do estado, para os pacotes que não estão apenas esperando a hora. */
function rotuloDoEstado(status: StatusDoPacote, t: (texto: string) => string): string | null {
  switch (status) {
    case "sending":
      return t("Enviando agora…");
    case "partial":
      return t("Saiu só em parte");
    case "failed":
      return t("Não saiu");
    default:
      return null;
  }
}

export function FaixaDeAgendadas({ conversationId, desabilitado = false }: Props) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  const lista = useMensagensAgendadas(conversationId);
  const cancelar = useCancelarAgendada(conversationId);

  const pacotes = (lista.data?.data ?? []).filter((pacote) => apareceNaFaixa(pacote.status));
  if (pacotes.length === 0) return null;

  function desmarcar(pacote: PacoteAgendado): void {
    cancelar.mutate(pacote.id, {
      onSuccess: () => toast.success(t("Envio agendado cancelado.")),
    });
  }

  return (
    <div
      data-testid="faixa-agendadas"
      className="mb-1.5 rounded-md border border-border bg-muted/40 px-2 py-1.5"
    >
      <p className="mb-1 text-[11px] font-medium text-muted-foreground">{t("Agendadas")}</p>
      <ul className="space-y-1">
        {pacotes.map((pacote) => {
          const previa = previaDoPacote(pacote);
          const estado = rotuloDoEstado(pacote.status, t);
          const hora = format(new Date(pacote.scheduled_for), "dd/MM HH:mm", {
            locale: localeDaData,
          });
          return (
            <li key={pacote.id} className="flex items-start gap-2 text-xs">
              <Clock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate">
                  <span className="font-medium">{hora}</span>
                  <span className="text-muted-foreground">
                    {" · "}
                    {previa ?? t("(anexo)")}
                  </span>
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {/* Umas poucas partes de uma vez: o pacote inteiro, e não só a primeira. */}
                  {pacote.parts.length > 1
                    ? t("{n} mensagens seguidas").replace("{n}", String(pacote.parts.length))
                    : null}
                  {pacote.parts.length > 1 && estado ? " · " : null}
                  {estado}
                  {pacote.cancel_if_contact_replies ? ` · ${t("Cancela se o contato responder")}` : null}
                </p>
                {pacote.cancel_reason && pacote.status !== "scheduled" ? (
                  <p className="text-[11px] text-muted-foreground">{pacote.cancel_reason}</p>
                ) : null}
                {pacote.last_error && pacote.status !== "scheduled" ? (
                  <p className="text-[11px] text-destructive">{pacote.last_error}</p>
                ) : null}
              </div>
              {podeCancelar(pacote.status) && (
                <button
                  type="button"
                  onClick={() => desmarcar(pacote)}
                  disabled={desabilitado || cancelar.isPending}
                  aria-label={t("Cancelar envio agendado")}
                  title={t("Cancelar envio agendado")}
                  className={cn(
                    "inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground lg:size-auto lg:p-0.5",
                    "hover:bg-muted hover:text-foreground disabled:opacity-50",
                  )}
                >
                  <CalendarX className="size-4" aria-hidden />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
