"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import { useT } from "@/hooks/i18n/useT";

import { differenceInMinutes, format } from "date-fns";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { useHorariosLivres } from "@/hooks/agenda/useHorariosLivres";
import { useHorariosLivresPorPessoa } from "@/hooks/agenda/useHorariosLivresPorPessoa";
import { useRemarcarAgendamento } from "@/hooks/agenda/useRemarcarAgendamento";
import type { FechamentoDaGrade } from "@/lib/agenda/fechamentos-na-grade";
import { ApiError } from "@/lib/api/types";
import type { MotivoDaGradeTravada } from "@/lib/agenda/grade-interativa";
import { cn } from "@/lib/utils";

import { GradeDaAgenda, JANELA_DA_GRADE } from "./GradeDaAgenda";
import { QuadroPorProfissional } from "./QuadroPorProfissional";
import type { Agendamento, Pessoa, VisaoDaAgenda } from "./tipos";
import { dataDeParede, diaLocalISO } from "@/lib/agenda/fuso";

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
 * pelo mês que ele está mostrando, a grade pergunta pela janela que ela desenha.
 * Duas perguntas, uma regra — então tela e agente nunca discordam sobre o que
 * está livre. Reimplementar jornada aqui seria mais rápido e criaria exatamente
 * essa discordância, que aparece como 422 na cara de quem clicou.
 */
/** O card na posição NOVA antes de o servidor confirmar — ver `otimistas`. */
type Otimismo = {
  id: string;
  comeca: string;
  termina: string;
  /** Para onde ele volta, se voltar. */
  antes: { comeca: string; termina: string };
  /** Quem pôs este otimismo: a falha de um PATCH só desfaz o PRÓPRIO (#4450). */
  pedido?: number;
  /** A revisão que o PATCH levou — o servidor com uma MAIOR já é a verdade. */
  revisao?: number;
};

export function AgendaInterativa({
  visao,
  ancora,
  agora,
  fuso,
  pessoas,
  agendamentos,
  fechamentos,
  recorte,
  tipos,
  tipo,
  onEscolherTipo,
  onMarcarEm,
  onAbrirAgendamento,
  donoId,
  onMarcarComProfissional,
  ocupacao,
  className,
}: {
  visao: VisaoDaAgenda;
  ancora: Date;
  /** INJETADO, como na grade: relógio lido aqui dentro daria dois relógios ao teste. */
  agora: Date;
  /**
   * O fuso RESOLVIDO da organização — a régua de hora de parede da grade.
   * Sem ele a grade desenha no relógio do navegador (issue #1362).
   */
  fuso: string;
  pessoas: Pessoa[];
  agendamentos: Agendamento[];
  /** As faixas de "Dias fora da rotina", repassadas à grade como vieram. */
  fechamentos?: FechamentoDaGrade[];
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
  /**
   * O clique num bloco livre da grade. OPCIONAL de propósito: quem só lê não
   * recebe esta prop, e a AUSÊNCIA dela é o que desmonta a interação inteira
   * abaixo — oferecer o gesto a quem não pode executá-lo é oferecer um 403, que
   * é o defeito que este PR fecha. `undefined` = grade de leitura.
   */
  onMarcarEm?: (instante: string) => void;
  onAbrirAgendamento?: (id: string) => void;
  /**
   * O PROFISSIONAL ISOLADO no filtro da agenda (#4186) — `null` = "todos".
   *
   * A grade pergunta a disponibilidade de UM profissional (a rota recebe
   * `event_type_id` e, opcionalmente, `owner_user_id`). Sem esta prop, isolar a
   * Ana mostrava os blocos dela e pintava como "livre" a jornada do DONO DO TIPO
   * — clicar ali abria o painel da Ana num horário que a Ana não atende, e o
   * motor recusava a escrita. O filtro tem de governar os dois lados: o que se
   * vê e o que se oferece clicar.
   */
  donoId?: string | null;
  /**
   * O clique num bloco livre do QUADRO (#4186): ali a linha diz QUEM atende, e
   * o painel precisa abrir com essa pessoa — não com o dono do tipo nem com o
   * isolado do filtro. `undefined` = quadro de leitura, pela mesma regra de
   * `onMarcarEm`.
   */
  onMarcarComProfissional?: (instante: string, pessoaId: string) => void;
  /**
   * Tudo o que ocupa as agendas no período, SEM o filtro de profissional — a
   * prévia da borda confere conflito na agenda do RESPONSÁVEL, que pode estar
   * fora do filtro (#4450). Ausente = `agendamentos`.
   */
  ocupacao?: Agendamento[];
  className?: string;
}) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const ehQuadro = visao === "quadro";
  // As linhas do quadro obedecem ao MESMO filtro de pessoas que a grade: com a
  // Ana isolada, o quadro tem uma linha só — a dela.
  const linhasDoQuadro = React.useMemo(
    () => (donoId ? pessoas.filter((p) => p.id === donoId) : pessoas),
    [pessoas, donoId],
  );
  const livresDoQuadro = useHorariosLivresPorPessoa(
    ehQuadro && tipo ? tipo.id : null,
    ehQuadro ? linhasDoQuadro.map((p) => p.id) : [],
    recorte,
  );
  const { data: horarios, isError: horariosFalharam } = useHorariosLivres(
    // No quadro cada linha pergunta por si (acima); a consulta única da grade
    // seria um pedido a mais, de uma pessoa só, que ninguém desenharia.
    tipo && !ehQuadro
      ? {
          event_type_id: tipo.id,
          owner_user_id: donoId ?? undefined,
          de: recorte.de,
          ate: recorte.ate,
        }
      : null,
  );

  const horariosPorDia = React.useMemo(() => {
    const mapa: Record<string, Array<{ instante: string; rotulo: string }>> = {};
    for (const s of horarios?.slots ?? []) {
      const d = new Date(s.inicio);
      // Chave E rótulo no fuso da ORGANIZAÇÃO: a grade da ao lado já desenha
      // nessa régua, e um `format(d, ...)` aqui anuncia "às 09:00" para um
      // bloco que pinta às 10:00 (issue #1362).
      (mapa[diaLocalISO(d, fuso)] ??= []).push({
        instante: s.inicio,
        rotulo: format(dataDeParede(d, fuso), "HH:mm"),
      });
    }
    return mapa;
  }, [horarios, fuso]);

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
  const estadosDoQuadro = Object.values(livresDoQuadro);
  const motivo: MotivoDaGradeTravada | null = ehQuadro
    ? !tipo || estadosDoQuadro.length === 0
      ? null
      : estadosDoQuadro.some((e) => e.falhou)
        ? "erro"
        : estadosDoQuadro.every((e) => e.slots !== null && !e.publicou)
          ? "sem-jornada"
          : estadosDoQuadro.every((e) => e.slots !== null && e.slots.length === 0)
            ? "sem-vaga"
            : null
    : horariosFalharam
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
  //
  // UM POR COMPROMISSO (#4450): confirmar a duração de B enquanto o PATCH de A
  // ainda está no ar não pode devolver A ao tamanho antigo.
  const [otimistas, setOtimistas] = React.useState<Record<string, Otimismo>>({});
  const poeOtimismo = React.useCallback((o: Otimismo) => {
    setOtimistas((m) => ({ ...m, [o.id]: o }));
  }, []);
  /** Tira o otimismo de `id` — só o do `pedido`, quando dito (a falha de um PATCH antigo não apaga o novo). */
  const tiraOtimismo = React.useCallback((id: string, pedido?: number) => {
    setOtimistas((m) => {
      const o = m[id];
      if (!o || (pedido !== undefined && o.pedido !== pedido)) return m;
      const resto = { ...m };
      delete resto[id];
      return resto;
    });
  }, []);

  /**
   * O otimismo termina quando o dado REAL o alcança — não no `onSuccess`.
   *
   * Limpar na resposta do PATCH devolveria o card ao horário antigo por um
   * quadro, até o `useAgendamentos` refazer a busca que a invalidação disparou.
   * Um piscar para trás depois de "remarcado" é indistinguível de falha.
   */
  React.useEffect(() => {
    const ids = Object.keys(otimistas);
    if (ids.length === 0) return;
    // A lista SEM filtro, quando há: o compromisso escondido pelo filtro de
    // profissional também recebe a versão nova, e o otimismo dele tem de ceder.
    const lista = ocupacao ?? agendamentos;
    const vencidos = ids.filter((id) => {
      const o = otimistas[id]!;
      const real = lista.find((a) => a.id === id);
      // O FIM entra na conta desde a borda (#4450): mudar só a duração mantém o
      // início, e conferir só o início soltaria o otimismo no mesmo quadro.
      //
      // E termina também quando a lista traz uma revisão MAIS NOVA que a do nosso
      // pedido, mesmo com outro horário: alguém gravou depois de nós, e seguir
      // desenhando o nosso fim por cima do dele seria mentir sobre a agenda.
      return (
        real !== undefined &&
        ((new Date(real.comeca).getTime() === new Date(o.comeca).getTime() &&
          new Date(real.termina).getTime() === new Date(o.termina).getTime()) ||
          (o.revisao !== undefined && real.revision !== undefined && real.revision > o.revisao))
      );
    });
    if (vencidos.length === 0) return;
    setOtimistas((m) => {
      const resto = { ...m };
      for (const id of vencidos) delete resto[id];
      return resto;
    });
  }, [agendamentos, ocupacao, otimistas]);

  const comOtimismo = React.useCallback(
    (lista: Agendamento[]) =>
      Object.keys(otimistas).length === 0
        ? lista
        : lista.map((a) => {
            const o = otimistas[a.id];
            return o ? { ...a, comeca: o.comeca, termina: o.termina } : a;
          }),
    [otimistas],
  );
  const desenhados = React.useMemo(() => comOtimismo(agendamentos), [comOtimismo, agendamentos]);
  // A ocupação vê o mesmo otimismo que o desenho: um fim recém-confirmado já
  // ocupa, antes de a lista recarregada chegar.
  const ocupacaoDesenhada = React.useMemo(
    () => (ocupacao ? comOtimismo(ocupacao) : desenhados),
    [ocupacao, comOtimismo, desenhados],
  );

  const confirmar = React.useCallback(() => {
    if (!pendente) return;
    const alvo = agendamentos.find((a) => a.id === pendente.id);
    if (!alvo) return;
    const duracao = Math.max(differenceInMinutes(new Date(alvo.termina), new Date(alvo.comeca)), 15);
    const comeca = new Date(pendente.instante);
    const antes = { comeca: alvo.comeca, termina: alvo.termina };
    poeOtimismo({
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
      tiraOtimismo(alvo.id);
      setRecusa(
        t("A remarcação não foi aceita — o compromisso voltou para {data}.").replace(
          "{data}",
          format(dataDeParede(new Date(antes.comeca), fuso), t("EEEE, d 'de' MMMM 'às' HH:mm"), {
            locale: localeDaData,
          }),
        ),
      );
    });
  }, [agendamentos, pendente, remarcar, localeDaData, t, fuso, poeOtimismo, tiraOtimismo]);

  const nomeDoPendente = pendente
    ? (agendamentos.find((a) => a.id === pendente.id)?.titulo ?? t("o compromisso"))
    : "";

  // ─── MUDAR A DURAÇÃO pela borda (#4450): proposta → confirmação → PATCH ──
  //
  // O MESMO ritmo do remarcar (a pergunta antes da escrita, o card no lugar
  // antigo enquanto ela está aberta, o otimismo que sabe voltar) e o MESMO
  // PATCH — mas só com `duration_minutes` e a `revision` do card. Sem
  // `starts_at` a rota não trata como remarcação: não há aviso de remarcação
  // nem notícia na timeline. O que PODE sair é a atualização do Google para os
  // convidados, quando a agenda está ligada — e a pergunta diz isso.
  /**
   * A proposta guarda o compromisso COMO ELE ERA quando a borda foi solta —
   * revisão, início e fim. Confirmar compara com a lista de agora: se ela mudou
   * (alguém gravou e a grade recarregou), a pergunta perdeu o objeto e NÃO vai
   * para o servidor com a revisão nova, que passaria por cima do que o colega
   * gravou.
   */
  const [pendenteDuracao, setPendenteDuracao] = React.useState<{
    id: string;
    duracaoMin: number;
    revision?: number;
    comeca: string;
    termina: string;
    titulo: string;
  } | null>(null);
  /**
   * Outra pessoa mudou o compromisso antes do nosso PATCH: o id e a versão que
   * NÓS tínhamos. O horário "de agora" só é dito quando a lista já trouxe outra
   * versão — antes disso, a lista ainda é a nossa, e dizê-la seria repetir o
   * horário velho como se fosse o novo.
   */
  const [alteradoPorOutro, setAlteradoPorOutro] = React.useState<{
    id: string;
    revision?: number;
    comeca: string;
    termina: string;
  } | null>(null);
  /** Por que a duração não mudou — separado de `recusa`, que é da remarcação. */
  const [recusaDaDuracao, setRecusaDaDuracao] = React.useState<string | null>(null);
  const pedidos = React.useRef(0);

  /** O mesmo relógio da grade: `agora` + o tempo corrido desde que ele chegou. */
  const baseDoRelogio = React.useRef<{ agora: number; em: number | null }>({
    agora: agora.getTime(),
    em: null,
  });
  React.useEffect(() => {
    baseDoRelogio.current = { agora: agora.getTime(), em: Date.now() };
  }, [agora]);

  const recusaDe = React.useCallback(
    (titulo: string, motivo: string) =>
      t("A duração de {nome} não foi alterada — {motivo}.")
        .replace("{nome}", titulo)
        .replace("{motivo}", motivo),
    [t],
  );

  const horaDe = React.useCallback(
    (iso: string) => format(dataDeParede(new Date(iso), fuso), "HH:mm"),
    [fuso],
  );

  const confirmarDuracao = React.useCallback(() => {
    if (!pendenteDuracao) return;
    const pedido = pendenteDuracao;
    setPendenteDuracao(null);
    // `desenhados`: a versão que a grade mostrou — com o otimismo de um pedido
    // anterior ainda no ar, é dela que a borda partiu.
    const alvo = desenhados.find((a) => a.id === pedido.id);
    if (
      !alvo ||
      alvo.revision !== pedido.revision ||
      alvo.comeca !== pedido.comeca ||
      alvo.termina !== pedido.termina
    ) {
      setRecusaDaDuracao(null);
      setAlteradoPorOutro({ id: pedido.id, revision: pedido.revision, comeca: pedido.comeca, termina: pedido.termina });
      return;
    }
    const fimNovo = new Date(new Date(pedido.comeca).getTime() + pedido.duracaoMin * 60_000);
    // "Depois de agora" vale na hora de CONFIRMAR, não só na de soltar: a
    // pergunta pode ficar aberta enquanto o relógio passa do fim escolhido.
    const b = baseDoRelogio.current;
    const agoraAgora = b.agora + (b.em === null ? 0 : Date.now() - b.em);
    if (fimNovo.getTime() <= agoraAgora) {
      setRecusaDaDuracao(recusaDe(pedido.titulo, t("este horário já passou")));
      return;
    }
    pedidos.current += 1;
    const numero = pedidos.current;
    poeOtimismo({
      id: pedido.id,
      comeca: pedido.comeca,
      termina: fimNovo.toISOString(),
      antes: { comeca: pedido.comeca, termina: pedido.termina },
      pedido: numero,
      revisao: pedido.revision,
    });
    void remarcar
      .mutateAsync({
        id: pedido.id,
        // A revisão de QUANDO a borda foi solta: se alguém mudou o compromisso
        // depois, a rota responde 409 em vez de sobrescrever o que ele gravou.
        ...(pedido.revision !== undefined ? { revision: pedido.revision } : {}),
        duration_minutes: pedido.duracaoMin,
      })
      .catch((err: unknown) => {
        tiraOtimismo(pedido.id, numero);
        // Só o 409 de REVISÃO (`conflict`) é "alguém mudou antes". Outros 409 —
        // `agenda_autoridade_externa`, por exemplo — têm motivo próprio, e ele
        // vai para a tela como veio.
        if (err instanceof ApiError && err.status === 409 && err.code === "conflict") {
          setRecusaDaDuracao(null);
          setAlteradoPorOutro({ id: pedido.id, revision: pedido.revision, comeca: pedido.comeca, termina: pedido.termina });
          return;
        }
        const motivo =
          err instanceof ApiError && !err.semEnvelope && err.message
            ? err.message.replace(/[.\s]+$/, "")
            : t("não consegui salvar agora");
        // Com o NOME: com dois pedidos no ar, a frase tem de dizer de qual é.
        setRecusaDaDuracao(recusaDe(pedido.titulo, motivo));
      });
  }, [desenhados, pendenteDuracao, remarcar, t, poeOtimismo, tiraOtimismo, recusaDe]);

  // Esc fecha a pergunta da duração sem gravar, como o botão Cancelar.
  React.useEffect(() => {
    if (!pendenteDuracao) return;
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPendenteDuracao(null);
    };
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, [pendenteDuracao]);

  const pendenteDuracaoAlvo = pendenteDuracao
    ? agendamentos.find((a) => a.id === pendenteDuracao.id)
    : undefined;
  // Na lista SEM filtro: o colega pode ter passado o compromisso para outra
  // pessoa, e ele sair do filtro não quer dizer que deixou de existir.
  const atualDoAlterado = alteradoPorOutro
    ? (ocupacao ?? agendamentos).find((a) => a.id === alteradoPorOutro.id)
    : undefined;
  /** Hora — e a data junto, quando o colega mudou o compromisso de DIA. */
  const quandoDoAlterado = (iso: string) =>
    alteradoPorOutro && diaLocalISO(new Date(iso), fuso) !== diaLocalISO(new Date(alteradoPorOutro.comeca), fuso)
      ? format(dataDeParede(new Date(iso), fuso), "dd/MM HH:mm")
      : horaDe(iso);
  // A lista já mostra OUTRA versão? Só então ela é "o horário de agora".
  const alteradoAgora =
    alteradoPorOutro &&
    atualDoAlterado &&
    (atualDoAlterado.revision !== alteradoPorOutro.revision ||
      atualDoAlterado.comeca !== alteradoPorOutro.comeca ||
      atualDoAlterado.termina !== alteradoPorOutro.termina)
      ? atualDoAlterado
      : undefined;

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
          className="rounded-sm border border-border bg-surface-elevated px-3 py-2 text-xs leading-4 text-text-muted"
        >
          {motivo === "sem-jornada" ? (
            <>
              <span className="font-semibold text-text">
                {/* Sem "Você": esta grade é a de quem a agenda mostra, que não é
                    necessariamente quem está logado (o atendente abre a agenda
                    da dona). Quem é, o cabeçalho acima já nomeia. */}
                {t("A jornada de atendimento ainda não foi publicada.")}
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
              {format(dataDeParede(new Date(pendente.instante), fuso), t("EEEE, d 'de' MMMM 'às' HH:mm"), {
                locale: localeDaData,
              })}
            </span>
            {t("? Quem foi atendido recebe o aviso da mudança.")}
          </p>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPendente(null)}>
              {t("Cancelar")}
            </Button>
            <Button size="sm" data-testid="confirmar-remarcacao-botao" onClick={confirmar}>
              {t("Remarcar")}
            </Button>
          </div>
        </div>
      )}

      {pendenteDuracao && pendenteDuracaoAlvo && (
        <div
          data-testid="confirmar-duracao"
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-accent/50 bg-accent-soft px-3 py-2"
        >
          <p className="text-xs leading-4 text-text">
            {t("Mudar a duração de")} <span className="font-semibold">{pendenteDuracaoAlvo.titulo}</span>{" "}
            {t("para")}{" "}
            <span className="font-semibold tabular-nums">
              {horaDe(pendenteDuracao.comeca)}–
              {horaDe(
                new Date(
                  new Date(pendenteDuracao.comeca).getTime() + pendenteDuracao.duracaoMin * 60_000,
                ).toISOString(),
              )}{" "}
              ({pendenteDuracao.duracaoMin} min)
            </span>
            ?{" "}
            <span className="text-text-muted">
              {t(
                "Se a agenda estiver ligada ao Google Agenda, quem foi convidado pode receber um e-mail de atualização do Google.",
              )}
            </span>
          </p>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="ghost"
              size="sm"
              data-testid="cancelar-duracao"
              onClick={() => setPendenteDuracao(null)}
            >
              {t("Cancelar")}
            </Button>
            <Button size="sm" data-testid="confirmar-duracao-botao" onClick={confirmarDuracao}>
              {t("Alterar duração")}
            </Button>
          </div>
        </div>
      )}

      {/* A RECUSA DA BORDA — sempre em texto, acima da grade: na semana a coluna
          é estreita demais para o fantasma vermelho caber com a frase inteira, e
          o toast some. O que não mudou tem de ficar escrito. */}
      {(alteradoPorOutro || recusaDaDuracao) && (
        <div
          data-testid="duracao-recusada"
          role="status"
          className="flex items-center justify-between gap-2 rounded-sm border border-warning/40 bg-warning-bg px-3 py-2"
        >
          <p className="text-xs leading-4 text-text">
            {alteradoPorOutro
              ? alteradoAgora
                ? t(
                    "Este compromisso foi alterado por outra pessoa enquanto você ajustava — agora vai de {inicio} a {fim}. Ajuste de novo se ainda precisar.",
                  )
                    .replace("{inicio}", quandoDoAlterado(alteradoAgora.comeca))
                    .replace("{fim}", quandoDoAlterado(alteradoAgora.termina))
                : t("Este compromisso foi alterado por outra pessoa enquanto você ajustava. Confira o horário atual dele antes de ajustar de novo.")
              : recusaDaDuracao}
          </p>
          <button
            type="button"
            onClick={() => {
              setRecusaDaDuracao(null);
              setAlteradoPorOutro(null);
            }}
            className="shrink-0 text-xs font-medium text-text-muted underline underline-offset-2 hover:text-text"
          >
            {t("Entendi")}
          </button>
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
            {t("Entendi")}
          </button>
        </div>
      )}

      {ehQuadro ? (
        <QuadroPorProfissional
          dia={ancora}
          fuso={fuso}
          pessoas={linhasDoQuadro}
          agendamentos={agendamentos}
          fechamentos={fechamentos}
          livres={Object.fromEntries(
            linhasDoQuadro.map((p) => [
              p.id,
              livresDoQuadro[p.id]?.slots?.map((s) => ({
                instante: s.inicio,
                rotulo: format(dataDeParede(new Date(s.inicio), fuso), "HH:mm"),
              })),
            ]),
          )}
          primeiraHora={JANELA_DA_GRADE.primeira}
          ultimaHora={JANELA_DA_GRADE.ultima}
          onMarcarEm={tipo ? onMarcarComProfissional : undefined}
          onAbrirAgendamento={onAbrirAgendamento}
        />
      ) : (
      <GradeDaAgenda
        visao={visao}
        ancora={ancora}
        agora={agora}
        fuso={fuso}
        pessoas={pessoas}
        agendamentos={desenhados}
        fechamentos={fechamentos}
        onAbrirAgendamento={onAbrirAgendamento}
        className="min-h-0 flex-1"
        interacao={
          tipo && onMarcarEm
            ? {
                horariosPorDia,
                motivo,
                duracaoMin: tipo.duracaoMin,
                ocupacao: ocupacaoDesenhada,
                onMarcarEm,
                onMudarDuracao: ({ id, duracaoMin, razao, base }) => {
                  setPendente(null);
                  setRecusa(null);
                  setAlteradoPorOutro(null);
                  setPendenteDuracao(null);
                  const alvo = desenhados.find((a) => a.id === id);
                  const titulo = alvo?.titulo ?? t("o compromisso");
                  // A prévia partiu de uma versão que a lista já não tem (um
                  // colega gravou enquanto ela estava aberta): não há o que
                  // perguntar — a duração foi pensada para outro compromisso.
                  if (
                    !alvo ||
                    alvo.revision !== base.revision ||
                    alvo.comeca !== base.comeca ||
                    alvo.termina !== base.termina
                  ) {
                    setRecusaDaDuracao(null);
                    setAlteradoPorOutro({ id, ...base });
                    return;
                  }
                  if (duracaoMin === null) {
                    // RECUSA EXPLÍCITA, sem tocar no servidor — a mesma régua do
                    // arraste: o fim proposto já passou ou cruza outro compromisso.
                    setRecusaDaDuracao(recusaDe(titulo, t(razao)));
                    return;
                  }
                  setRecusaDaDuracao(null);
                  setPendenteDuracao({ id, duracaoMin, ...base, titulo });
                },
                onArrastarPara: ({ instante, razao, id }) => {
                  setPendenteDuracao(null);
                  setRecusaDaDuracao(null);
                  setAlteradoPorOutro(null);
                  if (!instante) {
                    // RECUSA EXPLÍCITA, sem tocar no servidor: o destino não
                    // está na disponibilidade publicada. Remarcar assim mesmo
                    // criaria um compromisso que o motor não teria oferecido.
                    setPendente(null);
                    setRecusa(t("Não dá para remarcar para esse horário — {motivo}.").replace("{motivo}", t(razao)));
                    return;
                  }
                  setRecusa(null);
                  setPendente({ id, instante });
                },
              }
            : undefined
        }
      />
      )}
    </div>
  );
}
