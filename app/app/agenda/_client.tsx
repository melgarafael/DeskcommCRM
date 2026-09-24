"use client";

import { useRouter } from "next/navigation";

import { EntradaDaAgenda } from "@/components/agenda/EntradaDaAgenda";
import { EnderecoDaMarcacao } from "@/components/agenda/EnderecoDaMarcacao";
import { VinculoDaMarcacao } from "@/components/agenda/VinculoDaMarcacao";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import { useT } from "@/hooks/i18n/useT";

import { addDays, endOfMonth, format, startOfDay, startOfMonth, startOfWeek } from "date-fns";
import * as React from "react";

import { AvisoDaConexaoGoogle } from "./_components/AvisoDaConexaoGoogle";
import { CartaoDaConexaoGoogle } from "./_components/CartaoDaConexaoGoogle";

import { AgendaInterativa } from "@/components/agenda/AgendaInterativa";
import { FiltroDePessoas } from "@/components/agenda/FiltroDePessoas";
import { HistoricoDaAgenda } from "@/components/agenda/HistoricoDaAgenda";
import type { Agendamento, HorarioLivre, VisaoDaAgenda } from "@/components/agenda/tipos";
import { EmptyAgenda } from "@/components/empty";
import { rotuloDoLocal } from "@/lib/agenda/locais";
import { ancoraAoFecharPainel } from "@/lib/agenda/ancora-depois-de-marcar";
import { ancoraLocalDoDia } from "@/lib/agenda/semana-semente";
import { janelaDoMesVisivel } from "@/lib/agenda/janela-do-mes-visivel";
import { resolverResponsavelDoPainel } from "@/lib/agenda/responsavel-do-painel";
import { useVinculoDaMarcacao } from "@/lib/agenda/vinculo-da-marcacao";
import { Button } from "@/components/ui/button";
import { PainelDeMarcacao } from "@/components/agenda/PainelDeMarcacao";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useAgendamentos } from "@/hooks/agenda/useAgendamentos";
import { useHorariosLivres } from "@/hooks/agenda/useHorariosLivres";
import { useMarcarAgendamento } from "@/hooks/agenda/useMarcarAgendamento";
import {
  useCancelarAgendamento,
  useRegistrarDesfecho,
  useRemarcarAgendamento,
} from "@/hooks/agenda/useRemarcarAgendamento";
import { usePessoasDaAgenda } from "@/hooks/agenda/usePessoasDaAgenda";
import { CalendarPlus, CaretLeft, CaretRight } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

const VISOES: Array<{ id: VisaoDaAgenda; rotulo: string }> = [
  { id: "dia", rotulo: "Dia" },
  { id: "semana", rotulo: "Semana" },
  { id: "mes", rotulo: "Mês" },
];

/**
 * A tela da Agenda.
 *
 * ⚠️ SEM DADO NENHUM até a frente 1 (API + motor) integrar. A tela cai no
 * estado vazio de propósito, e a razão é de SEGURANÇA PERCEBIDA, não de
 * pureza:
 *
 * dado falso PLAUSÍVEL numa tela real de produto multi-tenant é
 * indistinguível de VAZAMENTO. "Ana Prado", "Marina Alves", "Visita ao imóvel"
 * são nomes brasileiros críveis nos nichos que este produto atende — e o
 * relato que chega de quem vê isso não é "tem dado de teste na tela", é
 * "estou vendo paciente de outra clínica na minha agenda". O time então queima
 * horas caçando um furo de RLS que não existe. Achado do QAVivo, decisão 18.
 *
 * Repare na inversão, porque ela é o ponto: os MESMOS nomes são ACERTO na
 * vitrine (`/vitrine-agenda`), onde tornam o desenho julgável, e o pior
 * formato possível aqui. Mesmo dado, valor oposto conforme onde está pendurado.
 *
 * E o vazio é mais VERDADEIRO: numa instalação nova a agenda está vazia mesmo.
 * De quebra exercita o estado vazio, que é onde mora a primeira impressão.
 *
 * `data-fonte` declara isso no DOM para ser verificável de fora — e
 * `tests/unit/telas-sem-dado-de-mentira.test.ts` impede que alguém religue os
 * imports sem querer.
 */
export function AgendaClient({
  fusoDeApresentacao,
  hojeNaOrganizacao,
  usuarioId,
  googleConfigurado,
  contaConectada,
  enderecoDeRetorno,
  faltaNoGoogle,
  linkDeConfiguracaoDoGoogle,
  tiposIniciais,
  agendamentosIniciais,
  podeMarcar,
}: {
  fusoDeApresentacao: string | null;
  /**
   * A data de HOJE no fuso da ORGANIZAÇÃO, resolvida pelo servidor
   * (`yyyy-MM-dd`). É a mesma que gerou a semente de compromissos.
   */
  hojeNaOrganizacao: string;
  /** Id de quem está logado — a única fonte para o rótulo "Você". */
  usuarioId: string;
  googleConfigurado: boolean;
  contaConectada?: string | null;
  enderecoDeRetorno?: string;
  faltaNoGoogle: string[];
  /** Preenchido só para quem administra a instalação — ver `page.tsx`. */
  linkDeConfiguracaoDoGoogle?: string;
  /** Tipos ativos, resolvidos no servidor: não há rota que os liste ainda. */
  tiposIniciais: Array<{
    id: string;
    nome: string;
    duracaoMin: number;
    donoId: string | null;
    localKind: string | null;
    localDetalhes: string | null;
  }>;
  /** A semana corrente, resolvida no servidor: `GET /agendamentos` não existe. */
  agendamentosIniciais: Agendamento[];
  /**
   * Quem está logado pode MARCAR — o mesmo piso da rota (`requireRole("agent")`
   * em `app/api/v1/agenda/agendamentos/route.ts`).
   *
   * É a MESMA porta, com o MESMO piso, em todos os gestos de escrita desta tela:
   * o botão "Novo agendamento", o clique num bloco livre da grade, o encaixe
   * ("Outro horário") do painel e o "Marcar compromisso" que chega por
   * `?contato=`. Oferecer qualquer uma delas a quem só lê é oferecer um 403 —
   * com a recusa chegando DEPOIS do gesto, que é o defeito que este nome veio
   * fechar. Esconder aqui é cortesia: quem decide segue sendo a rota.
   */
  podeMarcar: boolean;
}) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const router = useRouter();
  const [marcando, setMarcando] = React.useState(false);
  // O compromisso criado NESTA abertura do painel. Serve para levar a grade até
  // ele quando o painel fechar por qualquer caminho — ver `ancoraAoFecharPainel`.
  const [marcadoEm, setMarcadoEm] = React.useState<string | null>(null);
  // QUEM SERÁ ATENDIDO. A regra inteira — e por que ela não é "limpar ao
  // fechar" — está em `lib/agenda/vinculo-da-marcacao.ts`. Em uma frase: o
  // painel abre com o vínculo que a ROTA carrega (`?contato=…&conversa=…`, o
  // link "Marcar compromisso" do Inbox), e o que a pessoa escolhe dentro dele
  // vive só enquanto ele está aberto.
  const {
    vinculo,
    registrarRota: registrarVinculoDaRota,
    reiniciar: reiniciarVinculo,
    escolher: escolherVinculo,
  } = useVinculoDaMarcacao();
  const contactId = vinculo.contact;
  const conversationId = vinculo.conversation;
  const onContext = React.useCallback(
    (contact: string, conversation: string) => {
      // Só abre sozinho quando a rota TROUXE um cliente: a chamada sem cliente
      // é a que avisa que a página deixou de ter contexto, e ela não é um
      // pedido para marcar nada.
      const trouxeCliente = registrarVinculoDaRota({ contact, conversation });
      // TERCEIRA PORTA da mesma escrita: o "Marcar compromisso" do Inbox chega
      // por aqui e abriria o painel. Para quem só lê, o vínculo até pode ser
      // registrado — é estado inerte, sem superfície — mas o painel NÃO abre:
      // abri-lo seria a mesma promessa que o botão e a grade fariam, com o 403
      // chegando no fim do gesto.
      if (podeMarcar && trouxeCliente) setMarcando(true);
    },
    [podeMarcar, registrarVinculoDaRota],
  );
  /** Abrir o painel do zero: o vínculo volta a ser o da rota, nunca o da vez anterior. */
  const abrirMarcacao = React.useCallback(() => {
    reiniciarVinculo();
    setMarcando(true);
  }, [reiniciarVinculo]);
  // O horário que veio de um CLIQUE NA GRADE. Preenchido, o painel abre já em
  // "confirmando" naquele instante; vazio, ele abre pedindo o dia, como sempre.
  const [horarioEscolhido, setHorarioEscolhido] = React.useState<HorarioLivre | null>(null);
  // REMARCAR reusa o painel de marcação: escolher horário novo é o MESMO gesto
  // de escolher o primeiro, e uma segunda tela para a mesma pergunta seria duas
  // coisas para manter em sincronia. Quando `remarcandoId` está preenchido, a
  // confirmação vira PATCH em vez de POST.
  const [remarcandoId, setRemarcandoId] = React.useState<string | null>(null);
  // CANCELAR pede motivo, e o motivo é obrigatório na rota. Não é burocracia: é
  // o que a equipe lê ao ver o horário vago.
  const [cancelandoId, setCancelandoId] = React.useState<string | null>(null);
  const [motivo, setMotivo] = React.useState("");
  // O CONVIDADO, opcional. O e-mail da ficha do cliente já vai no convite
  // do Google quando existe. Este campo é a outra pessoa (acompanhante).
  // Vazio = só o cliente (se tiver e-mail) ou só a agenda do atendente.
  const [emailConvidado, setEmailConvidado] = React.useState("");
  const emailConvidadoLimpo = emailConvidado.trim();
  // A MESMA pergunta que a rota faz, feita aqui só para não gastar um 422 com
  // uma letra faltando no domínio. A rota continua sendo a dona da recusa — esta
  // checagem é conveniência, não autoridade, e por isso é deliberadamente frouxa
  // (o e-mail de verdade se prova entregando, não com regex).
  const emailConvidadoInvalido =
    emailConvidadoLimpo.length > 0 && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailConvidadoLimpo);
  // `null` = ainda não mexeu: o campo mostra o local do TIPO. String (mesmo
  // vazia) = a pessoa editou, e o tipo novo não pode devolver o que ela apagou.
  const [enderecoEditado, setEnderecoEditado] = React.useState<string | null>(null);
  const [observacao, setObservacao] = React.useState("");
  const marcar = useMarcarAgendamento();
  const remarcar = useRemarcarAgendamento();
  const cancelar = useCancelarAgendamento();
  const desfecho = useRegistrarDesfecho();
  // ⚠️ ERA `tiposIniciais[0] ?? null` — uma constante, sem seletor em lugar
  // nenhum. `page.tsx` ordena os tipos por NOME, então a tela marcava sempre o
  // primeiro em ordem alfabética e não havia como marcar outro: numa org com
  // "Atendimento", "Consulta", "Reunião", só "Atendimento" era alcançável pela
  // tela. As categorias existiam no banco, no seed e na API — e a tela oferecia
  // uma. Achado escrevendo a spec de marcar, não lendo o código.
  const [tipoId, setTipoId] = React.useState<string | null>(() => tiposIniciais[0]?.id ?? null);
  const tipo = tiposIniciais.find((t) => t.id === tipoId) ?? tiposIniciais[0] ?? null;
  const endereco = enderecoEditado ?? tipo?.localDetalhes ?? "";
  const [visao, setVisao] = React.useState<VisaoDaAgenda>("semana");
  /**
   * No CELULAR a agenda abre no DIA, não na semana.
   *
   * Duas razões, e a segunda é consequência da primeira. A semana em 360px é
   * ilegível — por isso a grade esconde as outras colunas abaixo de `md`. Mas o
   * passo de navegação da semana é de SETE dias: quem visse um dia só e tocasse
   * em avançar pularia a semana inteira, sem alcançar os outros seis. Abrindo no
   * dia, o passo é 1 e cada toque anda um dia.
   *
   * Em `useEffect`, e não no estado inicial, porque `window` não existe no
   * servidor: decidir a visão na primeira renderização faria o HTML do servidor
   * discordar do cliente. Roda uma vez, na montagem, então não desfaz escolha
   * de quem trocou a visão depois.
   */
  React.useEffect(() => {
    // O aviso da regra é justo em geral; aqui trocar a visão É o ponto do efeito.
    // A largura só existe no cliente, e decidir antes divergiria da hidratação.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (window.matchMedia("(max-width: 767px)").matches) setVisao("dia");
  }, []);
  const [isolada, setIsolada] = React.useState<string | null>(null);
  /**
   * A ÂNCORA NASCE DO RELÓGIO DA ORGANIZAÇÃO, não do navegador.
   *
   * Era `useState(() => new Date())`. O servidor desenha a semana no fuso da
   * organização (decisão do dono em #1350) e o cliente recalculava no fuso do
   * NAVEGADOR: das 21h de sábado à meia-noite em São Paulo, com servidor em UTC,
   * os dois discordavam e a tela piscava a semana seguinte — e, para quem abre o
   * CRM fora do fuso da empresa, discordava sempre.
   *
   * O que atravessa a fronteira é a DATA (`hojeNaOrganizacao`), nunca o
   * instante: `domingo 00:00` em São Paulo é `sábado 22:00` em UTC-5, e
   * `startOfWeek` sobre esse instante, em hora local, cairia na semana anterior.
   * `ancoraLocalDoDia` transforma a data numa `Date` local ao meio-dia — a doze
   * horas de qualquer borda de horário de verão.
   */
  const [ancora, setAncora] = React.useState(() => ancoraLocalDoDia(hojeNaOrganizacao));

  // AS PESSOAS SÃO REAIS, e vêm da lista MÍNIMA da agenda — `/api/v1/agenda/pessoas`
  // (`ROTA_DA_LISTA_DE_PESSOAS`, `lib/agenda/lista-de-pessoas.ts`), papel mínimo
  // `agent` e só id/nome. Com a trilha de cor derivada do `user_id`.
  //
  // ⚠️ ESTA LINHA DIZIA `/api/v1/team`, E A FRASE MENTIA. Ela descrevia o estado
  // de antes do item 1 da issue 896, quando a agenda pedia a equipe à rota de
  // administração — que é `manager+` e devolve e-mail e último acesso — e o
  // Atendente levava 403 só por abrir a tela (virava aviso de falta de
  // permissão sobre uma grade que continuava lá). A rota mínima consertou isso;
  // a prosa ficou. Medido nesta rodada:
  //   grep -rn "api/v1/team" app/app/agenda/ | grep -v "\(//\|\*\)"  → vazio
  // É por isso que a frase foi reescrita em vez de apagada: quem lê o código
  // para entender o 403 do Atendente precisa saber que ele JÁ não existe, e um
  // comentário que afirma o contrário é o defeito de novo.
  const { data: pessoas = [] } = usePessoasDaAgenda();

  // A JANELA ACOMPANHA O MÊS QUE O PAINEL MOSTRA.
  //
  // ⚠️ Isto era `hoje + 30 dias`, fixo na abertura. O mês visível era estado
  // LOCAL do painel, a consulta não ia junto, e "Próximo mês" desligava assim
  // que acabavam os dias já pedidos — daqui a dois meses o calendário parava
  // e a ocupação do Google acusava período sem cobertura, mesmo com a janela
  // de agendamento do tipo (60 dias por padrão, até 365) ainda valendo.
  //
  // A estabilidade continua: a chave do React Query só muda quando o mês, o
  // tipo ou a abertura mudam — nunca a cada render. `new Date()` aqui corre
  // uma vez por essas mudanças, não no corpo.
  // Mesmo relógio da grade: o mini-calendário abre no mês da ORGANIZAÇÃO.
  const [mesDoPainel, setMesDoPainel] = React.useState(() =>
    startOfMonth(ancoraLocalDoDia(hojeNaOrganizacao)),
  );
  const onMesVisivel = React.useCallback((mes: Date) => {
    const proximo = startOfMonth(mes);
    setMesDoPainel((atual) => (atual.getTime() === proximo.getTime() ? atual : proximo));
  }, []);
  // Reabrir o painel ou trocar o tipo pede `agora` novo. O relógio não entra
  // na chave do React Query por milissegundo — só quando estes mudam.
  const agoraDaAbertura = React.useMemo(
    () => new Date(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `new Date()` é o ponto: o valor só pode mudar quando a abertura ou o tipo mudam.
    [marcando, tipo?.id],
  );
  const janelaDeBusca = React.useMemo(() => {
    const { de, ate } = janelaDoMesVisivel(mesDoPainel, agoraDaAbertura);
    return { de: de.toISOString(), ate: ate.toISOString() };
  }, [mesDoPainel, agoraDaAbertura]);

  // Os horários vêm da rota real — a mesma que a IA usa, então tela e agente
  // oferecem exatamente os mesmos horários. Só consulta quando o painel abre.
  // `isError` junto, e não só `data`: sem ele a tela MENTE por default. O
  // `publicouHorarios={horarios?.publicou_horarios ?? true}` abaixo transforma
  // "a consulta falhou" em "publicou, só não tem vaga" — dias travados e aviso
  // nenhum, que é exatamente o que uma instalação fresca produz (a rota devolve
  // 422 porque ninguém está em `attendant_availability`).
  const { data: horarios, isError: horariosFalharam } = useHorariosLivres(
    marcando && tipo
      ? { event_type_id: tipo.id, de: janelaDeBusca.de, ate: janelaDeBusca.ate }
      : null,
  );

  const horariosPorDia = React.useMemo(() => {
    const mapa: Record<string, Array<{ instante: string; rotulo: string }>> = {};
    for (const s of horarios?.slots ?? []) {
      const d = new Date(s.inicio);
      const chave = format(d, "yyyy-MM-dd");
      (mapa[chave] ??= []).push({ instante: s.inicio, rotulo: format(d, "HH:mm") });
    }
    return mapa;
  }, [horarios]);

  // OS AGENDAMENTOS SÃO REAIS, e agora TAMBÉM se atualizam sem recarregar.
  //
  // ⚠️ O comentário que estava aqui dizia que `GET /api/v1/agenda/agendamentos`
  // "ainda não existe (a rota tem POST, PATCH e DELETE)". Era verdade quando foi
  // escrito e VENCEU: `grep -n "^export async function" app/api/v1/agenda/agendamentos/route.ts`
  // devolve GET:95. A prosa descrevia um estado, o estado mudou, e a frase ficou
  // — junto com o `useAgendamentos`, que existia inteiro e não era montado por
  // ninguém (1 ocorrência no repo: a própria definição).
  //
  // A prop do RSC segue sendo a PRIMEIRA pintura (sem piscar, sem spinner) e o
  // hook assume dali: `useMarcarAgendamento` já invalida `["agenda"]`, então
  // marcar pela tela repinta a grade sozinho.
  // O recorte acompanha o que a grade DESENHA — mesma visão, mesma âncora.
  // Instante ISO, nunca o filtro `dia`: o cabeçalho do hook mede por que
  // (`dia=` corta em UTC e some com o compromisso das 22h no fuso de São Paulo).
  const recorteDaGrade = React.useMemo(() => {
    const inicio =
      visao === "mes"
        ? startOfMonth(ancora)
        : visao === "semana"
          ? startOfWeek(ancora, { weekStartsOn: 0 })
          : startOfDay(ancora);
    const fim =
      visao === "mes"
        ? addDays(endOfMonth(ancora), 1)
        : addDays(inicio, visao === "semana" ? 7 : 1);
    return { de: inicio.toISOString(), ate: fim.toISOString() };
  }, [visao, ancora]);

  // A janela que o SERVIDOR pintou. Sem esta comparação, navegar para outra
  // semana mostraria os compromissos DESTA por um instante — o fallback estaria
  // respondendo a uma pergunta que ninguém fez. Cair para lista vazia é pior de
  // aparência e melhor de verdade: a grade fica vazia por um piscar, em vez de
  // mostrar compromisso no dia errado.
  // ⚠️ `useState` com inicializador, e NÃO `useRef(...).current`.
  //
  // A intenção é a mesma — congelar a janela da primeira pintura —, mas ler
  // `.current` durante o render é violação de regra do React, e o `pnpm lint`
  // reprova com "Cannot access refs during render". Foi o CI que me disse: eu
  // tinha rodado typecheck e vitest e NÃO tinha rodado lint. O `verify` cai nos
  // três, e eu só olhei dois.
  //
  // `useState(() => x)[0]` faz o mesmo congelamento sem tocar em ref no render.
  const [recorteDoServidor] = React.useState(() => recorteDaGrade);
  const naJanelaDoServidor =
    recorteDaGrade.de === recorteDoServidor.de && recorteDaGrade.ate === recorteDoServidor.ate;

  const { data: agendamentosVivos } = useAgendamentos(recorteDaGrade);
  const todos: Agendamento[] =
    agendamentosVivos ?? (naJanelaDoServidor ? agendamentosIniciais : []);

  const agendamentos = React.useMemo(
    () => (isolada === null ? todos : todos.filter((a) => a.responsavelId === isolada)),
    [isolada, todos],
  );

  // A GRADE não mostra cancelado — ele fica só na aba "Cancelados" do
  // histórico, que lê `agendamentos` (cheio) e o separa sozinha em `separar()`.
  // Mesma fonte, dois recortes: a grade responde "o que está de pé", o
  // histórico responde "o que aconteceu", cancelado incluso.
  const agendamentosDaGrade = React.useMemo(
    () => agendamentos.filter((a) => a.situacao !== "cancelled"),
    [agendamentos],
  );

  /**
   * O que é ACIONÁVEL — o que a lista "Próximos" pode oferecer botão para fazer.
   *
   * Ocupação vinda do Google fica de fora: ela é bloco de terceiro, o id é de
   * `calendar_external_events`, e as rotas de remarcar/cancelar procuram em
   * `calendar_appointments`. Ver o comentário longo no `HistoricoDaAgenda`
   * abaixo, com o 404 medido.
   *
   * A GRADE recebe `agendamentosDaGrade` (tudo menos cancelado) — é lá que a ocupação
   * precisa aparecer, e é lá que ela já é desenhada inerte.
   */
  const agendamentosAcionaveis = React.useMemo(
    () => agendamentos.filter((a) => a.origem !== "google_sync"),
    [agendamentos],
  );

  const passo = visao === "mes" ? 30 : visao === "semana" ? 7 : 1;
  // O PADRÃO de formato também muda de idioma, não só o locale: em português
  // "d 'de' MMMM" tem a preposição escrita à mão dentro do padrão, e em
  // espanhol ela também é "de" — mas quem garante isso é a chave no dicionário,
  // não a coincidência. Passando o padrão por `t()`, um idioma que ordene a
  // data de outro jeito não precisa de código novo aqui.
  const periodo =
    visao === "mes"
      ? format(ancora, t("MMMM 'de' yyyy"), { locale: localeDaData })
      : visao === "semana"
        ? `${format(startOfWeek(ancora, { weekStartsOn: 0 }), t("d 'de' MMM"), { locale: localeDaData })} — ${format(addDays(startOfWeek(ancora, { weekStartsOn: 0 }), 6), t("d 'de' MMM"), { locale: localeDaData })}`
        : format(ancora, t("EEEE, d 'de' MMMM"), { locale: localeDaData });

  return (
    <div
      data-testid="tela-agenda"
      data-fonte={agendamentosIniciais.length > 0 ? "api" : "api-sem-dado"}
      data-fuso={fusoDeApresentacao ?? "organizacao"}
      className="flex h-full flex-col gap-4 p-6"
    >
      {/*
        Em Suspense porque `useSearchParams` obriga: sem a fronteira, o Next
        reprova o build da rota. Fallback nulo porque a ausência do aviso é o
        estado normal — quem chega pela navegação não tem query nenhuma.
      */}
      <React.Suspense fallback={null}>
        <AvisoDaConexaoGoogle />
        <EntradaDaAgenda onContext={onContext} />
      </React.Suspense>

      <CartaoDaConexaoGoogle
        configurado={googleConfigurado}
        falta={faltaNoGoogle}
        linkDeConfiguracao={linkDeConfiguracaoDoGoogle}
        contaConectada={contaConectada}
        enderecoDeRetorno={enderecoDeRetorno}
      />

      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{t("Agenda")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("O que está marcado, com quem, e quem atende — seu e da equipe.")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* "Hoje" é o hoje DA ORGANIZAÇÃO. Com `new Date()` o botão desfazia a
              âncora do servidor e devolvia a semana do navegador — o defeito que
              a tela acabou de fechar, a um clique de distância. */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAncora(ancoraLocalDoDia(hojeNaOrganizacao))}
          >
            {t("Hoje")}
          </Button>
          {/*
            DESABILITADO COM O MOTIVO À VISTA, e não ligado a um `onClick` vazio.
            Enquanto a frente 1 não expõe `/api/v1/agenda` não há o que marcar, e
            um botão primário, com cor de ação e sem `disabled`, que não faz nada
            ao clique é pior do que não existir: quem clica conclui que o produto
            está quebrado e não tem o que reportar além de "não abre". É o
            anti-pattern de controle decorativo, e esta base já pagou por ele.

            O motivo vai em texto ao lado, não só no `title`: atributo de
            hover não existe para quem usa toque, que é o dono de clínica no
            celular.
          */}
          {podeMarcar && !tipo && (
            // Sem NENHUM tipo de agendamento cadastrado não há o que marcar — e
            // isto é diferente de "a API não existe": a ação faz sentido, falta
            // configuração. Por isso o motivo à vista, e não um botão mudo.
            //
            // `podeMarcar` vem ANTES de `!tipo`, e a ordem é o ponto: para quem
            // só lê não existe botão desabilitado a explicar, então o motivo
            // seria conversa sobre um gesto que não está na tela dele.
            <span
              data-testid="motivo-novo-agendamento"
              className="hidden text-xs text-text-subtle sm:inline"
            >
              {t("Cadastre um tipo de agendamento para começar")}
            </span>
          )}
          {/* PRIMEIRA PORTA da escrita nesta tela. Quem só lê não vê o botão: o
              403 da rota nunca chega a ser oferecido, e o rótulo segue igual (a
              spec e2e o acha por papel/rótulo, e não muda). */}
          {podeMarcar && (
            <Button
              size="sm"
              disabled={!tipo}
              // `data-testid` porque o RÓTULO deixou de ser estável: até este PR
              // ele era literal, e `agenda-escopo-da-organizacao.spec.ts` o acha
              // por `getByRole("button", { name: /Novo agendamento/i })`. Com o
              // texto passando por `t()`, casar por rótulo passa a depender do
              // idioma da conta de teste — hoje passa porque a conta nasce em
              // português, mas é acoplamento que não precisa existir. O testid é
              // o caminho estável; trocar a spec para usá-lo é decisão de quem a
              // escreveu, e vai anotada no PR.
              data-testid="novo-agendamento"
              title={tipo ? undefined : t("Cadastre um tipo de agendamento para começar")}
              onClick={abrirMarcacao}
            >
              <CalendarPlus size={16} weight="bold" aria-hidden />
              <span>{t("Novo agendamento")}</span>
            </Button>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("Período anterior")}
              data-testid="periodo-anterior"
              onClick={() => setAncora((d) => addDays(d, -passo))}
            >
              <CaretLeft size={16} weight="bold" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("Próximo período")}
              data-testid="periodo-seguinte"
              onClick={() => setAncora((d) => addDays(d, passo))}
            >
              <CaretRight size={16} weight="bold" aria-hidden />
            </Button>
          </div>
          {/*
            `first-letter:uppercase` e NÃO `capitalize`: o `capitalize` do CSS
            maiúscula toda palavra, e o date-fns em pt-br devolve "23 de ago" —
            virava "23 De Ago". Preposição com maiúscula é o detalhe que faz o
            produto parecer traduzido em vez de escrito, e fica na primeira
            linha abaixo do título.
          */}
          <span
            data-testid="periodo"
            className="truncate text-sm font-semibold first-letter:uppercase"
          >
            {periodo}
          </span>
        </div>

        {/* `flex-wrap` pelo mesmo motivo da vitrine, e aqui é conserto de CLASSE e
            não de instância: esta linha passou no gate por sorte de largura (a
            organização de teste tem cinco pessoas), não por estar certa. Com mais
            gente no filtro, ela estoura igual — e o `overflow-x: hidden` corta o
            alternador de visão em silêncio. */}
        <div className="flex flex-wrap items-center gap-3">
          <FiltroDePessoas pessoas={pessoas} isolada={isolada} onIsolar={setIsolada} />
          <div
            data-testid="alternador-de-visao"
            className="flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5"
          >
            {VISOES.map((v) => (
              <button
                key={v.id}
                type="button"
                data-testid={`visao-${v.id}`}
                aria-pressed={visao === v.id}
                onClick={() => setVisao(v.id)}
                className={cn(
                  "rounded-sm px-2.5 py-1 text-xs transition-colors duration-fast ease-out",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500",
                  visao === v.id
                    ? "bg-accent font-semibold text-accent-foreground"
                    : "text-text-muted hover:bg-surface-elevated hover:text-text",
                )}
              >
                {t(v.rotulo)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/*
        O HISTÓRICO na tela do produto, e não só na vitrine. Ele aparece mesmo
        sem dado: as quatro abas com contador zero respondem "não há nada" sem
        gastar um clique, e some-lo faria a tela parecer menor do que é.
      */}
      <Sheet
        open={marcando}
        onOpenChange={(aberto) => {
          setMarcando(aberto);
          // Fechar sem confirmar volta ao modo normal — senão o próximo "Novo
          // agendamento" remarcaria o compromisso anterior em silêncio. O
          // horário vindo da grade some pela mesma razão: abrir o painel pelo
          // botão depois de fechar um bloco reabriria no horário do bloco.
          if (!aberto) {
            setRemarcandoId(null);
            setHorarioEscolhido(null);
            // Pelo mesmo motivo das duas linhas acima: um convidado digitado e
            // não usado reapareceria na PRÓXIMA marcação, que é de outro
            // cliente — convite para a pessoa errada, sem ninguém ter pedido.
            setEmailConvidado("");
            setEnderecoEditado(null);
            setObservacao("");
            // E o próprio cliente, que é o pior dos quatro a sobrar: medido numa
            // instalação real em 2026-09-12, "Novo agendamento" abriu com um
            // contato JÁ selecionado, herdado de uma abertura anterior feita a
            // partir da conversa dele (`onContext` preenche os dois). Quem não
            // reparasse marcaria o compromisso no nome de outra pessoa — e o
            // campo parece preenchido de propósito, então não há o que estranhar.
            //
            // ⚠️ MAS NÃO É `setContactId("")`, e o `e2e` mediu a diferença:
            // limpar no fechamento apaga também o contexto que a CONVERSA
            // acabou de dar — `agenda-google-meet.spec.ts:196` e
            // `agenda-presenca-recuperacao.spec.ts:312` reprovaram com
            // `contact_id: null`, porque as duas fecham o painel só para
            // navegar a grade até a semana certa, como uma pessoa faz.
            //
            // `reiniciarVinculo()` devolve o vínculo da ROTA: vazio quando a
            // pessoa está na Agenda sem contexto (o defeito relatado), e o
            // cliente da conversa quando ela chegou pelo link do Inbox.
            reiniciarVinculo();
            // ⛔ E LEVAR A GRADE ATÉ O QUE ACABOU DE NASCER.
            //
            // "Ver na agenda" já fazia isto; fechar no X, clicar fora ou apertar
            // Esc, não — e a grade ficava na semana em que estava, sem o
            // compromisso recém-criado, que quase sempre é de outra semana.
            // ⚠️ O relato que puxou isto NÃO se confirmou (ver o módulo). O que
            // sustenta é a simetria com o caso do botão, esse sim relatado.
            const destino = ancoraAoFecharPainel(marcadoEm, startOfDay);
            if (destino) setAncora(destino);
            setMarcadoEm(null);
          }
        }}
      >
        {/*
          `lg:max-w-[1040px]` — o painel de marcar precisa de 980px para as três
          colunas (contexto 280 + calendário 420 + horários 280), e cabia num
          Sheet de 768px cortando 239px em silêncio.
          
          O `sm:max-w-3xl` fica para as telas menores DE PROPÓSITO: lá o painel
          empilha os horários sob o calendário, então 768px bastam e um Sheet
          maior só roubaria contexto da tela atrás.
        */}
        {/*
          O SHEET ROLA EM TODO BREAKPOINT — é o único rolador vertical do painel.

          Era `lg:overflow-hidden`, com o painel em `lg:flex-1` dividindo a
          altura do Sheet com o formulário acima dele. O formulário é
          `shrink-0` e cresceu (vínculo, tipos, convidado, endereço,
          observação): em janela larga e BAIXA ele come quase toda a altura, o
          painel fica com uma fresta de poucos pixels, e com a janela abaixo de
          ~560px o formulário sozinho passa da caixa — o `overflow-hidden`
          cortava horários e o botão Confirmar EM SILÊNCIO, sem barra.

          Agora o painel tem a altura do próprio conteúdo e quem rola é o Sheet.
          A lista de horários não depende disso: ela tem teto próprio
          (`lg:max-h` em `PainelDeMarcacao`) e rola sozinha.

          ⚠️ `lg:px-3` + `overflow-x-hidden`: em `lg` o painel mede ~982px. Com
          o `p-6` de fábrica, 1024px de janela − 1 de borda − 48 de padding − 15
          de barra vertical clássica = 960px, e o CSS computa `overflow-x:
          visible` como `auto` quando `overflow-y` não é `visible` — nasceria
          barra HORIZONTAL no limiar das três colunas. Com 12px de cada lado
          sobram 984px. O `overflow-x-hidden` é a trava para quando a barra for mais
          larga que 15px; a régua de largura em
          `tests/e2e/agenda-painel-cabe-na-tela.spec.ts` continua medindo o
          painel contra o Sheet, então um transbordo real ainda reprova.
        */}
        <SheetContent
          side="right"
          className="flex w-full flex-col overflow-x-hidden overflow-y-auto sm:max-w-3xl lg:max-w-[1040px] lg:px-3"
        >
          <SheetHeader>
            <SheetTitle>
              {remarcandoId ? t("Remarcar agendamento") : t("Novo agendamento")}
            </SheetTitle>
          </SheetHeader>
          <div className="grid shrink-0 gap-3 rounded-lg border p-3 lg:grid-cols-2">
            {!remarcandoId ? (
              <div className="lg:col-span-2">
              <VinculoDaMarcacao
                contactId={contactId}
                conversationId={conversationId}
                onChange={(contact, conversation) => escolherVinculo({ contact, conversation })}
              />
              </div>
            ) : null}
            {tiposIniciais.length > 1 && (
              <div className="lg:col-span-2" data-testid="tipos-de-agendamento">
                <p className="mb-2 text-sm font-medium">{t("Tipo de agendamento")}</p>
                <div className="flex flex-wrap gap-1.5">
                  {tiposIniciais.map((opcao) => (
                    <button
                      key={opcao.id}
                      type="button"
                      data-testid={`tipo-${opcao.id}`}
                      aria-pressed={opcao.id === tipo?.id}
                      onClick={() => {
                        setTipoId(opcao.id);
                        // Tipo novo, local novo — senão a Sala 2 do tipo anterior
                        // viaja para um atendimento online que não tem sala.
                        setEnderecoEditado(null);
                      }}
                      className={cn(
                        "rounded-full border px-3 py-1 text-xs transition-colors duration-fast",
                        opcao.id === tipo?.id
                          ? "border-transparent bg-accent text-accent-foreground"
                          : "border-border text-text-muted hover:border-border-strong hover:text-text",
                      )}
                    >
                      {opcao.nome}
                      <span className="ml-1 tabular-nums opacity-70">{opcao.duracaoMin}min</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/*
              O CONVIDADO — opcional. O e-mail da ficha do cliente já entra no
              convite do Google; este campo é para outra pessoa (acompanhante).
              Sem os dois, o evento nasce só na agenda do atendente — o lembrete
              do cliente segue no WhatsApp.

              Fica ACIMA do painel de horários de propósito: quem vai convidar
              alguém decide isso ANTES de escolher o horário, e um campo abaixo de
              uma lista rolável de horários é um campo que ninguém vê.
            */}
            <div>
              <label className="block" htmlFor="email-do-convidado">
                {t("E-mail do convidado")}{" "}
                <span className="font-normal opacity-70">({t("opcional")})</span>
              </label>
              <input
                id="email-do-convidado"
                data-testid="email-do-convidado"
                type="email"
                inputMode="email"
                autoComplete="off"
                value={emailConvidado}
                onChange={(e) => setEmailConvidado(e.target.value)}
                className={cn(
                  // `outline-hidden`, não `outline-none`: no Tailwind 4 os dois
                  // trocaram de significado, e o `outline-none` do v4 apaga o
                  // contorno que o modo de alto contraste do sistema usa.
                  "mt-1 w-full rounded-md border bg-surface p-2 outline-hidden",
                  emailConvidadoInvalido
                    ? "border-danger focus:border-danger"
                    : "border-border focus:border-border-strong",
                )}
                placeholder={t("cliente@empresa.com")}
                aria-invalid={emailConvidadoInvalido || undefined}
                aria-describedby="ajuda-do-convidado"
              />
              <p id="ajuda-do-convidado" className="mt-1 text-xs text-text-muted">
                {emailConvidadoInvalido
                  ? t("Endereço inválido — confira antes de marcar.")
                  : t(
                      "O cliente com e-mail na ficha já recebe o convite. Preencha só se quiser chamar mais alguém.",
                    )}
              </p>
            </div>
            {!remarcandoId ? (
              <>
                <EnderecoDaMarcacao
                  value={endereco}
                  onChange={setEnderecoEditado}
                />
                <div>
                  <label className="block" htmlFor="observacao-do-compromisso">
                    {t("Observação")}{" "}
                    <span className="font-normal opacity-70">({t("opcional")})</span>
                  </label>
                  <textarea
                    id="observacao-do-compromisso"
                    data-testid="observacao-do-compromisso"
                    rows={1}
                    value={observacao}
                    onChange={(e) => setObservacao(e.target.value)}
                    className="mt-1 w-full resize-none rounded-md border bg-surface p-2 outline-hidden"
                    placeholder={t("O que a equipe precisa lembrar neste horário")}
                    aria-describedby="ajuda-da-observacao"
                  />
                  <p id="ajuda-da-observacao" className="mt-1 text-xs text-text-muted">
                    {t("Aparece na descrição do compromisso.")}
                  </p>
                </div>
              </>
            ) : null}
          </div>
          {tipo && (
            <div className="mt-4 shrink-0">
              <PainelDeMarcacao
                // O mês que abre é o da organização, como a grade ao lado.
                ancora={ancoraLocalDoDia(hojeNaOrganizacao)}
                agora={new Date()}
                responsavel={
                  // O DONO DO TIPO, não o primeiro da lista. A tela dizia "com
                  // <primeira pessoa>" enquanto oferecia a jornada de outra —
                  // e marcava na agenda da primeira, que não tinha jornada.
                  //
                  // "Você" só quando o dono da agenda É quem está logado. A
                  // regra está em `lib/agenda/responsavel-do-painel.ts`: com a
                  // lista da equipe vazia (o 403 do item 1 da issue 896) este
                  // fallback dizia "Você" para a jornada de OUTRA pessoa.
                  resolverResponsavelDoPainel({ pessoas, donoId: tipo.donoId, usuarioId })
                }
                tipo={tipo.nome}
                duracaoMin={tipo.duracaoMin}
                // O LOCAL e o FUSO de verdade, que a tela tinha e não passava.
                //
                // `PainelDeMarcacao` trazia `local = "Presencial · Sala 2"` e
                // `fuso = "America/Sao_Paulo"` como defaults de parâmetro, e
                // estas duas props nunca eram passadas: os defaults venciam em
                // 100% das marcações do produto. É o que o cabeçalho deste
                // arquivo proíbe — dado falso plausível numa tela multi-tenant é
                // indistinguível de vazamento.
                //
                // `fuso_da_regra` já vinha da rota e já era tipado pelo hook;
                // ninguém em tela o lia. Chutar São Paulo para quem atende em
                // Manaus é uma hora de diferença no horário oferecido ao cliente.
                local={rotuloDoLocal(tipo.localKind, endereco.trim() || tipo.localDetalhes)}
                fuso={horarios?.fuso_da_regra}
                horariosPorDia={horariosPorDia}
                publicouHorarios={horarios?.publicou_horarios ?? true}
                erroAoCarregar={horariosFalharam}
                fusoSuposto={horarios?.fuso_suposto ?? false}
                fontesDefasadas={horarios?.fontes_defasadas}
                googleCoberturaParcial={horarios?.google_cobertura_parcial}
                onMesVisivel={onMesVisivel}
                horarioInicial={horarioEscolhido ?? undefined}
                // O ENCAIXE é desta tela, e só dela: aqui quem marca é uma
                // pessoa da equipe com sessão, que é exatamente o ator a quem a
                // rota permite sair da grade. Vale também para REMARCAR, que é
                // este mesmo painel com PATCH — e a rota aplica a mesma regra lá.
                permiteEncaixe={podeMarcar}
                // ESTE é o fio que faltava. Sem ele o "Marcado ✓" era estado
                // local do React e nenhuma linha nascia no banco.
                onConfirmar={(instante) => {
                  // ⚠️ SEM `owner_user_id`, e é isto que conserta o 422.
                  //
                  // Isto mandava `pessoas[0]?.id` — a PRIMEIRA pessoa da lista.
                  // Os horários oferecidos vêm de `useHorariosLivres`, que NÃO
                  // manda dono, então a rota resolve `tipo.default_owner_user_id`.
                  // A tela oferecia a agenda de um e marcava na de outro: medido
                  // nesta org, 5 pessoas e só o dono do tipo com jornada, e o POST
                  // devolvia `agenda_disponibilidade_invalida` ("expected object,
                  // received undefined") enquanto a tela dizia "Marcado ✓".
                  //
                  // Omitir é o que faz oferta e marcação resolverem o dono pela
                  // MESMA regra (`_handler.ts:96`), por construção e não por sorte.
                  // Remarcar é PATCH com o id; marcar é POST. A escolha do
                  // horário é o mesmo gesto, e por isso o mesmo painel.
                  // Recusa ANTES da rede: o painel já pintou "Marcado ✓" quando
                  // o 422 voltasse, e desfazer aquilo é pior do que não deixar
                  // sair. O campo já está vermelho e explicado quando isto corta.
                  if (emailConvidadoInvalido) {
                    return Promise.reject(new Error(t("e-mail do convidado inválido")));
                  }
                  // `|| undefined` e não a string vazia: campo em branco tem de
                  // ficar FORA do corpo, senão o PATCH leria "" como "apague o
                  // convidado" e desconvidaria alguém a cada remarcação.
                  const convidado = emailConvidadoLimpo || undefined;
                  if (remarcandoId) {
                    return remarcar
                      .mutateAsync({
                        id: remarcandoId,
                        revision: agendamentos.find((a) => a.id === remarcandoId)?.revision,
                        starts_at: instante,
                        guest_email: convidado,
                      })
                      .then((r) => {
                        setRemarcandoId(null);
                        setMarcando(false);
                        setEmailConvidado("");
                        setEnderecoEditado(null);
                        setObservacao("");
                        return r;
                      });
                  }
                  return marcar
                    .mutateAsync({
                      event_type_id: tipo.id,
                      contact_id: contactId || undefined,
                      conversation_id: conversationId || undefined,
                      starts_at: instante,
                      guest_email: convidado,
                      location_details: endereco.trim(),
                      description: observacao.trim() || undefined,
                    })
                    .then((r) => {
                      setEmailConvidado("");
                      setEnderecoEditado(null);
                      setObservacao("");
                      // Guardado para o fechamento saber para onde levar a grade.
                      setMarcadoEm(instante);
                      return r;
                    });
                }}
                // "VER NA AGENDA" — o botão que não fazia nada.
                //
                // Ele não tinha `onClick`: parecia ativo e o clique era mudo. E
                // fechar o painel sozinho não bastaria — o compromisso recém
                // marcado costuma ser de OUTRA semana (o do relato era 8 de
                // setembro), e a grade abre na semana corrente. Voltar para uma
                // grade que não mostra o que acabou de nascer é o mesmo "nada
                // acontece" com um passo a mais.
                //
                // Por isso a âncora vai junto: fecha o painel E leva a grade até
                // o dia do compromisso. `startOfDay` porque a âncora é o DIA de
                // referência da visão — mandar o instante exato funcionaria por
                // acidente na visão de semana e escolheria a hora errada na de
                // dia.
                onVerNaAgenda={(instante) => {
                  setAncora(startOfDay(new Date(instante)));
                  setMarcando(false);
                  setRemarcandoId(null);
                }}
              />
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* CANCELAR pede motivo, e o motivo é OBRIGATÓRIO na rota (mínimo 3).
          Não é burocracia: é o que a equipe lê ao ver o horário vago. "Cancelado"
          sem motivo faz alguém ligar para o cliente perguntando o que houve — ou,
          pior, não ligar. */}
      <Sheet
        open={cancelandoId !== null}
        onOpenChange={(aberto) => {
          if (!aberto) setCancelandoId(null);
        }}
      >
        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{t("Cancelar agendamento")}</SheetTitle>
          </SheetHeader>
          <div className="mt-4 space-y-3" data-testid="painel-de-cancelamento">
            <p className="text-sm text-text-muted">
              {(() => {
                const alvo = todos.find((a) => a.id === cancelandoId);
                if (!alvo) return t("Este agendamento não está mais na lista.");
                const quem = alvo.quemSeraAtendido ? ` ${t("de")} ${alvo.quemSeraAtendido}` : "";
                return `${alvo.titulo}${quem}, ${format(new Date(alvo.comeca), t("d 'de' MMMM 'às' HH:mm"), { locale: localeDaData })}.`;
              })()}
            </p>
            <label
              className="block text-xs font-medium text-text-muted"
              htmlFor="motivo-do-cancelamento"
            >
              {t("Por que está cancelando?")}
            </label>
            <textarea
              id="motivo-do-cancelamento"
              data-testid="motivo-do-cancelamento"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-border bg-surface p-2 text-sm outline-hidden focus:border-border-strong"
              placeholder={t("O paciente pediu para remarcar por telefone")}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setCancelandoId(null)}>
                {t("Voltar")}
              </Button>
              <Button
                size="sm"
                data-testid="confirmar-cancelamento"
                // O mínimo de 3 é o da rota. Desabilitar aqui evita um 422 que a
                // pessoa não tem como prever — o botão diz o que falta pelo estado.
                disabled={motivo.trim().length < 3 || cancelar.isPending}
                onClick={() => {
                  const id = cancelandoId;
                  if (!id) return;
                  void cancelar
                    .mutateAsync({
                      id,
                      revision: agendamentos.find((a) => a.id === id)?.revision,
                      reason: motivo.trim(),
                    })
                    .then(
                      () => setCancelandoId(null),
                      () => undefined,
                    );
                }}
              >
                {cancelar.isPending ? t("Cancelando…") : t("Cancelar agendamento")}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/*
        ⚠️ A LISTA DAQUI NÃO É A MESMA DA GRADE, e a diferença é uma linha.

        `GradeDaAgenda` conhece `origem` e desenha o bloco do Google inerte
        (`disabled`, sem arraste, rótulo "Ocupado"). `HistoricoDaAgenda` NÃO
        conhece origem: ela decide o botão por `disabled={!onRemarcar}`, que é
        uma prop do componente inteiro e não da linha. Passar a mesma lista aos
        dois faz a ocupação do Google chegar em "Próximos" com **Remarcar e
        Cancelar habilitados** — e cancelar responde 404, porque o id é de
        `calendar_external_events` e a rota procura em `calendar_appointments`.

        Medido pela tela em 2026-09-03, na triagem do PR #474:

          DELETE /api/v1/agenda/agendamentos
          → 404 {"error":{"code":"not_found","message":"Agendamento não encontrado."}}
          toast vermelho aos 1,5s, o painel continua aberto, a linha continua na
          lista, e `calendar_external_events.status` segue `confirmed`.

        É o "controle decorativo" que o comentário de `GradeDaAgenda` diz que
        esta base já pagou uma vez, replantado no componente irmão — e o #474 o
        tornou PERMANENTE: antes dele a linha só existia no primeiro frame da
        semana corrente (a semente do servidor) e sumia no primeiro refetch.

        Filtrar é o conserto certo, e não é escolha estética: bloco anônimo do
        Google não é um compromisso NOSSO. Não há o que remarcar, não há o que
        cancelar, e "Ocupado · 15:00–16:00" numa lista de próximos atendimentos
        não informa nada que a grade — que O DESENHA no horário — já não diga
        melhor. A ocupação continua inteira onde ela serve.
      */}
      <HistoricoDaAgenda
        agendamentos={agendamentosAcionaveis}
        pessoas={pessoas}
        agora={new Date()}
        className="max-h-[320px]"
        // ⚠️ ESTAS DUAS PROPS FALTAVAM, e a ausência tinha cara de permissão.
        // `HistoricoDaAgenda` usa `disabled={!onRemarcar}`; sem elas os botões
        // nasciam cinzas em toda linha, de toda organização — e o `title` dizia
        // "Disponível quando a agenda estiver conectada", que é falso: PATCH e
        // DELETE não tocam o Google. Só a IA conseguia remarcar ou cancelar.
        onRemarcar={(id) => {
          setRemarcandoId(id);
          setMarcando(true);
        }}
        onCancelar={(id) => {
          setMotivo("");
          setCancelandoId(id);
        }}
        // E ESTAS DUAS TAMBÉM FALTAVAM — o conserto acima alcançou 2 dos 4
        // botões do MESMO componente, e "Realizado"/"Faltou" ficaram cinzas,
        // com a mesma frase falsa, por mais tempo ainda. Conserto por instância
        // custa a segunda passada; a varredura custaria um `grep`.
        //
        // Sem cerimônia de confirmação, ao contrário de cancelar: registrar
        // desfecho não avisa ninguém e se desfaz voltando o status. Cancelar
        // exige motivo porque é o que a equipe lê ao ver o horário vago.
        // CONFIRMAR usa o mesmo `desfecho` que realizado/faltou: os três são o
        // mesmo PATCH com outro `status`. Criar um hook próprio duplicaria a
        // invalidação de cache e o tratamento de erro por nada.
        onConfirmar={(id) =>
          desfecho.mutate({
            id,
            revision: agendamentos.find((a) => a.id === id)?.revision,
            status: "confirmed",
          })
        }
        onRealizado={(id) =>
          desfecho.mutate({
            id,
            revision: agendamentos.find((a) => a.id === id)?.revision,
            status: "completed",
          })
        }
        onFaltou={(id) =>
          desfecho.mutate({
            id,
            revision: agendamentos.find((a) => a.id === id)?.revision,
            status: "no_show",
          })
        }
      />

      {/* ⚠️ O VAZIO NÃO ESCONDE MAIS A GRADE, e o achado veio do CI.
          Isto era um ternário: com zero agendamentos, `EmptyAgenda` entrava NO
          LUGAR de `GradeDaAgenda`. Numa instalação nova — que é o estado de
          primeira impressão — a pessoa abria a Agenda e não via calendário
          NENHUM: sem semana, sem horários, e com o alternador de visão ligado a
          nada, que é controle decorativo.

          A mensagem continua, porque ela é boa: diz de ONDE vem o próximo
          agendamento em vez de constatar a ausência. Ela virou aviso ACIMA da
          grade, e a grade fica.

          Achado porque a cerca nova das três visões passou aqui (banco com
          dados de execuções anteriores) e reprovou no CI, onde o banco nasce
          limpo. O mesmo formato do defeito que `agenda-tela-do-produto` já
          tinha pago: verde por banco sujo. */}
      {agendamentos.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-4">
          <EmptyAgenda />
        </div>
      ) : null}
      {/* A GRADE INTERATIVA — clicar num bloco livre marca ali, arrastar um card
          remarca. Toda a fiação (a consulta de horários da janela desenhada, a
          proposta de remarcação, o otimismo com volta atrás) mora em
          `AgendaInterativa`; aqui fica só o que esta tela já sabia. */}
      <AgendaInterativa
        visao={visao}
        ancora={ancora}
        agora={new Date()}
        pessoas={pessoas}
        agendamentos={agendamentosDaGrade}
        recorte={recorteDaGrade}
        tipos={tiposIniciais.map((t) => ({ id: t.id, nome: t.nome, duracaoMin: t.duracaoMin }))}
        tipo={tipo ? { id: tipo.id, duracaoMin: tipo.duracaoMin } : null}
        onEscolherTipo={setTipoId}
        // SEGUNDA PORTA: o clique num bloco livre da grade. Sem `onMarcarEm`, a
        // `AgendaInterativa` não monta a interação, e a grade volta a ser o que
        // ela é para quem só lê — uma leitura, sem bloco clicável.
        onMarcarEm={
          podeMarcar
            ? (instante) => {
                setHorarioEscolhido({ instante, rotulo: format(new Date(instante), "HH:mm") });
                setRemarcandoId(null);
                // `abrirMarcacao` e não `setMarcando(true)`: clicar num bloco
                // livre abre uma marcação NOVA, e ela nasce com o vínculo da rota.
                abrirMarcacao();
              }
            : undefined
        }
        /* Tocar num card abre o detalhe. A prop já atravessava `AgendaInterativa`
           e `GradeDaAgenda` e chegava `undefined` aqui: o toque não fazia nada, e
           o detalhe só abria por `?compromisso=`, que apenas o Histórico e o Radar
           linkavam. Reusa o MESMO parâmetro que `EntradaDaAgenda` já lê — e `push`,
           não `replace`, porque é o que o Histórico faz com `<Link>` e é o que faz
           o botão voltar do celular fechar o detalhe. */
        onAbrirAgendamento={(id) => router.push(`/app/agenda?compromisso=${id}`)}
        className="min-h-0 flex-1"
      />
    </div>
  );
}
