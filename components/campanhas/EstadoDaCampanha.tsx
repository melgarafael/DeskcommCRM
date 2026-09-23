"use client";
/**
 * O estado da campanha, em palavra — nunca só em cor (PRD §34).
 *
 * Nove estados são muitos para quem só quer saber "está indo?". Cada um traz
 * ÍCONE + TEXTO, e o texto é o que o operador diria, não o que o banco guarda:
 * `preparing` é "montando a lista", `ready` é "pronta para iniciar". Quem lê
 * "ready" numa tela em português precisa traduzir de cabeça, e quem tem daltonismo
 * não tem a cor para ajudar.
 */
import { Badge } from "@/components/ui/badge";
import { useT } from "@/hooks/i18n/useT";
import { CheckCircle, Clock, Pause, PaperPlaneTilt, Warning, X } from "@/lib/ui/icons";
import type { StatusDaCampanha } from "@/lib/campanhas/tipos";

type Variante = "default" | "neutral" | "success" | "warning" | "error" | "info";

const APARENCIA: Record<
  StatusDaCampanha,
  { rotulo: string; variante: Variante; Icone: typeof Clock }
> = {
  draft: { rotulo: "Rascunho", variante: "neutral", Icone: Clock },
  preparing: { rotulo: "Montando a lista", variante: "info", Icone: Clock },
  ready: { rotulo: "Pronta para iniciar", variante: "info", Icone: CheckCircle },
  scheduled: { rotulo: "Agendada", variante: "info", Icone: Clock },
  running: { rotulo: "Enviando", variante: "success", Icone: PaperPlaneTilt },
  paused: { rotulo: "Pausada", variante: "warning", Icone: Pause },
  completed: { rotulo: "Concluída", variante: "success", Icone: CheckCircle },
  cancelled: { rotulo: "Cancelada", variante: "neutral", Icone: X },
  failed: { rotulo: "Falhou", variante: "error", Icone: Warning },
};

export function EstadoDaCampanha({ status }: { status: StatusDaCampanha }) {
  const t = useT();
  const a = APARENCIA[status];
  if (!a) return <Badge variant="neutral">{status}</Badge>;
  const { Icone } = a;
  return (
    <Badge variant={a.variante}>
      <Icone size={12} weight="bold" aria-hidden />
      {t(a.rotulo)}
    </Badge>
  );
}

/** A mesma palavra, sem badge — para título de página e texto corrido. */
export function rotuloDoEstado(status: StatusDaCampanha): string {
  return APARENCIA[status]?.rotulo ?? status;
}
