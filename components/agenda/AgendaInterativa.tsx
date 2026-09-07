"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import { useT } from "@/hooks/i18n/useT";

import { differenceInMinutes, format } from "date-fns";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { useHorariosLivres } from "@/hooks/agenda/useHorariosLivres";
import { useRemarcarAgendamento } from "@/hooks/agenda/useRemarcarAgendamento";
import type { MotivoDaGradeTravada } from "@/lib/agenda/grade-interativa";
import { cn } from "@/lib/utils";

import { GradeDaAgenda } from "./GradeDaAgenda";
import type { Agendamento, Pessoa, VisaoDaAgenda } from "./tipos";

/**
 * A AGENDA QUE RESPONDE — o que liga a grade à disponibilidade real e ao
 * caminho de remarcar que já existia.
 *
 * ─── Por que um componente novo, e não mais código em `_client.tsx` ──────
 *
 * Três coisas moram aqui e nenhuma delas é da tela: a consulta de horários
 * livres para a janela que a grade desenha, o estado do gesto de remarcar
 * (proposta → confirmação → otimismo → volta atrás) e a tradução de "a rota
 * respondeu isto" para "a grade está travada por este motivo". `_client.tsx` já
 * tem quase quinhentas linhas e é o arquivo mais disputado desta feature —
 * empilhar mais estado nele é como o painel de marcação acumulou o defeito de
 * ter duas contas para a mesma decisão.
 *
 * ─── A disponibilidade NÃO é recalculada, é perguntada ───────────────────
 *
 * `useHorariosLivres` é o mesmo hook que o painel de marcação usa, batendo na
 * mesma rota que o agente usa. A diferença é só o recorte: o painel pergunta
 * pelos próximos 30 dias, a grade pergunta pela janela que ela desenha. Duas
 * perguntas, uma regra — então tela e agente nunca discordam sobre o que está
 * livre. Reimplementar jornada aqui seria mais rápido e criaria exatamente essa
 * discordância, que aparece como 422 na cara de quem clicou.
 */
export function AgendaInterativa({
  visao,
  ancora,
  agora,
  pessoas,
  agendamentos,
  recorte,
  tipos,
  tipo,
  onEscolherTipo,
  onMarcarEm,
  onAbrirAgendamento,
  className,
}: {
  visao: VisaoDaAgenda;
  ancora: Date;
  /** INJETADO, como na grade: relógio lido aqui dentro daria dois relógios ao teste. */
  agora: Date;
  pessoas: Pessoa[];
  agendamentos: Agendamento[];
  /** A MESMA janela que a grade desenha — vem de quem já a calcula, sem recontá-la. */
  recorte: { de: string; ate: string };
  /**
   * O tipo de agendamento escolhido. `null` = a organização não cadastrou
   * nenhum, e aí não há o que marcar: a grade volta a ser só leitura e quem
   * explica é o cabeçalho da tela, que já diz "cadastre um tipo para começar".
   * Inventar aqui uma quarta razão de bloqueio repetiria a mensagem no lugar
   * errado.
   */
  tipo: { id: string; duracaoMin: number } | null;
  /**
   * OS TIPOS, para o seletor que esta tela não tinha — e a ausência dele virou
   * defeito no primeiro contato com dado real.
   *
   * A grade oferece a disponibilidade de UM tipo (é o que a rota pede), e até
   * aqui esse tipo era `tiposIniciais[0]`: o primeiro em ordem alfabética,
   * escolhido por ninguém e invisível na tela. Numa organização com
   * "Atendimento", "Consulta" e "Reunião", a grade inteira desenhava a
   * disponibilidade de "Atendimento" — e, se o dono dele não tivesse jornada
   * publicada, a grade travava com "não consegui carregar os horários" enquanto
   * os outros dois tipos tinham vaga. Medido na primeira execução da spec
   * nova, contra o banco do e2e.
   *
   * O seletor existia, mas DENTRO do painel de marcação: escolher o tipo era
   * parte de marcar. Agora ele também governa o que a grade mostra, e
   * configuração que governa a tela precisa de superfície NA tela — é o
   * invariante 6 do Sistema Vivo. O estado é o mesmo nos dois lugares: trocar
   * aqui troca lá.
   */
  tipos: Array<{ id: string; nome: string; duracaoMin: number }>;
  onEscolherTipo: (id: string) => void;
  onMarcarEm: (instante: string) => void;
  onAbrirAgendamento?: (id: string) => void;
  className?: string;
}) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const { data: horarios, isError: horariosFalharam } = useHorariosLivres(
    tipo ? { event_type_id: tipo.id, de: recorte.de, ate: recorte.ate } : null,
  );

  const horariosPorDia = React.useMemo(() => {
    const mapa: Record<string, Array<{ instante: string; rotulo: string }>> = {};
    for (const s of horarios?.slots ?? []) {
      const d = new Date(s.inicio);
      (mapa[format(d, "yyyy-MM-dd")] ??= []).push({ instante: s.inicio, rotulo: format(d, "HH:mm") });
    }
    return mapa;
  }, [horarios]);

  /**
   * Por que a grade está travada — a MESMA ordem do painel de marcação, e de
   * propósito: as duas telas do mesmo produto respondendo diferente à mesma
   * pergunta é o que faz alguém abrir chamado dizendo que a agenda "às vezes
   * some".
   *
   * `?? true` no `publicou_horarios` seria o defeito que o painel já pagou —
   * com a resposta ausente (erro), o `?? true` diz "publicou" e a tela trava sem
   * aviso nenhum. Por isso o erro é testado ANTES, e a ausência de resposta não
   * vira afirmação.
   */
  const motivo: MotivoDaGradeTravada | null = horariosFalharam
    ? "erro"
    : horarios && !horarios.publicou_horarios
      ? "sem-jornada"
      : horarios && horarios.slots.length === 0
        ? "sem-vaga"
        : null;

  // ─── REMARCAR: proposta → confirmação → otimismo → volta atrás ─────────
  const remarcar = useRemarcarAgendamento();
  const [pendente, setPendente] = React.useState<{ id: string; instante: string } | null>(null);
  const [recusa, setRecusa] = React.useState<string | null>(null);
  /**
   * O card na posição NOVA antes de o servidor confirmar.
   *
   * É o que faz o gesto parecer imediato — e é por isso que ele tem de saber
   * voltar. Card que fica no lugar novo depois de o servidor recusar mente
   * sobre o estado real, e a mentira é pior que a lentidão: a pessoa fecha a
   * tela achando que remarcou.
   */
  const [otimista, setOtimista] = React.useState<{
    id: string;
    comeca: string;
    termina: string;
    /** Para onde ele volta, se voltar. */
    antes: { comeca: string; termina: string };
  } | null>(null);

  /**
   * O otimismo termina quando o dado REAL o alcança — não no `onSuccess`.
   *
   * Limpar na resposta do PATCH devolveria o card ao horário antigo por um
   * quadro, até o `useAgendamentos` refazer a busca que a invalidação disparou.
   * Um piscar para trás depois de "remarcado" é indistinguível de falha.
   */
  React.useEffect(() => {
    if (!otimista) return;
    const real = agendamentos.find((a) => a.id === otimista.id);
    if (real && new Date(real.comeca).getTime() === new Date(otimista.comeca).getTime()) {
      setOtimista(null);
    }
  }, [agendamentos, otimista]);

  const desenhados = React.useMemo(
    () =>
      otimista
        ? agendamentos.map((a) =>
            a.id === otimista.id ? { ...a, comeca: otimista.comeca, termina: otimista.termina } : a,
          )
        : agendamentos,
    [agendamentos, otimista],
  );

  const confirmar = React.useCallback(() => {
    if (!pendente) return;
    const alvo = agendamentos.find((a) => a.id === pendente.id);
    if (!alvo) return;
    const duracao = Math.max(differenceInMinutes(new Date(alvo.termina), new Date(alvo.comeca)), 15);
    const comeca = new Date(pendente.instante);
    const antes = { comeca: alvo.comeca, termina: alvo.termina };
    setOtimista({
      id: alvo.id,
      comeca: comeca.toISOString(),
      termina: new Date(comeca.getTime() + duracao * 60_000).toISOString(),
      antes,
    });
    setPendente(null);
    void remarcar.mutateAsync({ id: alvo.id, starts_at: pendente.instante }).catch(() => {
      // O toast do `showApiError` já diz o que o servidor respondeu; o que ele
      // NÃO diz é que o card voltou. Sem esta linha o aviso some junto com o
      // toast e a tela fica sem registro de que a remarcação não valeu.
      setOtimista(null);
      setRecusa(
        `A remarcação não foi aceita — o compromisso voltou para ${format(
          new Date(antes.comeca),
          "EEEE, d 'de' MMMM 'às' HH:mm",
          { locale: localeDaData },
        )}.`,
      );
    });
  }, [agendamentos, pendente, remarcar]);

  const nomeDoPendente = pendente
    ? (agendamentos.find((a) => a.id === pendente.id)?.titulo ?? "o compromisso")
    : "";

  return (
    <div className={cn("flex min-h-0 flex-col gap-2", className)}>
      {horarios?.google_cobertura_parcial && <p role="status" className="text-xs text-warning">{t("Ocupação do Google ainda não verificada neste período.")}</p>}
      {tipos.length > 1 && (
        <div
          data-testid="tipo-da-grade"
          className="flex flex-wrap items-center gap-1.5 text-xs text-text-muted"
        >
          <span className="shrink-0">{t("Horários livres de")}</span>
          {tipos.map((t) => (
            <button
              key={t.id}
              type="button"
              data-testid={`tipo-da-grade-${t.id}`}
              aria-pressed={t.id === tipo?.id}
              onClick={() => onEscolherTipo(t.id)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 transition-colors duration-fast",
                t.id === tipo?.id
                  ? "border-transparent bg-accent text-accent-foreground"
                  : "border-border hover:border-border-strong hover:text-text",
              )}
            >
              {t.nome}
            </button>
          ))}
        </div>
      )}

      {/*
        O MOTIVO EM TEXTO, e não só no `title` de cada bloco.

        Atributo de hover não existe para quem usa toque — que é o dono de
        clínica com o celular na mão e o paciente na frente. É a mesma razão
        pela qual `PainelDeMarcacao` mostra o bloco de motivo acima do
        calendário em vez de confiar no `title` dos dias.
      */}
      {motivo && (
        <div
          data-testid="motivo-da-grade"
          data-motivo={motivo}
          role="status"
          className="rounded-sm border border-border bg-surface-sunken px-3 py-2 text-xs leading-4 text-text-muted"
        >
          {motivo === "sem-jornada" ? (
            <>
              <span className="font-semibold text-text">
                {t("Você ainda não publicou seus horários de atendimento.")}
              </span>{" "}
              {t("Sem eles ninguém consegue marcar clicando na grade — nem você, nem o agente.")}
            </>
          ) : motivo === "erro" ? (
            <>
              <span className="font-semibold text-text">{t("Não consegui carregar os horários.")}</span> {t("Os blocos ficam bloqueados até eu conseguir — é mais seguro que oferecer um horário que talvez não exista.")}
            </>
          ) : (
            <>
              <span className="font-semibold text-text">{t("Nenhum horário livre neste período.")}</span> {t("Os blocos vazios continuam aqui, e o que estiver publicado fica clicável.")}
            </>
          )}
        </div>
      )}

      {/* A CONFIRMAÇÃO, antes de consumar. Remarcar avisa o cliente do outro
          lado — a regra do tempo da doutrina do Sistema Vivo pede que a ação
          que sai para fora aconteça no tempo do humano, não no do gesto. */}
      {pendente && (
        <div
          data-testid="confirmar-remarcacao"
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-accent/50 bg-accent-soft px-3 py-2"
        >
          <p className="text-xs leading-4 text-text">
            {t("Remarcar")} <span className="font-semibold">{nomeDoPendente}</span> {t("para")}{" "}
            <span className="font-semibold">
              {format(new Date(pendente.instante), "EEEE, d 'de' MMMM 'às' HH:mm", { locale: localeDaData })}
            </span>
            {t("? Quem foi atendido recebe o aviso da mudança.")}
          </p>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPendente(null)}>
              Cancelar
            </Button>
            <Button size="sm" data-testid="confirmar-remarcacao-botao" onClick={confirmar}>
              Remarcar
            </Button>
          </div>
        </div>
      )}

      {recusa && (
        <div
          data-testid="remarcacao-recusada"
          role="status"
          className="flex items-center justify-between gap-2 rounded-sm border border-warning/40 bg-warning-bg px-3 py-2"
        >
          <p className="text-xs leading-4 text-text">{recusa}</p>
          <button
            type="button"
            onClick={() => setRecusa(null)}
            className="shrink-0 text-xs font-medium text-text-muted underline underline-offset-2 hover:text-text"
          >
            Entendi
          </button>
        </div>
      )}

      <GradeDaAgenda
        visao={visao}
        ancora={ancora}
        agora={agora}
        pessoas={pessoas}
        agendamentos={desenhados}
        onAbrirAgendamento={onAbrirAgendamento}
        className="min-h-0 flex-1"
        interacao={
          tipo
            ? {
                horariosPorDia,
                motivo,
                duracaoMin: tipo.duracaoMin,
                onMarcarEm,
                onArrastarPara: ({ instante, razao, id }) => {
                  if (!instante) {
                    // RECUSA EXPLÍCITA, sem tocar no servidor: o destino não
                    // está na disponibilidade publicada. Remarcar assim mesmo
                    // criaria um compromisso que o motor não teria oferecido.
                    setPendente(null);
                    setRecusa(`Não dá para remarcar para esse horário — ${razao}.`);
                    return;
                  }
                  setRecusa(null);
                  setPendente({ id, instante });
                },
              }
            : undefined
        }
      />
    </div>
  );
}
