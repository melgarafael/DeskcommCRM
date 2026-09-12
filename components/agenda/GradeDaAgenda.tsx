"use client";

import * as React from "react";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";


import {
  addDays,
  differenceInMinutes,
  format,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
} from "date-fns";

import {
  PASSO_DA_CELULA_MIN,
  alvoDoArraste,
  celulaQueContem,
  horarioNaCelula,
  minutoSobY,
  publicadoVizinho,
  razaoDoBloco,
  type HorarioPublicado,
  type MotivoDaGradeTravada,
} from "@/lib/agenda/grade-interativa";
import { cn } from "@/lib/utils";
import { useT } from "@/hooks/i18n/useT";

import { corDaTrilha, fundoDaTrilha } from "./paleta";
import type { Agendamento, Pessoa, VisaoDaAgenda } from "./tipos";

/**
 * Altura de uma hora, em pixels. É a régua de toda a grade: posição e duração
 * de um bloco saem daqui, e o teste mede contra este número.
 *
 * 48px e não os 56px da linha de lista do produto: numa semana de trabalho de
 * 14 horas, 56 dá 784px de rolagem e o dia deixa de caber numa tela de notebook.
 * 48 mantém 12h visíveis em 1080p — e um agendamento de 30 minutos ainda tem
 * 24px, altura suficiente para uma linha de texto legível.
 */
const ALTURA_DA_HORA = 48;

/** A janela que a grade desenha. Fora dela, rola. */
const PRIMEIRA_HORA = 7;
const ULTIMA_HORA = 21;

const HORAS = Array.from(
  { length: ULTIMA_HORA - PRIMEIRA_HORA + 1 },
  (_, i) => PRIMEIRA_HORA + i,
);

/**
 * O que transforma a grade de DESENHO em AGENDA.
 *
 * A prop inteira é opcional, e isto não é cortesia: a vitrine
 * (`/vitrine-agenda`) monta a mesma grade sem rota nenhuma por trás, e uma
 * grade que exigisse disponibilidade para renderizar deixaria de ser julgável
 * ali. Sem `interacao` a grade é exatamente o que era — só leitura.
 *
 * `horariosPorDia` vem da MESMA rota que o painel de marcação e o agente usam
 * (`GET /api/v1/agenda/horarios-livres`). A grade não recalcula jornada,
 * exceção nem buffer: ela posiciona a resposta. Ver o cabeçalho de
 * `lib/agenda/grade-interativa.ts` para o porquê disso ser uma barreira e não
 * uma preferência.
 */
export interface InteracaoDaGrade {
  /** `yyyy-MM-dd` → horários publicados naquele dia. */
  horariosPorDia: Record<string, HorarioPublicado[]>;
  /** Por que a grade inteira está travada, quando está. */
  motivo: MotivoDaGradeTravada | null;
  /** Duração do tipo escolhido — o tamanho do bloco que se está marcando. */
  duracaoMin: number;
  /** Clique num bloco livre. Recebe o instante PUBLICADO, nunca um calculado. */
  onMarcarEm: (instante: string) => void;
  /**
   * Um card foi solto (ou movido pelo teclado). `instante` nulo quer dizer que
   * o destino está fora da disponibilidade — quem recebe RECUSA e diz `razao`,
   * em vez de remarcar em silêncio ou aproximar para o horário mais perto.
   */
  onArrastarPara?: (entrada: { id: string; instante: string | null; razao: string }) => void;
}

/** Onde um card arrastado está sendo proposto — o mesmo estado para ponteiro e teclado. */
interface PropostaDeRemarcacao {
  id: string;
  /** `yyyy-MM-dd` da coluna sob o ponteiro. */
  dia: string;
  /** Minuto do dia onde o fantasma é DESENHADO — já encaixado, quando encaixa. */
  minuto: number;
  /**
   * O minuto pedido, ANTES do encaixe.
   *
   * Os dois são diferentes de propósito: o desenho tem de mostrar onde o card
   * vai cair de verdade, e o próximo passo do teclado tem de partir de onde o
   * usuário pediu. Partir do encaixado é o que fazia a seta travar — somar meia
   * hora a um horário publicado empata entre ele e o seguinte, e o empate volta
   * para ele.
   */
  minutoBruto: number;
  /** O horário publicado que aceita, ou `null` — a proposta continua visível. */
  instante: string | null;
  razao: string;
}

function minutosDesdeOTopo(d: Date): number {
  return (d.getHours() - PRIMEIRA_HORA) * 60 + d.getMinutes();
}

function pixelsDe(minutos: number): number {
  return (minutos / 60) * ALTURA_DA_HORA;
}

/** A chave do dia — o mesmo formato que `horariosPorDia` usa. */
function chaveDoDia(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

/**
 * O instante de parede de um minuto do dia.
 *
 * `setHours` e não aritmética sobre a meia-noite: somar minutos a um timestamp
 * atravessa a virada do horário de verão errado por uma hora, e o erro aparece
 * duas vezes por ano num único dia — que é o pior formato de defeito para
 * reproduzir.
 */
function instanteDoMinuto(dia: Date, minuto: number): Date {
  const d = new Date(dia);
  d.setHours(Math.floor(minuto / 60), minuto % 60, 0, 0);
  return d;
}

/** Os começos de célula que a camada de marcação desenha, em minutos do dia. */
const CELULAS = Array.from(
  { length: ((ULTIMA_HORA - PRIMEIRA_HORA + 1) * 60) / PASSO_DA_CELULA_MIN },
  (_, i) => PRIMEIRA_HORA * 60 + i * PASSO_DA_CELULA_MIN,
);

function diasDaSemanaDe(ancora: Date): Date[] {
  const inicio = startOfWeek(ancora, { weekStartsOn: 0 });
  return Array.from({ length: 7 }, (_, i) => addDays(inicio, i));
}

/**
 * Onde cada bloco cabe quando dois caem no mesmo horário.
 *
 * Sem isto o segundo agendamento das 16h desenha EM CIMA do primeiro e some da
 * tela — e o pior é que a agenda continua parecendo correta: quem olha vê um
 * compromisso onde há dois, e a única pista é que a pessoa some do dia. Numa
 * clínica com dois profissionais atendendo em paralelo esse é o caso normal,
 * não a exceção.
 *
 * O algoritmo é o de qualquer agenda: agrupa os que se encavalam (transitivo —
 * A com B e B com C põe os três no mesmo grupo, mesmo que A e C não se toquem),
 * dá a cada um a primeira coluna livre do grupo, e reparte a largura pelo
 * número de colunas que o grupo precisou.
 */
type Posicionado = { agendamento: Agendamento; coluna: number; colunas: number };

function repartirSobrepostos(agendamentos: Agendamento[]): Posicionado[] {
  const ordenados = [...agendamentos].sort(
    (a, b) => new Date(a.comeca).getTime() - new Date(b.comeca).getTime(),
  );

  const resultado: Posicionado[] = [];
  let grupo: Array<{ agendamento: Agendamento; coluna: number }> = [];
  let fimDoGrupo = 0;

  const fecharGrupo = () => {
    if (grupo.length === 0) return;
    const colunas = Math.max(...grupo.map((g) => g.coluna)) + 1;
    for (const g of grupo) resultado.push({ ...g, colunas });
    grupo = [];
    fimDoGrupo = 0;
  };

  for (const a of ordenados) {
    const comeca = new Date(a.comeca).getTime();
    const termina = new Date(a.termina).getTime();
    // Começou depois de TUDO do grupo acabar: o grupo fechou.
    if (grupo.length > 0 && comeca >= fimDoGrupo) fecharGrupo();

    const ocupadas = new Set(
      grupo
        .filter((g) => new Date(g.agendamento.termina).getTime() > comeca)
        .map((g) => g.coluna),
    );
    let coluna = 0;
    while (ocupadas.has(coluna)) coluna += 1;

    grupo.push({ agendamento: a, coluna });
    fimDoGrupo = Math.max(fimDoGrupo, termina);
  }
  fecharGrupo();
  return resultado;
}

/**
 * OS BLOCOS VAZIOS — a camada que faz a grade aceitar um clique.
 *
 * Um botão por meia hora, e cada um resolve a MESMA pergunta que o painel de
 * marcação resolve por dia: existe horário publicado aqui? Se existe, o botão
 * abre a marcação NAQUELE instante — o que a rota devolveu, não um que a tela
 * calculou. Se não existe, ele nasce `disabled` **e diz por quê**.
 *
 * ⚠️ O "diz por quê" é o ponto, e é dívida que esta tela já pagou uma vez.
 * `PainelDeMarcacao` apagava os dias por uma conta e explicava por outra, então
 * havia estado em que a grade travava em silêncio — 42 dias mortos, aviso
 * nenhum. Aqui a frase sai de `razaoDoBloco`, alimentada pela MESMA entrada que
 * desabilita o botão: por construção os dois não voltam a divergir.
 *
 * A razão vai no `aria-label` E no `title`, como o painel faz — e o motivo
 * global também aparece em TEXTO acima da grade, porque atributo de hover não
 * existe para quem usa toque, que é o dono de clínica no celular.
 */
function CamadaDeMarcacao({
  dia,
  agora,
  agendamentosDoDia,
  interacao,
}: {
  dia: Date;
  agora: Date;
  agendamentosDoDia: Agendamento[];
  interacao: InteracaoDaGrade;
}) {
  const localeDaData = useLocaleDeData();
  const chave = chaveDoDia(dia);
  const publicados = interacao.horariosPorDia[chave] ?? [];

  return (
    <>
      {CELULAS.map((minuto) => {
        const livre = horarioNaCelula(publicados, minuto);
        const inicio = instanteDoMinuto(dia, minuto);
        const fim = instanteDoMinuto(dia, minuto + PASSO_DA_CELULA_MIN);
        const ocupado = agendamentosDoDia.some(
          (a) =>
            a.situacao !== "cancelled" &&
            new Date(a.comeca) < fim &&
            new Date(a.termina) > inicio,
        );
        const passado = fim.getTime() <= agora.getTime();
        const rotulo = format(inicio, "HH:mm");
        const razao = razaoDoBloco({ motivo: interacao.motivo, ocupado, passado });

        return (
          <button
            key={minuto}
            type="button"
            data-testid={`bloco-${chave}-${rotulo}`}
            data-livre={livre !== null}
            disabled={livre === null}
            aria-label={
              livre
                ? `Marcar às ${livre.rotulo} de ${format(dia, "d 'de' MMMM", { locale: localeDaData })}`
                : `${format(dia, "d 'de' MMMM", { locale: localeDaData })} às ${rotulo} — ${razao}`
            }
            title={livre ? undefined : razao}
            onClick={livre ? () => interacao.onMarcarEm(livre.instante) : undefined}
            className={cn(
              "absolute inset-x-0 z-0 transition-colors duration-fast ease-out",
              "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500",
              livre
                ? "cursor-pointer hover:bg-accent-soft"
                : // Sem cor de bloqueio: pintar o vazio indisponível encheria a
                  // grade de faixas cinzas e faria o que ESTÁ livre desaparecer
                  // no meio. O sinal fica na ausência de resposta ao passar o
                  // mouse, no cursor e no motivo escrito.
                  "cursor-default",
            )}
            style={{ top: pixelsDe(minuto - PRIMEIRA_HORA * 60), height: pixelsDe(PASSO_DA_CELULA_MIN) }}
          />
        );
      })}
    </>
  );
}

/**
 * O bloco de um agendamento dentro de um dia.
 *
 * A faixa lateral tem 3px, e não os 2px do card do funil, porque ali a cor diz
 * *estado* (informação secundária, ao lado de um título de duas linhas) e aqui
 * ela diz *de quem é* — que é o que se lê primeiro num bloco de 24px de altura,
 * antes de qualquer texto.
 */
function BlocoDeAgendamento({
  agendamento,
  pessoa,
  onAbrir,
  coluna,
  colunas,
  arraste,
}: {
  agendamento: Agendamento;
  pessoa: Pessoa | undefined;
  onAbrir?: (id: string) => void;
  coluna: number;
  colunas: number;
  /**
   * O gesto de remarcar — ponteiro e teclado pelo MESMO caminho.
   *
   * Drag-and-drop puro exclui quem usa teclado, e a saída aqui não é uma
   * segunda funcionalidade: `Alt+↑/↓` alimenta a mesma proposta que o arraste
   * alimenta, e `Enter` a consuma pelo mesmo `onArrastarPara`. Dois gestos, um
   * mecanismo — o que impede o caminho por teclado de apodrecer é ele não ter
   * código próprio para apodrecer.
   */
  arraste?: {
    /** Este card está com uma proposta aberta. */
    ativo: boolean;
    aoApontar: (e: React.PointerEvent<HTMLButtonElement>, a: Agendamento) => void;
    aoTeclar: (e: React.KeyboardEvent<HTMLButtonElement>, a: Agendamento) => void;
    /** Houve arraste de verdade: o clique que vem a seguir não deve abrir nada. */
    moveu: () => boolean;
  };
}) {
  const t = useT();
  const comeca = new Date(agendamento.comeca);
  const termina = new Date(agendamento.termina);
  const duracao = Math.max(differenceInMinutes(termina, comeca), 15);
  const trilha = pessoa?.trilha ?? 1;
  const doGoogle = agendamento.origem === "google_sync";
  const cancelado = agendamento.situacao === "cancelled";

  return (
    <button
      type="button"
      data-testid={`agendamento-${agendamento.id}`}
      data-origem={agendamento.origem}
      data-trilha={trilha}
      data-situacao={agendamento.situacao}
      data-colunas={colunas}
      data-coluna={coluna}
      // Ocupação do Google não abre: não há o que editar deste lado. Deixar o
      // clique disponível prometeria uma ação que não existe — o defeito do
      // "controle decorativo" que esta base já pagou uma vez.
      disabled={doGoogle}
      data-arrastavel={arraste !== undefined && !doGoogle && !cancelado}
      data-arrastando={arraste?.ativo === true}
      // ⚠️ O CLIQUE QUE FECHA UM ARRASTE NÃO ABRE O COMPROMISSO.
      //
      // `pointerup` dispara `click` logo em seguida, sempre. Sem esta guarda,
      // arrastar um card para outro horário abriria o painel de remarcação por
      // cima da confirmação que o arraste acabou de pedir — duas perguntas na
      // tela ao mesmo tempo, e a de baixo é a que o usuário pediu.
      onClick={doGoogle ? undefined : () => { if (!arraste?.moveu()) onAbrir?.(agendamento.id); }}
      onPointerDown={
        arraste && !doGoogle && !cancelado ? (e) => arraste.aoApontar(e, agendamento) : undefined
      }
      onKeyDown={
        arraste && !doGoogle && !cancelado ? (e) => arraste.aoTeclar(e, agendamento) : undefined
      }
      // "com" nesta tela significa QUEM SERÁ ATENDIDO — é o vocabulário do
      // próprio subtítulo ("O que está marcado, com quem, e quem atende"). O
      // rótulo dizia `, com ${pessoa.nome}`, que é o ATENDENTE: quem usa leitor
      // de tela ouvia os dois papéis trocados, e o card visual não desmente
      // porque em compromisso de 30min ele nem mostra o contato.
      // `titulo` é DADO DO OPERADOR — a rota grava `title ?? tipo.name`, e
      // `tipo.name` é o nome que ele cadastrou em Tipos de agendamento. Passá-lo
      // por `t()` fazia "Retorno" virar "Seguimiento" na leitura de tela.
      aria-label={`${agendamento.titulo}, ${format(comeca, "HH:mm")} ${t("às")} ${format(termina, "HH:mm")}${
        agendamento.quemSeraAtendido ? `, ${t("com")} ${agendamento.quemSeraAtendido}` : ""
      }${pessoa ? `, ${t("atendido por")} ${pessoa.nome}` : ""}${
        doGoogle ? `, ${t("ocupado na agenda do Google")}` : ""
      }`}
      className={cn(
        "absolute flex flex-col items-start overflow-hidden rounded-sm px-1.5 py-0.5 text-left",
        "border border-border/60 transition-colors duration-fast ease-out",
        doGoogle ? "cursor-default" : "cursor-pointer hover:border-border-strong",
        // `grab` só quando remarcar é possível: o cursor é a única pista de que
        // o card se move, e prometê-la num card que não se move (ocupação do
        // Google, compromisso cancelado) é o controle decorativo de novo.
        arraste && !doGoogle && !cancelado && "cursor-grab active:cursor-grabbing touch-none",
        // ⚠️ CANCELADO NÃO INTERCEPTA O PONTEIRO — e isto é conserto de produto,
        // achado pela spec em tela.
        //
        // O card é `absolute` e fica por cima da camada de blocos vazios.
        // Cancelar DEVOLVE o horário (`cancelled` está em `SITUACOES_QUE_LIBERAM`,
        // e a rota volta a oferecê-lo), então o bloco embaixo nasce clicável — e
        // o clique morria no card cancelado. Medido: `locator.click` esperando
        // 150s porque `<button data-situacao="cancelled">` recebia o evento
        // "from" o bloco livre. Numa clínica com uma semana de cancelamentos, o
        // horário reaberto vira inalcançável pela grade.
        //
        // O card continua VISÍVEL — ele é a memória do que houve ali, e some-lo
        // faria o horário parecer que nunca teve nada. O que ele perde é o
        // clique, que já existe na aba "Cancelados" do histórico logo acima. A
        // ação viva naquele espaço é marcar; o cancelado é registro.
        cancelado && "pointer-events-none opacity-55",
        // Enquanto a proposta está aberta o card original esmaece e o fantasma
        // mostra onde ele cairia. Sumir com o original faria perder a
        // referência de onde ele estava — que é o que se desfaz ao cancelar.
        arraste?.ativo && "opacity-40",
      )}
      style={{
        top: pixelsDe(minutosDesdeOTopo(comeca)),
        height: Math.max(pixelsDe(duracao) - 2, 18),
        // `calc` em vez de porcentagem crua para os 2px de respiro entre
        // colunas vizinhas não saírem da largura útil de cada bloco.
        left: `calc(${(coluna / colunas) * 100}% + 2px)`,
        width: `calc(${(1 / colunas) * 100}% - 4px)`,
        background: doGoogle
          ? // Hachura: diz "ocupado" sem fingir que é um agendamento nosso. A cor
            // é neutra de propósito — a agenda de fora não pertence a ninguém da
            // equipe, então não recebe trilha.
            "repeating-linear-gradient(135deg, var(--color-surface-elevated) 0 6px, var(--color-surface) 6px 12px)"
          : fundoDaTrilha(trilha),
        opacity: doGoogle ? 0.75 : undefined,
      }}
    >
      <span
        aria-hidden
        data-testid={`faixa-${agendamento.id}`}
        className="absolute inset-y-0 left-0 w-[3px] rounded-l-sm"
        style={{ backgroundColor: doGoogle ? "var(--color-border-strong)" : corDaTrilha(trilha) }}
      />
      <span className="ml-1 truncate text-[11px] font-semibold leading-4 text-text">
        {agendamento.titulo}
      </span>
      {duracao >= 45 && (
        <span className="ml-1 truncate text-[10px] leading-3 tabular-nums text-text-muted">
          {format(comeca, "HH:mm")}
          {agendamento.quemSeraAtendido ? ` · ${agendamento.quemSeraAtendido}` : ""}
        </span>
      )}
    </button>
  );
}

/** A régua do agora — a linha que faz a tela parecer viva em vez de impressa. */
function ReguaDoAgora({ agora }: { agora: Date }) {
  const minutos = minutosDesdeOTopo(agora);
  if (minutos < 0 || minutos > (ULTIMA_HORA - PRIMEIRA_HORA + 1) * 60) return null;
  return (
    <div
      data-testid="regua-do-agora"
      aria-hidden
      className="pointer-events-none absolute inset-x-0 z-10 flex items-center"
      style={{ top: pixelsDe(minutos) }}
    >
      {/* Vermelho, e não a accent: a accent é trocável pelo revendedor e além
          disso é a cor de "nosso", não de "agora". Vermelho para a linha do
          instante é convenção de calendário há vinte anos — aqui no tom terroso
          do produto (`--color-error`), não no vermelho puro que a doutrina bane. */}
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-error" />
      <span className="h-px flex-1 bg-error" />
    </div>
  );
}

function ColunaDeHoras() {
  return (
    <div className="w-12 shrink-0 select-none border-r border-border" aria-hidden>
      <div className="h-8 border-b border-border" />
      {HORAS.map((h) => (
        <div
          key={h}
          className="relative border-b border-border/50 text-right"
          style={{ height: ALTURA_DA_HORA }}
        >
          <span className="absolute -top-1.5 right-1 text-[10px] tabular-nums text-text-subtle">
            {String(h).padStart(2, "0")}h
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * ONDE O CARD VAI CAIR — o fantasma.
 *
 * Ele existe porque o arraste precisa responder à pergunta "para que horário?"
 * ANTES de consumar, e um card que só acompanha o ponteiro responde "para onde
 * o seu dedo está", que não é a mesma coisa: o instante de destino é encaixado
 * na disponibilidade publicada, e o encaixe é justamente o que o usuário não
 * consegue prever olhando o cursor.
 *
 * Ele também é o que dá ao gesto uma versão INVÁLIDA visível: solto fora da
 * disponibilidade, o fantasma aparece em vermelho com o motivo, em vez de o
 * card simplesmente voltar sem explicação.
 */
function FantasmaDoArraste({
  proposta,
  duracaoMin,
}: {
  proposta: PropostaDeRemarcacao;
  duracaoMin: number;
}) {
  const localeDaData = useLocaleDeData();
  const valido = proposta.instante !== null;
  return (
    <div
      data-testid="fantasma-do-arraste"
      data-instante={proposta.instante ?? ""}
      data-valido={valido}
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0.5 z-20 rounded-sm border-2 border-dashed px-1.5 py-0.5",
        valido ? "border-accent bg-accent-soft" : "border-error bg-error-bg",
      )}
      style={{
        top: pixelsDe(proposta.minuto - PRIMEIRA_HORA * 60),
        height: Math.max(pixelsDe(duracaoMin) - 2, 18),
      }}
    >
      <span className="truncate text-[10px] font-semibold leading-4 text-text">
        {valido
          ? format(new Date(proposta.instante!), "HH:mm", { locale: localeDaData })
          : proposta.razao}
      </span>
    </div>
  );
}

function ColunaDeDia({
  dia,
  agora,
  agendamentos,
  pessoas,
  onAbrir,
  destacado,
  interacao,
  proposta,
  arrasteDoCard,
}: {
  dia: Date;
  agora: Date;
  agendamentos: Agendamento[];
  pessoas: Pessoa[];
  onAbrir?: (id: string) => void;
  destacado: boolean;
  interacao?: InteracaoDaGrade;
  proposta?: PropostaDeRemarcacao | null;
  arrasteDoCard?: {
    aoApontar: (e: React.PointerEvent<HTMLButtonElement>, a: Agendamento) => void;
    aoTeclar: (e: React.KeyboardEvent<HTMLButtonElement>, a: Agendamento) => void;
    moveu: () => boolean;
  };
}) {
  const localeDaData = useLocaleDeData();
  const doDia = agendamentos.filter((c) => isSameDay(new Date(c.comeca), dia));
  const ehHoje = isSameDay(dia, agora);

  return (
    <div
      data-testid={`coluna-dia-${format(dia, "yyyy-MM-dd")}`}
      className={cn(
        "relative min-w-0 flex-1 border-r border-border last:border-r-0",
        destacado && "bg-surface-elevated/40",
      )}
    >
      <div
        className={cn(
          "sticky top-0 z-20 flex h-8 items-center justify-center gap-1.5 border-b border-border bg-surface px-2",
        )}
      >
        <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-text-muted">
          {format(dia, "EEE", { locale: localeDaData }).replace(".", "")}
        </span>
        <span
          className={cn(
            "flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] tabular-nums",
            ehHoje ? "bg-accent text-accent-foreground font-semibold" : "text-text",
          )}
        >
          {format(dia, "d")}
        </span>
      </div>

      <div
        className="relative"
        // O ALVO DO ARRASTE, e ele é lido por GEOMETRIA e não por hit-testing.
        //
        // `document.elementFromPoint` devolveria o card arrastado ou o fantasma
        // conforme a ordem de pintura, e o `setPointerCapture` desliga o hit
        // test de qualquer forma. Comparar `getBoundingClientRect()` de cada
        // corpo de dia é determinístico e independe do que está desenhado por
        // cima — que é exatamente o que muda durante um arraste.
        data-corpo-do-dia={chaveDoDia(dia)}
        style={{ height: HORAS.length * ALTURA_DA_HORA }}
      >
        {HORAS.map((h) => (
          <div
            key={h}
            className="border-b border-border/50"
            style={{ height: ALTURA_DA_HORA }}
          />
        ))}
        {interacao && (
          <CamadaDeMarcacao
            dia={dia}
            agora={agora}
            agendamentosDoDia={doDia}
            interacao={interacao}
          />
        )}
        {repartirSobrepostos(doDia).map(({ agendamento, coluna, colunas }) => (
          <BlocoDeAgendamento
            key={agendamento.id}
            agendamento={agendamento}
            pessoa={pessoas.find((p) => p.id === agendamento.responsavelId)}
            onAbrir={onAbrir}
            coluna={coluna}
            colunas={colunas}
            arraste={
              arrasteDoCard
                ? { ...arrasteDoCard, ativo: proposta?.id === agendamento.id }
                : undefined
            }
          />
        ))}
        {proposta && proposta.dia === chaveDoDia(dia) && (
          <FantasmaDoArraste proposta={proposta} duracaoMin={interacao?.duracaoMin ?? 30} />
        )}
        {ehHoje && <ReguaDoAgora agora={agora} />}
      </div>
    </div>
  );
}

function VisaoDeMes({
  ancora,
  agora,
  agendamentos,
  pessoas,
}: {
  ancora: Date;
  agora: Date;
  agendamentos: Agendamento[];
  pessoas: Pessoa[];
}) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  const primeiro = startOfWeek(startOfMonth(ancora), { weekStartsOn: 0 });
  // SEIS semanas sempre, mesmo quando o mês cabe em cinco.
  //
  // Um mês que ocupa 5 linhas e outro que ocupa 6 fariam a célula mudar de
  // altura ao virar o mês — a grade "pula" e quem estava olhando um dia perde
  // a referência. O custo é uma linha de dias do mês seguinte, que já nasce
  // esmaecida.
  const semanas: Date[][] = Array.from({ length: 6 }, (_, s) =>
    Array.from({ length: 7 }, (_, d) => addDays(primeiro, s * 7 + d)),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-7 border-b border-border">
        {semanas[0]?.map((d) => (
          <div
            key={`cab-${d.toISOString()}`}
            className="px-2 py-1.5 text-center text-[11px] font-semibold uppercase tracking-wide text-text-muted"
          >
            {format(d, "EEEEEE", { locale: localeDaData }).replace(".", "")}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-[repeat(auto-fit,minmax(0,1fr))]">
        {semanas.flat().map((d) => {
          const doDia = agendamentos.filter((c) => isSameDay(new Date(c.comeca), d));
          const doMes = isSameMonth(d, ancora);
          return (
            <div
              key={d.toISOString()}
              data-testid={`celula-mes-${format(d, "yyyy-MM-dd")}`}
              className={cn(
                "min-h-20 border-b border-r border-border p-1",
                !doMes && "bg-surface-elevated/30",
              )}
            >
              <div className="mb-1 flex items-center justify-between px-0.5">
                <span
                  className={cn(
                    "flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] tabular-nums",
                    isSameDay(d, agora)
                      ? "bg-accent font-semibold text-accent-foreground"
                      : doMes
                        ? "text-text"
                        : "text-text-subtle",
                  )}
                >
                  {format(d, "d")}
                </span>
                {doDia.length > 2 && (
                  <span className="text-[10px] tabular-nums text-text-subtle">
                    +{doDia.length - 2}
                  </span>
                )}
              </div>
              <div className="space-y-0.5">
                {doDia.slice(0, 2).map((c) => {
                  const trilha = pessoas.find((p) => p.id === c.responsavelId)?.trilha ?? 1;
                  return (
                    <div
                      key={c.id}
                      data-testid={`chip-mes-${c.id}`}
                      className="flex items-center gap-1 rounded-sm px-1 py-0.5"
                      style={{ background: fundoDaTrilha(trilha, 14) }}
                    >
                      <span
                        aria-hidden
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: corDaTrilha(trilha) }}
                      />
                      <span className="truncate text-[10px] leading-4 text-text">
                        {format(new Date(c.comeca), "HH:mm")} {c.titulo}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function GradeDaAgenda({
  visao,
  ancora,
  agora,
  pessoas,
  agendamentos,
  onAbrirAgendamento,
  interacao,
  className,
}: {
  visao: VisaoDaAgenda;
  /** O período que a grade mostra. */
  ancora: Date;
  /**
   * O instante do "agora" — INJETADO, nunca `new Date()` aqui dentro.
   *
   * Um relógio lido dentro do componente daria à vitrine e ao teste dois
   * relógios diferentes, e a asserção sobre a posição da régua passaria a
   * depender do minuto em que a suíte rodou.
   */
  agora: Date;
  pessoas: Pessoa[];
  agendamentos: Agendamento[];
  onAbrirAgendamento?: (id: string) => void;
  /** Ausente = grade só de leitura, como a vitrine a monta. Ver `InteracaoDaGrade`. */
  interacao?: InteracaoDaGrade;
  className?: string;
}) {
  const dias = visao === "dia" ? [ancora] : diasDaSemanaDe(ancora);

  const gradeRef = React.useRef<HTMLDivElement>(null);
  const [proposta, setProposta] = React.useState<PropostaDeRemarcacao | null>(null);
  /**
   * O gesto em curso vive numa REF, não no estado.
   *
   * Ele muda a cada `pointermove` — sessenta vezes por segundo — e nada na tela
   * depende dele diretamente (quem a tela desenha é a `proposta`, que só muda
   * quando o encaixe muda). Em estado, cada pixel de movimento re-renderizaria
   * a semana inteira.
   */
  const gesto = React.useRef<{
    id: string;
    x0: number;
    y0: number;
    /** Onde dentro do card o ponteiro pegou — o que faz o TOPO seguir o dedo. */
    deslocamentoNoCard: number;
    moveu: boolean;
  } | null>(null);

  const limites = { primeiro: PRIMEIRA_HORA * 60, ultimo: (ULTIMA_HORA + 1) * 60 };

  /** A proposta para um instante — a mesma conta para o ponteiro e para o teclado. */
  const montarProposta = React.useCallback(
    (id: string, chave: string, minutoBruto: number): PropostaDeRemarcacao => {
      const publicados = interacao?.horariosPorDia[chave] ?? [];
      const alvo = alvoDoArraste(publicados, minutoBruto);
      const dia = new Date(`${chave}T12:00:00`);
      const minutoCelula = celulaQueContem(minutoBruto);
      const inicio = instanteDoMinuto(dia, minutoCelula);
      const fim = instanteDoMinuto(dia, minutoCelula + PASSO_DA_CELULA_MIN);
      const ocupado = agendamentos.some(
        (a) =>
          a.id !== id &&
          a.situacao !== "cancelled" &&
          new Date(a.comeca) < fim &&
          new Date(a.termina) > inicio,
      );
      return {
        id,
        dia: chave,
        // O fantasma gruda no horário PUBLICADO quando há um; sem ele, na
        // célula sob o ponteiro — que é onde a recusa precisa ser mostrada.
        minuto: alvo
          ? new Date(alvo.instante).getHours() * 60 + new Date(alvo.instante).getMinutes()
          : minutoCelula,
        minutoBruto,
        instante: alvo?.instante ?? null,
        razao: razaoDoBloco({
          motivo: interacao?.motivo ?? null,
          ocupado,
          passado: fim.getTime() <= agora.getTime(),
        }),
      };
    },
    [agendamentos, agora, interacao],
  );

  /** Que coluna e que minuto estão sob um ponto da tela. */
  const propostaSobPonto = React.useCallback(
    (id: string, clientX: number, clientYDoTopo: number): PropostaDeRemarcacao | null => {
      const corpos = Array.from(
        gradeRef.current?.querySelectorAll<HTMLElement>("[data-corpo-do-dia]") ?? [],
      );
      if (corpos.length === 0) return null;
      // A coluna sob o ponteiro; fora de todas, a mais próxima na horizontal —
      // arrastar até a beirada não deve fazer a proposta desaparecer.
      const escolhido =
        corpos.find((el) => {
          const r = el.getBoundingClientRect();
          return clientX >= r.left && clientX <= r.right;
        }) ??
        corpos.reduce((melhor, el) => {
          const d = (r: DOMRect) => Math.min(Math.abs(clientX - r.left), Math.abs(clientX - r.right));
          return d(el.getBoundingClientRect()) < d(melhor.getBoundingClientRect()) ? el : melhor;
        });
      const chave = escolhido.dataset.corpoDoDia;
      if (!chave) return null;
      const r = escolhido.getBoundingClientRect();
      const bruto = minutoSobY({
        y: clientYDoTopo - r.top,
        alturaDaHoraPx: ALTURA_DA_HORA,
        primeiraHora: PRIMEIRA_HORA,
      });
      return montarProposta(
        id,
        chave,
        Math.min(Math.max(bruto, limites.primeiro), limites.ultimo - PASSO_DA_CELULA_MIN),
      );
    },
    [montarProposta, limites.primeiro, limites.ultimo],
  );

  const aoApontar = React.useCallback(
    (e: React.PointerEvent<HTMLButtonElement>, a: Agendamento) => {
      if (e.button !== 0 || !interacao?.onArrastarPara) return;
      const el = e.currentTarget;
      const g = {
        id: a.id,
        x0: e.clientX,
        y0: e.clientY,
        deslocamentoNoCard: e.clientY - el.getBoundingClientRect().top,
        moveu: false,
      };
      gesto.current = g;
      el.setPointerCapture(e.pointerId);

      const mover = (ev: PointerEvent) => {
        // Limiar de 4px: sem ele, o tremor de um clique comum já criaria uma
        // proposta e o card abriria a confirmação em vez do compromisso.
        if (!g.moveu && Math.abs(ev.clientY - g.y0) < 4 && Math.abs(ev.clientX - g.x0) < 4) return;
        g.moveu = true;
        setProposta(propostaSobPonto(g.id, ev.clientX, ev.clientY - g.deslocamentoNoCard));
      };
      const soltar = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", mover);
        window.removeEventListener("pointerup", soltar);
        window.removeEventListener("pointercancel", soltar);
        const houve = g.moveu;
        const p = houve ? propostaSobPonto(g.id, ev.clientX, ev.clientY - g.deslocamentoNoCard) : null;
        setProposta(null);
        // A ref só zera no tique seguinte: o `click` que o `pointerup` dispara
        // ainda não aconteceu, e é ele que precisa consultar `moveu()`.
        setTimeout(() => {
          gesto.current = null;
        }, 0);
        if (p) interacao.onArrastarPara?.({ id: g.id, instante: p.instante, razao: p.razao });
      };
      window.addEventListener("pointermove", mover);
      window.addEventListener("pointerup", soltar);
      window.addEventListener("pointercancel", soltar);
    },
    [interacao, propostaSobPonto],
  );

  /**
   * O MESMO gesto, pelo teclado — `Alt` + setas move a proposta, `Enter`
   * consuma, `Esc` desfaz.
   *
   * `Alt` e não a seta pura porque a grade rola: seta pura dentro de um
   * contêiner com rolagem é a rolagem, e roubá-la quebraria a navegação de quem
   * usa só o teclado para chegar ao card seguinte.
   */
  const aoTeclar = React.useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, a: Agendamento) => {
      if (!interacao?.onArrastarPara) return;
      const atual = proposta?.id === a.id ? proposta : null;
      const comeca = new Date(a.comeca);

      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const dia = atual?.dia ?? chaveDoDia(comeca);
        const base = atual ? atual.minutoBruto : comeca.getHours() * 60 + comeca.getMinutes();
        const direcao = e.key === "ArrowDown" ? 1 : -1;
        // A seta salta de VAGA em VAGA, não de meia em meia hora: é a
        // informação que o arraste dá pelos olhos e o teclado não tem como ver.
        // Sem vaga adiante, ela ainda anda — e o fantasma inválido é o que diz
        // que não há para onde ir, em vez de a tecla ficar muda.
        const vizinho = publicadoVizinho(interacao.horariosPorDia[dia] ?? [], base, direcao);
        const alvo = vizinho
          ? new Date(vizinho.instante).getHours() * 60 + new Date(vizinho.instante).getMinutes()
          : base + direcao * PASSO_DA_CELULA_MIN;
        setProposta(
          montarProposta(
            a.id,
            dia,
            Math.min(Math.max(alvo, limites.primeiro), limites.ultimo - PASSO_DA_CELULA_MIN),
          ),
        );
        return;
      }
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        const base = atual ? atual.minutoBruto : comeca.getHours() * 60 + comeca.getMinutes();
        const diaAtual = new Date(`${atual?.dia ?? chaveDoDia(comeca)}T12:00:00`);
        setProposta(
          montarProposta(a.id, chaveDoDia(addDays(diaAtual, e.key === "ArrowRight" ? 1 : -1)), base),
        );
        return;
      }
      if (atual && e.key === "Enter") {
        // `preventDefault` porque `Enter` num `<button>` vira `click`, e o
        // clique abriria o painel por cima da confirmação que estamos pedindo.
        e.preventDefault();
        setProposta(null);
        interacao.onArrastarPara?.({ id: a.id, instante: atual.instante, razao: atual.razao });
        return;
      }
      if (atual && e.key === "Escape") {
        e.preventDefault();
        setProposta(null);
      }
    },
    [interacao, proposta, montarProposta, limites.primeiro, limites.ultimo],
  );

  const arrasteDoCard = interacao?.onArrastarPara
    ? { aoApontar, aoTeclar, moveu: () => gesto.current?.moveu === true }
    : undefined;

  return (
    <div
      data-testid="grade-da-agenda"
      data-visao={visao}
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-surface",
        className,
      )}
    >
      {visao === "mes" ? (
        <VisaoDeMes ancora={ancora} agora={agora} agendamentos={agendamentos} pessoas={pessoas} />
      ) : (
        // A rolagem mora AQUI dentro, e não na página: `html, body` têm
        // `overflow-x: hidden` no globals.css, então uma grade que estourasse a
        // largura simplesmente sumiria pela direita, sem barra para trazê-la de volta.
        <div ref={gradeRef} className="flex min-h-0 flex-1 overflow-auto">
          <ColunaDeHoras />
          <div className="flex min-w-0 flex-1">
            {dias.map((d) => (
              <ColunaDeDia
                key={d.toISOString()}
                dia={d}
                agora={agora}
                agendamentos={agendamentos}
                pessoas={pessoas}
                onAbrir={onAbrirAgendamento}
                destacado={visao === "semana" && isSameDay(d, agora)}
                interacao={interacao}
                proposta={proposta}
                arrasteDoCard={arrasteDoCard}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export const ALTURA_DA_HORA_PX = ALTURA_DA_HORA;
export const JANELA_DA_GRADE = { primeira: PRIMEIRA_HORA, ultima: ULTIMA_HORA };
