"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import { useT } from "@/hooks/i18n/useT";

import { addDays, format, isSameDay, isSameMonth, startOfDay, startOfMonth, startOfWeek } from "date-fns";
import Link from "next/link";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { instanteDe } from "@/lib/agenda/fuso";
import { ApiError } from "@/lib/api/types";
import { CaretLeft, CaretRight, CheckCircle, Clock, MapPin, Warning } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { AvatarDaPessoa } from "./AvatarDaPessoa";
import type { HorarioLivre, Pessoa } from "./tipos";

/**
 * O painel de marcar — os três tempos.
 *
 * A máquina é a mesma do Booker do cal.com (`selecting_date` → `selecting_time`
 * → `booking`), e o motivo de copiá-la é medido, não estético: escolher dia e
 * escolher horário são decisões de granularidade diferente, e mostrar as duas
 * juntas de saída faz o olho ter de escolher onde começar. O que NÃO se copia é
 * o pixel — a tela é deste produto.
 *
 * O truque que dá a sensação de fluidez está no CSS (`.agenda-coluna-horarios`
 * no globals.css): a coluna de horários tem largura zero até haver um dia
 * escolhido, e então entra pela direita enquanto o painel cresce.
 */
export type TempoDaMarcacao = "escolhendo-dia" | "escolhendo-horario" | "confirmando" | "marcado";

/**
 * O bloco de "não há jornada publicada" — na pessoa certa.
 *
 * A frase antiga ("Você ainda não publicou seus horários de atendimento") era
 * dita a QUALQUER leitor, e mente quando quem lê não é o dono da jornada: o
 * Atendente abre a agenda da dona, e "Você" ali é o Atendente (issue #896,
 * item 1). O rótulo "Você" vem de `lib/agenda/responsavel-do-painel.ts` — a
 * fonte única —, e a frase volta à segunda pessoa exatamente quando ele
 * aparece: é o caso do dono abrindo a própria agenda, e é o que o kit visual
 * (`tests/e2e/agenda-kit-visual.spec.ts`) assere.
 *
 * Quando quem lê NÃO é o dono, a tela não deve deduzir quem falhou em
 * publicar: ela constata que A JORNADA (de quem a agenda é) não foi publicada,
 * sem apontar o dedo para quem está logado.
 */
function AvisoDeJornadaNaoPublicada({ quemLeEhODono }: { quemLeEhODono: boolean }) {
  const t = useT();

  return (
    <>
      <p className="text-sm font-semibold text-text">
        {quemLeEhODono
          ? t("Você ainda não publicou seus horários de atendimento")
          : t("A jornada de atendimento ainda não foi publicada")}
      </p>
      <p className="mt-1 text-xs leading-4 text-text-muted">
        {quemLeEhODono
          ? t("Sem eles ninguém consegue marcar — nem você, nem o agente.")
          : t("Sem eles ninguém consegue marcar — nem quem atende, nem o agente.")}
      </p>
    </>
  );
}

export function PainelDeMarcacao({
  ancora,
  agora,
  responsavel,
  tipo = "Consulta",
  duracaoMin = 30,
  local,
  fuso,
  horariosPorDia,
  publicouHorarios = true,
  erroAoCarregar = false,
  fusoSuposto = false,
  fontesDefasadas,
  googleCoberturaParcial,
  onMesVisivel,
  quemSeraAtendido,
  horarioInicial,
  permiteEncaixe = false,
  onConfirmar,
  onVerNaAgenda,
  className,
}: {
  ancora: Date;
  agora: Date;
  responsavel: Pessoa;
  tipo?: string;
  duracaoMin?: number;
  /**
   * ⚠️ SEM DEFAULT, e isto é o conserto.
   *
   * Era `local = "Presencial · Sala 2"` e `fuso = "America/Sao_Paulo"`, defaults
   * de PARÂMETRO — e `app/app/agenda/_client.tsx` não passava nenhum dos dois.
   * Os defaults venciam em 100% das marcações do produto: toda clínica, de toda
   * instalação, via "Sala 2" numa tela real.
   *
   * O cabeçalho de `_client.tsx` proíbe exatamente isso, com a razão escrita:
   * dado falso PLAUSÍVEL numa tela de produto multi-tenant é indistinguível de
   * VAZAMENTO, e o relato que chega não é "tem dado de teste na tela", é "estou
   * vendo paciente de outra clínica". Sobreviveu porque veio por default de
   * parâmetro em vez de import de `dados-de-mentira.ts`, que é o que a varredura
   * `tests/unit/telas-sem-dado-de-mentira.test.ts` vigia.
   *
   * Sem valor, a linha não é renderizada. O próximo caller que esquecer mostra
   * uma linha a menos — não uma sala inventada.
   */
  local?: string;
  /**
   * ⚠️ SEM DEFAULT, pela mesma razão do `local` acima — e aqui o custo é maior:
   * "America/Sao_Paulo" chutado para quem atende em Manaus não é só feio, é uma
   * hora de diferença no horário oferecido ao cliente. A rota JÁ devolve
   * `fuso_da_regra` e o hook JÁ o tipa; ninguém em tela o lia. A IA sabia o fuso
   * certo (`lib/mcp/tools/agendamento.ts`) e o operador não.
   */
  fuso?: string;
  /** `yyyy-MM-dd` → horários livres. Dia ausente = sem horário, nasce apagado. */
  horariosPorDia: Record<string, HorarioLivre[]>;
  /**
   * `false` = a pessoa NUNCA publicou jornada. Não é o mesmo que "não há vaga",
   * e a rota devolve os dois separados de propósito: sem a distinção a tela
   * diria "nenhum horário disponível" para quem não configurou nada — uma
   * resposta verdadeira e inútil, que manda procurar vaga onde não há agenda.
   * Decisão 1.1 da entrega.
   */
  publicouHorarios?: boolean;
  /**
   * A consulta de horários FALHOU. Sem este fio a tela mente por default: o
   * `publicouHorarios` do chamador é `horarios?.publicou_horarios ?? true`, e
   * com a resposta ausente (erro) o `?? true` diz "publicou" — dias travados,
   * aviso nenhum. É o estado exato de uma instalação fresca, onde a rota devolve
   * 422 porque ninguém está em `attendant_availability`.
   */
  erroAoCarregar?: boolean;
  /** O fuso veio do padrão, ninguém escolheu — e o agente oferece horário com ele. */
  fusoSuposto?: boolean;
  /** Agenda conectada que parou de atualizar: o horário fica bloqueado, e a tela diz desde quando. */
  /** Ocupação do Google ainda não lida para o recorte pedido — aviso, não trava. */
  googleCoberturaParcial?: boolean;
  /**
   * O mês que o calendário está mostrando. Quem consulta os horários livres
   * precisa disto: a busca acompanha o mês visível, senão "Próximo mês" ou
   * entrega 42 dias mortos ou desliga para não produzir esse estado.
   */
  onMesVisivel?: (mes: Date) => void;
  /** Agenda conectada que parou de atualizar: o horário fica bloqueado, e a tela diz desde quando. */
  fontesDefasadas?: Array<{ nome?: string; desde?: string }>;
  /**
   * Quem vai ser atendido, e se ele aceita receber mensagem.
   *
   * `aceitaMensagem: false` NÃO impede marcar — opt-out é vontade sobre o
   * canal, e marcar consulta não é consentir em receber mensagem (decisão 10 da
   * entrega). O que ele impede é o LEMBRETE, e é justamente por isso que a tela
   * tem de dizer isso aqui, antes de confirmar: o produto não mandar é uma
   * decisão; o produto não avisar que não ia mandar é um bug.
   */
  quemSeraAtendido?: { nome: string; aceitaMensagem: boolean };
  /**
   * Levar a grade até o compromisso recém-marcado.
   *
   * Recebe o INSTANTE, e não só um pedido de fechar: quem marca para 8 de
   * setembro e volta para a grade na semana corrente não vê nada — e "não
   * acontece nada" passa a ser literalmente verdade na tela. Quem sabe mover a
   * âncora é o `_client`, que é dono dela; este painel só sabe QUANDO é.
   */
  onVerNaAgenda?: (instante: string) => void;

  /**
   * O horário JÁ ESCOLHIDO — quem abriu o painel clicando num bloco da grade
   * não deve ser obrigado a escolher de novo o que acabou de apontar.
   *
   * Ele salta os dois primeiros tempos da máquina (`escolhendo-dia` e
   * `escolhendo-horario`) e abre direto em `confirmando`, com o mini-calendário
   * no mês certo e o dia marcado — voltar continua possível pelo botão
   * "Voltar", que é o que devolve a escolha a quem se enganou no bloco.
   *
   * O instante vem da MESMA rota que alimenta a coluna de horários, então não
   * há como o painel abrir confirmando um horário que ele próprio não
   * ofereceria.
   */
  horarioInicial?: HorarioLivre;
  /**
   * O ENCAIXE — "Outro horário", digitado, fora da grade publicada.
   *
   * O servidor aceita horário fora da grade quando quem marca é uma PESSOA da
   * equipe (`podeMarcarForaDaGrade`, `app/api/v1/agenda/agendamentos/_handler.ts`)
   * e recusa só a ocupação real. Sem esta porta a regra existia e ninguém a
   * alcançava pela tela: a QA do lote 8 só conseguiu marcar 10:30 chamando a API.
   *
   * Prop EXPLÍCITA e desligada por padrão, porque quem sabe se o encaixe cabe é
   * quem monta o painel: a vitrine desenha este componente com dado de mentira,
   * e quem não pode marcar (`viewer`) levaria 403 da rota. A tela esconder não é
   * autorização — a rota cobra de novo —, é não oferecer um caminho que não existe.
   *
   * Mesmo ligada, ela só aparece quando o servidor aceitaria e a tela sabe o que
   * "10:30" significa: com jornada publicada (sem ela a rota devolve
   * `agenda_fora_da_jornada`), sem erro na consulta e com `fuso` conhecido.
   */
  permiteEncaixe?: boolean;
  onConfirmar?: (instante: string) => void | Promise<unknown>;
  className?: string;
}) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  // `horarioInicial` vem do PR #382 (a grade interativa): quem clica num
  // horário na grade chega aqui com ele já escolhido. Os dois lados somam —
  // os hooks são apresentação, o estado inicial é comportamento.
  const [dia, setDia] = React.useState<Date | null>(
    horarioInicial ? new Date(horarioInicial.instante) : null,
  );
  const [horario, setHorario] = React.useState<HorarioLivre | null>(horarioInicial ?? null);
  const [marcado, setMarcado] = React.useState<HorarioLivre | null>(null);
  const [mes, setMes] = React.useState(() =>
    startOfMonth(horarioInicial ? new Date(horarioInicial.instante) : ancora),
  );
  React.useEffect(() => {
    onMesVisivel?.(mes);
  }, [mes, onMesVisivel]);
  const [encaixeAberto, setEncaixeAberto] = React.useState(false);
  // O que a pessoa DIGITOU sobrevive a "Voltar", à troca de dia e à recusa do
  // servidor: quem ouviu "ocupado" quer corrigir dez minutos, não redigitar.
  const [horaDoEncaixe, setHoraDoEncaixe] = React.useState("");
  /**
   * A recusa do servidor PRESA ao horário recusado. Escolher outro horário a tira
   * da tela sem ninguém lembrar de limpar — e voltar ao recusado a traz de volta,
   * que é verdade: nada mudou nele.
   */
  const [recusa, setRecusa] = React.useState<{ instante: string; mensagem: string } | null>(null);

  /**
   * A confirmação nasce ONDE a pessoa possa vê-la.
   *
   * Ela aparece embaixo do mês, e quem a provoca clica em outro lugar: na coluna
   * de horários, ou no "Usar" do encaixe. Com o corpo rolando (telas baixas) ou
   * com o diálogo empilhado (celular), o bloco surgia abaixo da dobra e o clique
   * parecia não ter feito nada — o "nada acontece" que esta tela já pagou.
   * `nearest` só rola o necessário, e não rola nada quando já está à vista. A
   * recusa entra na lista porque aumenta o bloco e pode empurrar o botão para fora.
   */
  const confirmacaoRef = React.useRef<HTMLDivElement>(null);
  const instanteEscolhido = horario?.instante;
  const mensagemDaRecusa = recusa?.mensagem;
  React.useEffect(() => {
    if (!instanteEscolhido) return;
    confirmacaoRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [instanteEscolhido, mensagemDaRecusa]);

  /**
   * O painel pode continuar montado entre duas aberturas (o `Sheet` decide
   * isso, não nós), e aí o estado inicial acima não roda de novo — clicar num
   * segundo bloco abriria o painel no horário do primeiro.
   *
   * A dependência é o INSTANTE e não o objeto: `horarioInicial` é literal do
   * chamador, novo a cada render dele, e um efeito com o objeto na lista
   * dispararia para sempre.
   */
  const instanteInicial = horarioInicial?.instante;
  React.useEffect(() => {
    if (!instanteInicial) return;
    const d = new Date(instanteInicial);
    setDia(d);
    setHorario({ instante: instanteInicial, rotulo: format(d, "HH:mm") });
    setMes(startOfMonth(d));
    setMarcado(null);
  }, [instanteInicial]);

  const tempo: TempoDaMarcacao = marcado
    ? "marcado"
    : horario
      ? "confirmando"
      : dia
        ? "escolhendo-horario"
        : "escolhendo-dia";

  const semanas = React.useMemo(() => {
    const primeiro = startOfWeek(startOfMonth(mes), { weekStartsOn: 0 });
    return Array.from({ length: 6 }, (_, s) =>
      Array.from({ length: 7 }, (_, d) => addDays(primeiro, s * 7 + d)),
    );
  }, [mes]);

  /**
   * POR QUE A GRADE ESTÁ TRAVADA — um motivo só, derivado da MESMA conta que
   * apaga os dias.
   *
   * O que o usuário via: o calendário do mês inteiro, todos os dias sem clique,
   * e nada explicando. O aviso existia, mas dependia de OUTRO dado: o dia é
   * desabilitado por `livres.length > 0 && isSameMonth(...)` (os slots daquela
   * data), e o aviso por `publicouHorarios` (as janelas lidas do banco). Dois
   * booleanos independentes — então havia estado em que trava sem avisar nada:
   *
   *   - instalação fresca: ninguém em `attendant_availability` ⇒ a rota devolve
   *     422 ⇒ o hook joga o erro num toast e `data` fica `undefined` ⇒ o
   *     `?? true` do chamador diz "publicou" ⇒ 42 dias mortos, zero aviso.
   *
   * `nenhumDiaClicavel` é LITERALMENTE a expressão do `disponivel` de cada dia,
   * negada e universal. Por construção os dois não voltam a divergir.
   */
  const encaixeLigado = permiteEncaixe && Boolean(fuso) && publicouHorarios && !erroAoCarregar;
  const inicioDeHoje = startOfDay(agora).getTime();

  /**
   * O dia aceita clique? Com horário publicado, sempre; sem, só pelo encaixe — e
   * só de hoje em diante, que é o que o calendário já oferecia.
   *
   * É a ÚNICA expressão de clicável: o botão do dia e `nenhumDiaClicavel` leem
   * esta função, para os dois não voltarem a divergir (ver o bloco acima).
   */
  const diaClicavel = (d: Date): boolean =>
    isSameMonth(d, mes) &&
    ((horariosPorDia[format(d, "yyyy-MM-dd")]?.length ?? 0) > 0 ||
      (encaixeLigado && d.getTime() >= inicioDeHoje));

  const nenhumDiaClicavel = semanas.flat().every((d) => !diaClicavel(d));

  const motivoDoBloqueio: "sem-jornada" | "erro" | "sem-vaga" | null = !publicouHorarios
    ? "sem-jornada"
    : erroAoCarregar
      ? "erro"
      : nenhumDiaClicavel
        ? "sem-vaga"
        : null;

  /** O mesmo motivo, na voz de quem olha UM dia apagado. */
  const razaoDoDia = (noMes: boolean): string =>
    !noMes
      ? t("fora deste mês")
      : motivoDoBloqueio === "sem-jornada"
        ? t("você ainda não publicou seus horários")
        : motivoDoBloqueio === "erro"
          ? t("não consegui carregar os horários")
          : t("nenhum horário livre neste dia");

  const doDia = dia ? (horariosPorDia[format(dia, "yyyy-MM-dd")] ?? []) : [];

  const partesDaHora = /^([01]\d|2[0-3]):([0-5]\d)(?::\d{2})?$/.exec(horaDoEncaixe);

  /**
   * "10:30" do dia escolhido, no fuso que o painel EXIBE ("Horários no fuso …"),
   * vira instante pela mesma conversão do motor (`lib/agenda/fuso.ts`).
   *
   * ⚠️ NUNCA `new Date(ano, mes, dia, hora)`: isso é o fuso do NAVEGADOR. Para
   * quem atende em São Paulo e abre a agenda com o computador em outro fuso, o
   * compromisso nasceria horas fora do que a pessoa combinou com o cliente.
   */
  const usarHoraDoEncaixe = () => {
    if (!dia || !fuso || !partesDaHora) return;
    const instante = instanteDe(
      {
        ano: dia.getFullYear(),
        mes: dia.getMonth() + 1,
        dia: dia.getDate(),
        hora: Number(partesDaHora[1]),
        minuto: Number(partesDaHora[2]),
      },
      fuso,
    ).toISOString();
    setHorario({ instante, rotulo: `${partesDaHora[1]}:${partesDaHora[2]}` });
  };

  /**
   * O encaixe mora na coluna de horários. Com horários no dia ele vem DEPOIS da
   * lista, recolhido; sem nenhum, vem ANTES dela — senão a lista vazia, que
   * estica para ocupar a coluna, empurrava o campo para o pé da coluna, embaixo
   * de um vão em branco (medido na tela, 1440×900).
   */
  const blocoDoEncaixe =
    encaixeLigado && dia ? (
      <div data-testid="encaixe" className={cn("shrink-0", doDia.length > 0 && "mt-2")}>
        {doDia.length === 0 && (
          /*
            DOIS casos diferentes, e a tela dizia um só.

            `publicouHorarios === false` é "esta pessoa NUNCA publicou jornada":
            nenhum dia abre, e o que falta é configurar os horários. Com jornada
            publicada, um dia sem janela é FOLGA (ou dia sem expediente) — a
            pessoa tem jornada, este dia é que não abre. Dizer "nenhum horário
            publicado neste dia" nos dois casos lê-se como "a pessoa não tem
            jornada", que é falso no segundo.
          */
          <p className="mb-2 text-xs text-text-muted">
            {/*
              LITERAL, e não `t(mensagemDoDiaSemJanela(publicouHorarios))`: o
              guarda de espanhol (`tests/unit/i18n-espanhol-cobre-a-tela.test.ts`)
              varre `t("literal")`, então `t(variável)` ESCAPA da cobrança — a
              frase ficaria sem tradução com o guarda verde sobre a ausência
              (achado da triagem do #1107, item 5). Aqui só a folga alcança (a
              porta do encaixe exige jornada publicada) e o texto do outro caso
              tem bloco próprio; o literal e `mensagemDoDiaSemJanela(true)` ficam
              amarrados por teste em `agenda-do-atendente-diz-por-que.test.tsx`.
            */}
            {t("Este dia está fora da jornada publicada (folga ou dia sem expediente).")}
          </p>
        )}
        {/*
          Recolhido quando o dia TEM horários — a grade continua sendo o
          caminho de todo dia, e o encaixe, a exceção. Aberto direto quando
          não tem: ali ele é a única coisa que o clique no dia podia querer.
        */}
        {!encaixeAberto && doDia.length > 0 ? (
          <button
            type="button"
            data-testid="abrir-encaixe"
            onClick={() => setEncaixeAberto(true)}
            className={cn(
              "h-11 w-full rounded-sm border border-dashed border-border text-sm text-text-muted transition-colors duration-fast ease-out lg:h-9",
              "hover:border-accent hover:text-text",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500",
            )}
          >
            {t("Outro horário")}
          </button>
        ) : (
          <div className="space-y-1.5">
            <label htmlFor="hora-do-encaixe" className="block text-xs font-medium text-text-muted">
              {t("Outro horário")}
            </label>
            <div className="flex gap-2">
              <Input
                id="hora-do-encaixe"
                data-testid="hora-do-encaixe"
                type="time"
                step={60}
                value={horaDoEncaixe}
                onChange={(e) => setHoraDoEncaixe(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") usarHoraDoEncaixe();
                }}
                aria-describedby="ajuda-do-encaixe"
                className="h-11 min-w-0 flex-1 px-2 tabular-nums lg:h-9"
              />
              <Button
                variant="outline"
                size="sm"
                data-testid="usar-hora-do-encaixe"
                disabled={!partesDaHora}
                onClick={usarHoraDoEncaixe}
                className="lg:h-9"
              >
                {t("Usar")}
              </Button>
            </div>
            <p id="ajuda-do-encaixe" className="text-[11px] leading-4 text-text-subtle">
              {t("Vale fora dos horários publicados. A agenda só recusa se o horário já estiver ocupado.")}
            </p>
          </div>
        )}
      </div>
    ) : null;

  if (tempo === "marcado" && marcado) {
    return (
      <div
        data-testid="painel-de-marcacao"
        data-tempo="marcado"
        className={cn("rounded-lg border border-border bg-surface p-6", className)}
      >
        <div className="flex flex-col items-center text-center">
          <CheckCircle size={32} weight="duotone" className="text-success" aria-hidden />
          {/* "Marcado." — ponto final. Exclamação em sucesso é anti-pattern
              declarado do design system deste produto, e emoji em UI funcional
              também. */}
          <h3 className="mt-3 text-base font-semibold">{t("Marcado.")}</h3>
          <p className="mt-1 text-sm text-text-muted">
            {format(new Date(marcado.instante), t("EEEE, d 'de' MMMM 'às' HH:mm"), { locale: localeDaData })}
          </p>
          <p className="mt-0.5 text-xs text-text-subtle">
            {t(tipo)} · {duracaoMin} {t("min · com")} {responsavel.nome}
          </p>
          {quemSeraAtendido && !quemSeraAtendido.aceitaMensagem && (
            // Repetido aqui de propósito: o aviso do passo anterior sumiu da
            // tela junto com o formulário, e quem fecha o painel agora não tem
            // como saber que aquele agendamento não terá lembrete.
            <p data-testid="aviso-sem-lembrete-no-resumo" className="mt-2 text-xs text-warning">
              {t("Sem lembrete automático —")} {quemSeraAtendido.nome} {t("pediu para não receber mensagens.")}
            </p>
          )}
          <div className="mt-5 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setMarcado(null);
                setHorario(null);
                setDia(null);
                setEncaixeAberto(false);
                setHoraDoEncaixe("");
              }}
            >
              {t("Marcar outro")}
            </Button>
            {/*
              ⚠️ ESTE BOTÃO NÃO TINHA `onClick` NENHUM.

              Não ficava cinza — parecia perfeitamente ativo, com cursor de
              mãozinha —, e o clique não fazia nada. O dono do produto marcou um
              compromisso na v1.8.0, clicou aqui, e o relato foi exatamente
              "nada acontece": ele não tinha o que reportar além disso.

              É a SEGUNDA forma de controle decorativo, e a varredura que esta
              base tem para essa classe (`tests/unit/controle-decorativo.test.ts`)
              era cega para ela: procurava `disabled={!callback}`, e botão mudo
              não tem `disabled`. A varredura passou a cobrir as duas.

              Sem `onVerNaAgenda` ele some, em vez de ficar decorativo: um
              caminho que não existe não deve ser oferecido.
            */}
            {onVerNaAgenda && (
              <Button
                size="sm"
                data-testid="ver-na-agenda"
                onClick={() => onVerNaAgenda(marcado.instante)}
              >
                {t("Ver na agenda")}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="painel-de-marcacao"
      data-tempo={tempo}
      className={cn(
        // `md:w-fit` é o que faz o painel CRESCER quando a coluna entra, em vez de
        // redistribuir o espaço por dentro. Medido: esticado à largura do
        // container ele ficava em 1104px nos dois estados, e a coluna só
        // aparecia às custas do corpo encolher — o mini-calendário diminuía na
        // frente de quem tinha acabado de clicar nele, que é o oposto da
        // sensação de "abriu" que a máquina de três tempos existe para dar.
        //
        // No celular continua ocupando tudo: lá não há para onde crescer, e os
        // três tempos empilham.
        // ⚠️ `lg:` E NÃO `md:` — a conta, que nunca tinha sido feita.
        //
        // As três colunas somam 980px (280 + 420 + 280). Em `md` o container é
        // um Sheet de 768px, então elas transbordavam 239px e o
        // `overflow-hidden` logo abaixo cortava EM SILÊNCIO: sem barra de
        // rolagem, sem aviso. Medido em 1280, 1440 e 1920 — o mesmo transbordo
        // nas três, porque o Sheet é fixo e ancorado à direita. O defeito não
        // "sumia em tela grande"; ele nunca dependeu da tela.
        //
        // De `lg` para cima o Sheet abre para 1040px (`_client.tsx`) e as três
        // colunas cabem com folga. Abaixo disso o painel EMPILHA — os horários
        // viram uma seção sob o calendário, que é o que o cal.com faz e o que
        // esta base já fazia no celular.
        // `lg:min-h-0`: de `lg` para cima o painel tem a altura do conteúdo e
        // quem rola é o Sheet (`_client.tsx`); o piso de 450px é do empilhado.
        "flex min-h-[450px] flex-col overflow-hidden rounded-lg border border-border bg-surface lg:min-h-0 lg:w-fit lg:flex-row",
        className,
      )}
    >
      {/* CONTEXTO — o que se está marcando. Sem esta coluna o painel vira
          formulário cego: a pessoa escolhe um horário sem lembrar de quê. */}
      <aside
        data-testid="contexto-da-marcacao"
        className="shrink-0 border-b border-border bg-surface-elevated/50 p-4 lg:w-[280px] lg:border-b-0 lg:border-r"
      >
        <div className="flex items-center gap-2">
          <AvatarDaPessoa pessoa={responsavel} tamanho="sm" />
          <span className="truncate text-sm font-semibold">{responsavel.nome}</span>
        </div>
        <h3 className="mt-3 text-base font-semibold leading-tight">{tipo}</h3>
        <dl className="mt-3 space-y-2 text-xs text-text-muted">
          <div className="flex items-center gap-1.5">
            <Clock size={14} aria-hidden />
            <dd className="tabular-nums">{duracaoMin} minutos</dd>
          </div>
          {local ? (
            <div className="flex items-center gap-1.5">
              <MapPin size={14} aria-hidden />
              <dd className="truncate">{local}</dd>
            </div>
          ) : null}
        </dl>
        {fuso ? (
          <p className="mt-4 border-t border-border pt-3 text-[11px] leading-4 text-text-subtle">
            {t("Horários no fuso")} <span className="font-mono">{fuso.replace("_", " ")}</span>.
          </p>
        ) : null}
      </aside>

      {/* CORPO — o mês. 420–480px é a faixa medida no cal.com; aqui ela é
          `min-width` e não largura fixa, porque no celular a coluna ocupa tudo. */}
      {/*
        ⚠️ SEM rolagem própria — o corpo cresce e quem rola é o Sheet.

        Em 2026-09-15 o Confirmar ficou fora da caixa (1280×800: começava em
        840px) porque o painel tinha a altura do Sheet e o Sheet não rolava; o
        remendo foi dar `lg:overflow-y-auto` a este corpo. Não bastou: a altura
        que sobrava para o painel era o que o formulário acima deixava, e em
        janela baixa (1280×500, 1024×560), pela conta das alturas do formulário,
        isso é quase nada — o corpo rolava dentro de uma fresta. Agora o Sheet
        rola (`_client.tsx`), e um segundo rolador aqui dentro só prenderia a
        roda do mouse no de dentro.
      */}
      <div
        data-testid="corpo-da-marcacao"
        className="flex min-w-0 flex-1 flex-col p-4 lg:min-w-[420px]"
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold first-letter:uppercase">
            {format(mes, t("MMMM 'de' yyyy"), { locale: localeDaData })}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("Mês anterior")}
              data-testid="mes-anterior"
              onClick={() => setMes((m) => startOfMonth(addDays(startOfMonth(m), -1)))}
            >
              <CaretLeft size={16} weight="bold" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("Próximo mês")}
              data-testid="mes-seguinte"
              onClick={() => setMes((m) => startOfMonth(addDays(startOfMonth(m), 32)))}
            >
              <CaretRight size={16} weight="bold" aria-hidden />
            </Button>
          </div>
        </div>

        {motivoDoBloqueio === "sem-jornada" && (
          // Não é estado vazio: é estado NÃO CONFIGURADO, e o texto diz o
          // próximo passo em vez de constatar a ausência.
          <div
            data-testid="sem-jornada-publicada"
            className="mb-3 rounded-sm border border-warning/40 bg-warning-bg p-3"
          >
            <AvisoDeJornadaNaoPublicada quemLeEhODono={responsavel.nome === "Você"} />
            {/*
              O AVISO VIRA PORTA.

              Ele dizia "Configure a sua disponibilidade" e não levava a lugar
              nenhum — e a tela EXISTE: é a aba "Atendimento" de Equipe, atrás de
              um botão só de ícone que nada nomeia como "meus horários". O dono do
              produto procurou e não achou; concluiu que a tela não existia, e o
              comentário do registro de navegação dizia o mesmo, por estar vencido.

              Instrução sem caminho é acusação: ela diz ao usuário que ele deixou
              de fazer algo e não mostra onde fazer.
            */}
            <Link
              href="/app/team?aba=atendimento"
              data-testid="ir-configurar-horarios"
              className="mt-2 inline-block text-xs font-medium text-accent underline underline-offset-2 hover:text-accent-strong"
            >
              {t("Configurar meus horários de atendimento")}
            </Link>
          </div>
        )}

        {/*
          Os outros dois motivos ganham testid PRÓPRIO, e isso não é capricho: a
          spec do kit visual assere `sem-jornada-publicada` VISÍVEL na seção
          "não configurado" e `toHaveCount(0)` na seção normal. Reusar o mesmo
          testid aqui deixaria a segunda asserção vermelha no dia em que o mês
          visível da vitrine não tivesse dia livre.
        */}
        {motivoDoBloqueio === "erro" && (
          <div
            data-testid="motivo-do-bloqueio"
            data-motivo="erro"
            className="mb-3 rounded-sm border border-warning/40 bg-warning-bg p-3"
          >
            <p className="text-sm font-semibold text-text">{t("Não consegui carregar os horários")}</p>
            <p className="mt-1 text-xs leading-4 text-text-muted">
              {t("Os dias ficam bloqueados até eu conseguir — é mais seguro que oferecer um horário que talvez não exista. Numa instalação nova, isso costuma ser a jornada de atendimento que ainda não foi publicada.")}
            </p>
            <Link
              href="/app/team?aba=atendimento"
              data-testid="ir-configurar-horarios"
              className="mt-2 inline-block text-xs font-medium text-accent underline underline-offset-2 hover:text-accent-strong"
            >
              {t("Configurar meus horários de atendimento")}
            </Link>
          </div>
        )}

        {motivoDoBloqueio === "sem-vaga" && (
          <div
            data-testid="motivo-do-bloqueio"
            data-motivo="sem-vaga"
            className="mb-3 rounded-sm border border-border bg-surface-sunken p-3"
          >
            <p className="text-sm font-semibold text-text">
              {t("Nenhum horário livre em")} {format(mes, "MMMM", { locale: localeDaData })}
            </p>
            <p className="mt-1 text-xs leading-4 text-text-muted">
              {t("Não há horário livre publicado neste mês.")}
            </p>
          </div>
        )}

        {googleCoberturaParcial && <p role="status" className="mb-2 text-xs text-warning">{t("Ocupação do Google ainda não verificada neste período.")}</p>}
        {fusoSuposto && (
          <p data-testid="fuso-suposto" className="mb-2 text-[11px] leading-4 text-text-subtle">
            {t("Estamos supondo o fuso")} <span className="font-mono">{(fuso ?? "").replace("_", " ")}</span> {t("— ninguém escolheu ainda. O agente oferece horário usando ele.")}
          </p>
        )}

        {fontesDefasadas && fontesDefasadas.length > 0 && (
          // Falhar fechado na AÇÃO (o horário fica bloqueado de qualquer jeito)
          // e aberto na INFORMAÇÃO (a tela diz desde quando). O contrário —
          // bloquear em silêncio — faz a pessoa achar que a agenda está errada.
          <p data-testid="fontes-defasadas" className="mb-2 text-[11px] leading-4 text-warning">
            {fontesDefasadas.length === 1
              ? `A agenda conectada ${fontesDefasadas[0]?.nome ?? ""} não atualiza desde ${fontesDefasadas[0]?.desde ?? "algum tempo"}. Os horários dela seguem bloqueados por precaução.`
              : `${fontesDefasadas.length} agendas conectadas não estão atualizando. Os horários delas seguem bloqueados por precaução.`}
          </p>
        )}

        <div className="grid grid-cols-7 gap-1 text-center">
          {semanas[0]?.map((d) => (
            <span key={`c-${d.toISOString()}`} className="pb-1 text-[10px] font-semibold uppercase text-text-subtle">
              {format(d, "EEEEEE", { locale: localeDaData }).replace(".", "")}
            </span>
          ))}
          {semanas.flat().map((d) => {
            const chave = format(d, "yyyy-MM-dd");
            const livres = horariosPorDia[chave] ?? [];
            // Dia sem horário nasce apagado E não clicável. Oferecer o clique e
            // depois dizer "não tem nada" gasta uma interação para entregar a
            // mesma informação que a cor já dava.
            //
            // A exceção é o ENCAIXE: ali o clique entrega outra coisa — o campo
            // de hora —, e o dia sem grade fica clicável mas SEM a cor de vaga.
            // `data-disponivel` segue dizendo "tem horário publicado".
            const disponivel = livres.length > 0 && isSameMonth(d, mes);
            const clicavel = diaClicavel(d);
            const soEncaixe = clicavel && !disponivel;
            const escolhido = dia !== null && isSameDay(d, dia);
            return (
              <button
                key={chave}
                type="button"
                data-testid={`dia-${chave}`}
                data-disponivel={disponivel}
                data-encaixe={soEncaixe || undefined}
                disabled={!clicavel}
                // O DIA DIZ POR QUÊ. O rótulo era `— sem horário` para tudo:
                // dia de outro mês, dia sem vaga e dia com a consulta quebrada
                // liam igual, e quem usa leitor de tela recebia a constatação da
                // ausência sem a causa. O `title` é o mesmo texto — e é EXTRA, não
                // a única via: atributo de hover não existe para quem usa toque,
                // e é por isso que o motivo também está em texto no bloco acima.
                aria-label={
                  disponivel
                    ? `${format(d, t("d 'de' MMMM"), { locale: localeDaData })} — ${livres.length} ${t("horários")}`
                    : soEncaixe
                      ? `${format(d, t("d 'de' MMMM"), { locale: localeDaData })} — ${t("nenhum horário publicado neste dia")}`
                      : `${format(d, t("d 'de' MMMM"), { locale: localeDaData })} — ${razaoDoDia(isSameMonth(d, mes))}`
                }
                title={clicavel ? undefined : razaoDoDia(isSameMonth(d, mes))}
                onClick={() => { setDia(d); setHorario(null); }}
                className={cn(
                  "flex h-9 items-center justify-center rounded-sm text-sm tabular-nums transition-colors duration-fast ease-out",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500",
                  !isSameMonth(d, mes) && "text-text-subtle",
                  disponivel && !escolhido && "bg-accent-soft text-text hover:bg-accent hover:text-accent-foreground",
                  soEncaixe && !escolhido && "text-text hover:bg-accent-soft",
                  escolhido && "bg-accent font-semibold text-accent-foreground",
                  !clicavel && "cursor-default text-text-subtle",
                  isSameDay(d, agora) && !escolhido && "ring-1 ring-inset ring-border-strong",
                )}
              >
                {format(d, "d")}
              </button>
            );
          })}
        </div>

        {tempo === "confirmando" && horario && (
          <div ref={confirmacaoRef} className="mt-4 border-t border-border pt-4" data-testid="confirmacao">
            <p className="text-sm">
              <span className="text-text-muted">{t("Confirmar")} </span>
              <span className="font-semibold">
                {format(new Date(horario.instante), t("EEEE, d 'de' MMMM 'às' HH:mm"), { locale: localeDaData })}
              </span>
            </p>

            {recusa?.instante === horario.instante && (
              // A RECUSA FICA AQUI, ao lado do botão que a produziu. O toast do
              // `showApiError` também a diz, mas some em segundos e mora no canto
              // da tela — e quem marcou por cima de um compromisso precisa ler o
              // motivo enquanto corrige a hora.
              //
              // `lg:w-0 lg:min-w-full`: a frase ocupa a largura do corpo SEM
              // entrar na conta da largura dele. O painel é `lg:w-fit`, e a
              // frase numa linha só pedia mais espaço — medido: ao aparecer a
              // recusa, a coluna de horários pulava 9px para a direita.
              <div
                data-testid="recusa-da-marcacao"
                role="alert"
                className="mt-3 flex gap-2 rounded-sm border border-warning/40 bg-warning-bg p-2.5 lg:w-0 lg:min-w-full"
              >
                <Warning size={16} weight="fill" className="mt-0.5 shrink-0 text-warning" aria-hidden />
                <p className="text-xs leading-4 text-text">{recusa.mensagem}</p>
              </div>
            )}

            {quemSeraAtendido && !quemSeraAtendido.aceitaMensagem && (
              // Aviso, não bloqueio: o botão de confirmar continua ativo logo
              // abaixo. E ele diz o que FAZER no lugar ("combine por telefone"),
              // porque uma tela que só informa a restrição deixa a pessoa parada
              // decidindo sozinha o que fazer com a informação.
              <div
                data-testid="aviso-sem-lembrete"
                role="status"
                className="mt-3 flex gap-2 rounded-sm border border-warning/40 bg-warning-bg p-2.5"
              >
                <Warning size={16} weight="fill" className="mt-0.5 shrink-0 text-warning" aria-hidden />
                <p className="text-xs leading-4 text-text">
                  <span className="font-semibold">{quemSeraAtendido.nome} {t("pediu para não receber mensagens.")}</span>{" "}
                  {t("O lembrete não será enviado — combine por telefone.")}
                </p>
              </div>
            )}
            <div className="mt-3 flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setHorario(null)}>
                {t("Voltar")}
              </Button>
              <Button
                size="sm"
                data-testid="confirmar-marcacao"
                onClick={async () => {
                  // ⚠️ ERA `setMarcado(horario); onConfirmar?.(...)` — nesta ordem
                  // e sem esperar. A vista de sucesso aparecia por estado local do
                  // React, ANTES de o servidor responder, e continuava aparecendo
                  // quando o POST falhava. Medido: a rota devolvia 422
                  // `agenda_disponibilidade_invalida` e a tela dizia "Marcado ✓".
                  //
                  // Dizer que marcou é uma AFIRMAÇÃO sobre o mundo, não sobre a
                  // tela. Ela agora espera o servidor; se der erro, o toast do
                  // `showApiError` aparece e o painel fica onde estava, com o
                  // horário ainda escolhido para tentar de novo.
                  try {
                    await onConfirmar?.(horario.instante);
                    setRecusa(null);
                    setMarcado(horario);
                  } catch (err) {
                    // A mensagem da ROTA só quando ela é uma recusa com motivo
                    // (4xx). Rede e 5xx chegam como "HTTP 500", que não é frase
                    // para a tela — e inventar um motivo seria pior que admitir
                    // que não marcou.
                    setRecusa({
                      instante: horario.instante,
                      mensagem:
                        err instanceof ApiError && err.status >= 400 && err.status < 500
                          ? err.message
                          : t("Não foi marcado. Tente de novo."),
                    });
                  }
                }}
              >
                {t("Confirmar")}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* HORÁRIOS — a coluna que não estava lá. */}
      <div
        data-testid="coluna-de-horarios"
        data-aberta={tempo !== "escolhendo-dia"}
        // `shrink-0` só a partir de `lg`, que é onde ela É uma coluna. Abaixo
        // disso ela ocupa a largura toda EMPILHADA e precisa poder encolher,
        // senão empurra o painel para fora — e o `overflow-hidden` corta o
        // excedente em silêncio, sem barra de rolagem.
        //
        // Era `md:`, e é o que punha 980px de colunas dentro de um Sheet de
        // 768px em toda tela de notebook.
        className="agenda-coluna-horarios lg:shrink-0"
      >
        {/* `w-full` empilhado, largura fixa só quando é coluna de verdade. A
            largura fixa em qualquer breakpoint era o que impedia o painel de
            caber: o conteúdo segurava 240px mesmo quando o pai não os tinha. */}
        <div className="flex h-full w-full flex-col p-3 lg:w-[280px]">
          <p className="mb-2 shrink-0 text-xs font-semibold text-text-muted first-letter:uppercase">
            {dia ? format(dia, t("EEEE, d 'de' MMM"), { locale: localeDaData }) : ""}
          </p>
          {doDia.length === 0 && blocoDoEncaixe}
          {/*
            `data-testid` para a lista poder ser MEDIDA, e não só vista. O
            `overflow-y-auto` aqui sempre esteve certo e era INERTE: um
            `overflow-y-auto` cujo pai tem altura `auto` não rola, porque o filho
            cresce e `scrollHeight === clientHeight`.

            ## Por que o teto mora AQUI, e não mais na cadeia de alturas

            Este comentário dizia "quem fecha a cadeia é o `_client.tsx`, que dá
            teto ao Sheet". Era verdade e virou o defeito seguinte: para a janela
            parar de CORTAR os botões em tela baixa, o teto do Sheet foi removido
            — e a lista, sem pai com altura, voltou a crescer sem fim. Medido numa
            instalação real em 2026-09-12: um tipo de 45 minutos rendeu treze
            horários e uma janela que não cabia na tela. Trocamos "corta" por
            "estica", que é o mesmo erro pelo avesso.

            `lg:max-h` resolve sem cadeia: `max-height` + `overflow-y-auto` rola
            por conta própria, sem depender de o pai ter altura definida — que é
            a condição frágil que já falhou nos dois sentidos. Abaixo de `lg` não
            há teto de propósito: ali quem rola é o diálogo inteiro, e dois
            roladores aninhados no celular prendem o dedo no de dentro.

            O teto tem DUAS partes, e cada uma cobre o que a outra não cobre:

            - `42vh` para a janela BAIXA — em 1366×768 sobram ~520px reais, e um
              teto em pixel escolhido num monitor grande volta a cortar
              exatamente onde o defeito original aparecia;
            - `380px` para a janela ALTA — sem ele, numa tela de 1440px de altura
              a lista teria 600px de teto, o que não é teto nenhum: a janela
              volta a ficar maior que o calendário ao lado, que é o que se está
              tentando evitar.

            ⚠️ A primeira tentativa foi `60vh` sozinho, e ela FALHOU na prova de
            tela: a barra de rolagem apareceu — o mecanismo estava certo —, mas
            numa janela de ~950px isso ainda dava 570px de lista, e o relato foi
            "scroll de horas ainda gigante". Rolar não era o objetivo; caber era.
            Fica escrito porque o erro não foi o mecanismo, foi o NÚMERO — e é o
            tipo de coisa que nenhum gate mede e só a tela mostra.
          */}
          <div
            data-testid="lista-de-horarios"
            className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1 lg:max-h-[min(42vh,380px)]"
          >
            {doDia.map((h) => (
              <button
                key={h.instante}
                type="button"
                data-testid={`horario-${h.rotulo}`}
                onClick={() => setHorario(h)}
                className={cn(
                  // Alvo de toque generoso: quem marca consulta faz isso no
                  // celular, com o cliente esperando na frente.
                  "h-11 shrink-0 rounded-sm border text-sm tabular-nums transition-colors duration-fast ease-out",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500",
                  horario?.instante === h.instante
                    ? "border-accent bg-accent font-semibold text-accent-foreground"
                    : "border-border bg-surface text-text hover:border-accent hover:bg-accent-soft",
                )}
              >
                {h.rotulo}
              </button>
            ))}
          </div>

          {doDia.length > 0 && blocoDoEncaixe}
        </div>
      </div>
    </div>
  );
}
