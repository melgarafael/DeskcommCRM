"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { format, formatDistanceToNowStrict } from "date-fns";
import { pt as ptBR } from "date-fns/locale";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { CaretLeft, Clock, Pause, Play, SkipForward, Trash, Warning } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import {
  descreveEvento,
  rotuloDoStatus,
  tipoDoNo,
  tomDoStatus,
  type EventoDeEnrollment,
  type NoDoDossie,
} from "@/lib/followup/eventos-legiveis";
import { useFollowupEnrollment, useIntervirNoFollowup } from "@/hooks/followup/useFollowupEnrollment";
import { useCancelFollowupEnrollment } from "@/hooks/followup/useFollowupQueue";

import { PlanoDeTempoBloco } from "./PlanoDeTempo";

interface Props {
  id: string;
  canWrite: boolean;
}

const PAUSAVEL = new Set(["active", "waiting_reply"]);
/** Pausado por uma pessoa também se cancela — sem ter de retomar antes só para encerrar. */
const CANCELAVEL = new Set(["active", "waiting_reply", "paused_handoff", "paused_manual"]);

function absoluta(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : format(d, "dd/MM/yyyy HH:mm", { locale: ptBR });
}

function relativa(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return formatDistanceToNowStrict(d, { addSuffix: true, locale: ptBR });
}

/** O valor que o `<input type="datetime-local">` entende, no fuso de quem olha. */
function paraCampoLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function Campo({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-text-muted">{rotulo}</span>
      <span className="text-sm text-text">{children}</span>
    </div>
  );
}

/**
 * A linha do tempo do FLUXO — irmã da timeline do negócio, não a mesma.
 *
 * Aqui cada linha é um passo do motor traduzido por `descreveEvento`; o marcador
 * segue a mesma gramática de forma do `LeadTimeline` (preenchido = gente, anel =
 * automático, tracejado = o cliente), para quem já conhece uma tela não ter de
 * aprender outra.
 */
function LinhaDoTempo({
  eventos,
  nos,
  autores,
  truncado,
}: {
  eventos: EventoDeEnrollment[];
  nos: NoDoDossie[];
  autores: Record<string, string>;
  truncado: boolean;
}) {
  const porId = useMemo(() => Object.fromEntries(nos.map((n) => [n.id, n])), [nos]);

  if (eventos.length === 0) {
    return (
      <p className="py-4 text-sm text-text-muted" data-testid="dossie-timeline-vazia">
        Este follow-up ainda não deu nenhum passo.
      </p>
    );
  }

  return (
    <>
      {truncado && (
        <p className="pb-2 text-xs text-warning-fg">
          Mostrando os primeiros passos — este follow-up tem histórico maior que o desta tela.
        </p>
      )}
      <ul className="border-l border-border pl-3" data-testid="dossie-timeline">
        {eventos.map((evento) => {
          const lido = descreveEvento(evento, porId);
          const autorId = (evento.payload as { actor_user_id?: unknown } | null)?.actor_user_id;
          const nome = typeof autorId === "string" ? autores[autorId] : undefined;
          return (
            <li key={evento.id} className="flex gap-2 py-2" data-testid="dossie-evento">
              <span
                aria-hidden
                className={cn(
                  "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                  lido.autor === "pessoa" && "bg-text",
                  lido.autor === "motor" && "border border-text bg-transparent",
                  lido.autor === "cliente" && "border border-dashed border-text-muted bg-transparent",
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-text">{lido.titulo}</p>
                {lido.detalhe && <p className="mt-0.5 text-xs text-text-muted">{lido.detalhe}</p>}
                <p className="mt-0.5 text-[11px] text-text-muted">
                  {lido.onde}
                  {nome ? ` · ${nome}` : ""} · {absoluta(evento.created_at)}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function DossieDoFollowup({ id, canWrite }: Props) {
  const { data, isLoading, isError } = useFollowupEnrollment(id);
  const intervir = useIntervirNoFollowup();
  const cancelar = useCancelFollowupEnrollment();
  const [adiando, setAdiando] = useState(false);
  const [quando, setQuando] = useState("");
  const [pulando, setPulando] = useState(false);
  const [cancelando, setCancelando] = useState(false);


  if (isLoading) {
    return <p className="p-6 text-sm text-text-muted">Carregando o follow-up…</p>;
  }
  // Erro NÃO vira "não existe": um follow-up que falhou ao carregar e um que
  // sumiu pedem ações opostas de quem está olhando.
  if (isError || !data) {
    return (
      <div className="p-6">
        <p className="text-sm text-warning-fg">
          Não consegui carregar este follow-up. Recarregue a página; se persistir, ele pode ter sido removido.
        </p>
        <Link href="/app/ai/followups" className="mt-3 inline-block text-sm underline">
          Voltar para a fila
        </Link>
      </div>
    );
  }

  // Quem decide se o motor está ocupado é o SERVIDOR (o relógio que vale é o do
  // banco); a tela só mostra o que veio na resposta.
  const motorOcupado = data.motor_ocupado;
  const podePausar = canWrite && PAUSAVEL.has(data.status);
  const podeRetomar = canWrite && data.status === "paused_manual";
  const podeMexerNoRelogio = canWrite && PAUSAVEL.has(data.status);
  const podeCancelar = canWrite && CANCELAVEL.has(data.status);

  const pular = (edgeId?: string) => {
    intervir.mutate({ id, acao: "skip", body: edgeId ? { edge_id: edgeId } : {} });
    setPulando(false);
  };

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="flex flex-col gap-3">
        <Link
          href="/app/ai/followups"
          className="inline-flex w-fit items-center gap-1 text-sm text-text-muted hover:text-text"
        >
          <CaretLeft size={14} aria-hidden /> Fila de follow-ups
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{data.contact.name}</h1>
          <Badge variant={tomDoStatus(data.status)} data-testid="dossie-status">
            {rotuloDoStatus(data.status)}
          </Badge>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Campo rotulo="Fluxo">{data.flow.name ?? "Fluxo removido"}</Campo>
          <Campo rotulo="Agente">{data.agent_name ?? "Nenhum agente fixado"}</Campo>
          <Campo rotulo="Começou">{absoluta(data.started_at)}</Campo>
          <Campo rotulo="Passos dados">{data.steps_taken}</Campo>
        </div>
      </header>

      <section className="rounded-md border border-border p-4" data-testid="dossie-onde-esta">
        <h2 className="mb-2 text-sm font-medium">Onde está agora</h2>
        <div className="flex flex-col gap-1">
          <p className="text-sm text-text">
            {data.no_atual ? (
              <>
                <span className="font-medium">{data.no_atual.rotulo}</span>{" "}
                <span className="text-text-muted">
                  ({tipoDoNo(data.no_atual.tipo)} — {data.no_atual.resumo})
                </span>
              </>
            ) : (
              // O passo saiu do grafo pinado: dizer o id EXPLICITAMENTE é o que
              // permite alguém investigar; esconder deixaria a tela muda.
              <span className="text-text-muted">
                passo {data.current_node_id} — não existe mais na versão publicada deste fluxo
              </span>
            )}
          </p>
          <p className="flex items-center gap-1.5 text-sm text-text-muted" data-testid="dossie-proximo-passo">
            <Clock size={14} aria-hidden />
            {data.next_eval_at
              ? `Volta a andar ${relativa(data.next_eval_at)} (${absoluta(data.next_eval_at)})`
              : data.status === "paused_manual"
                ? "Parado até alguém retomar"
                : data.completed_at
                  ? `Encerrado em ${absoluta(data.completed_at)}`
                  : "Sem próximo passo agendado"}
          </p>
          {data.outcome && <p className="text-sm text-text-muted">Desfecho: {data.outcome}</p>}
          {data.cancel_reason && <p className="text-sm text-text-muted">Motivo: {data.cancel_reason}</p>}
          {data.last_error && (
            <p className="flex items-center gap-1.5 text-sm text-warning-fg">
              <Warning size={14} aria-hidden /> Última falha: {data.last_error} (tentativa {data.attempts} de{" "}
              {data.max_attempts})
            </p>
          )}
          {motorOcupado && (
            <p className="text-xs text-text-muted" data-testid="dossie-motor-ocupado">
              O automático está executando este follow-up agora — as ações abaixo podem ser recusadas por
              alguns instantes.
            </p>
          )}
        </div>
      </section>

      {canWrite && (
        <section className="flex flex-wrap gap-2" data-testid="dossie-acoes">
          {podePausar && (
            <Button
              variant="outline"
              size="sm"
              data-testid="dossie-pausar"
              disabled={intervir.isPending}
              onClick={() => intervir.mutate({ id, acao: "pause" })}
            >
              <Pause size={14} aria-hidden className="mr-1" /> Pausar
            </Button>
          )}
          {podeRetomar && (
            <Button
              variant="outline"
              size="sm"
              data-testid="dossie-retomar"
              disabled={intervir.isPending}
              onClick={() => intervir.mutate({ id, acao: "resume" })}
            >
              <Play size={14} aria-hidden className="mr-1" /> Retomar
            </Button>
          )}
          {podeMexerNoRelogio && (
            <Button
              variant="outline"
              size="sm"
              data-testid="dossie-adiar"
              disabled={intervir.isPending}
              onClick={() => {
                const base = data.next_eval_at ? new Date(data.next_eval_at) : new Date();
                const alvo = base.getTime() > Date.now() ? base : new Date();
                alvo.setDate(alvo.getDate() + 1);
                setQuando(paraCampoLocal(alvo));
                setAdiando(true);
              }}
            >
              <Clock size={14} aria-hidden className="mr-1" /> Adiar
            </Button>
          )}
          {/*
            SEM SAÍDA, O BOTÃO NÃO EXISTE — não fica desabilitado.
            Passo sem aresta de saída não tem para onde pular NUNCA, e isso não é
            um "agora não".

            A regra, na formulação do `@QAVivo`, que nomeia quem paga e como:
            desabilitado é PROMESSA de "agora não", então serve para o que é
            temporário (o `isPending`, que volta em segundos). Desabilitado
            PERMANENTE manda o usuário procurar a condição que habilita — e ela
            não existe, então ele acha que a culpa é dele.

            Mesma família do modo adaptativo desta wave: a tela oferecendo o que
            o código ignora. Só que ali ela mentia sobre o RESULTADO, e aqui
            mentiria sobre a POSSIBILIDADE.
          */}
          {podeMexerNoRelogio && data.saidas.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              data-testid="dossie-pular"
              disabled={intervir.isPending}
              onClick={() => (data.saidas.length === 1 ? pular() : setPulando(true))}
            >
              <SkipForward size={14} aria-hidden className="mr-1" /> Pular este passo
            </Button>
          )}
          {/*
            Cancelar mora aqui TAMBÉM, e não só na fila: quem abriu o dossiê para
            decidir o que fazer com este follow-up não deve ter de voltar uma tela
            para escolher a única saída definitiva. É a mesma rota que a fila usa.
          */}
          {podeCancelar && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="dossie-cancelar"
              disabled={cancelar.isPending}
              onClick={() => setCancelando(true)}
            >
              <Trash size={14} aria-hidden className="mr-1 text-error" /> Cancelar follow-up
            </Button>
          )}
        </section>
      )}

      <PlanoDeTempoBloco
        plano={data.plano_de_tempo}
        nos={data.nos}
        decididoRelativo={relativa(data.plano_de_tempo?.decidido_em ?? null)}
      />

      <section className="rounded-md border border-border p-4">
        <h2 className="mb-1 text-sm font-medium">O que já aconteceu</h2>
        <LinhaDoTempo
          eventos={data.eventos}
          nos={data.nos}
          autores={data.autores}
          truncado={data.eventos_truncados}
        />
      </section>

      <Dialog open={adiando} onOpenChange={setAdiando}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adiar o próximo passo</DialogTitle>
            <DialogDescription>
              O follow-up continua no mesmo passo e volta a andar no horário que você escolher.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="adiar-quando">Novo horário</Label>
            <Input
              id="adiar-quando"
              type="datetime-local"
              value={quando}
              onChange={(e) => setQuando(e.target.value)}
              data-testid="dossie-adiar-quando"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAdiando(false)}>
              Voltar
            </Button>
            <Button
              data-testid="dossie-adiar-confirmar"
              disabled={!quando || intervir.isPending}
              onClick={() => {
                const d = new Date(quando);
                if (Number.isNaN(d.getTime())) return;
                intervir.mutate({ id, acao: "snooze", body: { next_eval_at: d.toISOString() } });
                setAdiando(false);
              }}
            >
              Adiar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={cancelando} onOpenChange={setCancelando}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar este follow-up?</AlertDialogTitle>
            <AlertDialogDescription>
              O lead não receberá mais mensagens deste fluxo. Diferente de pausar, isto não pode ser desfeito.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              data-testid="dossie-cancelar-confirmar"
              onClick={() => {
                cancelar.mutate(id);
                setCancelando(false);
              }}
            >
              Cancelar follow-up
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={pulando} onOpenChange={setPulando}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Por onde seguir?</DialogTitle>
            <DialogDescription>
              Este passo tem mais de um caminho no fluxo. Escolher por você seria decidir o rumo do
              atendimento sem perguntar.
            </DialogDescription>
          </DialogHeader>
          <ul className="flex flex-col gap-2">
            {data.saidas.map((s) => (
              <li key={s.edge_id}>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  data-testid="dossie-pular-opcao"
                  disabled={intervir.isPending}
                  onClick={() => pular(s.edge_id)}
                >
                  <span className="truncate">
                    {s.target_rotulo} <span className="text-text-muted">— {s.quando}</span>
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}
