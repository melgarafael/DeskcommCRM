"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";


import { format } from "date-fns";
import * as React from "react";

import { AgendaCarregando, AgendaComErro } from "@/components/agenda/estados";
import { ANCORA, AGENDAMENTOS, HORARIOS_POR_DIA, PESSOAS } from "@/components/agenda/dados-de-mentira";
import { FiltroDePessoas } from "@/components/agenda/FiltroDePessoas";
import { GradeDaAgenda } from "@/components/agenda/GradeDaAgenda";
import { HistoricoDaAgenda } from "@/components/agenda/HistoricoDaAgenda";
import { PainelDeMarcacao } from "@/components/agenda/PainelDeMarcacao";
import { corDaTrilha, TRILHAS } from "@/components/agenda/paleta";
import type { VisaoDaAgenda } from "@/components/agenda/tipos";
import { EmptyAgenda } from "@/components/empty";
import { Button } from "@/components/ui/button";
import { CalendarPlus, CaretLeft, CaretRight } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme";

const VISOES: Array<{ id: VisaoDaAgenda; rotulo: string }> = [
  { id: "dia", rotulo: "Dia" },
  { id: "semana", rotulo: "Semana" },
  { id: "mes", rotulo: "Mês" },
];

function Secao({
  titulo,
  descricao,
  children,
  id,
}: {
  titulo: string;
  descricao: string;
  children: React.ReactNode;
  id: string;
}) {
  return (
    <section id={id} data-testid={`secao-${id}`} className="space-y-3">
      <div>
        <h2 className="text-base font-semibold tracking-tight">{titulo}</h2>
        <p className="mt-0.5 max-w-2xl text-sm text-text-muted">{descricao}</p>
      </div>
      {children}
    </section>
  );
}

export function VitrineDaAgenda() {
  const localeDaData = useLocaleDeData();
  const [visao, setVisao] = React.useState<VisaoDaAgenda>("semana");
  const [isolada, setIsolada] = React.useState<string | null>(null);
  const { theme, setTheme } = useTheme();

  const visiveis = React.useMemo(
    () => (isolada === null ? AGENDAMENTOS : AGENDAMENTOS.filter((c) => c.responsavelId === isolada)),
    [isolada],
  );

  return (
    <div className="mx-auto max-w-6xl space-y-10 p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Kit visual da Agenda</h1>
          <p className="text-sm text-muted-foreground">
            Componentes puros, alimentados por dados de mentira. Sem banco, sem rota — o desenho
            decidido antes de haver o que exibir.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* O alternador existe para a prova: a spec troca o tema e remede as
              cores, porque uma paleta só está certa quando está certa nos dois. */}
          <Button
            variant="outline"
            size="sm"
            data-testid="alternar-tema"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            Tema: {theme === "dark" ? "escuro" : "claro"}
          </Button>
        </div>
      </header>

      <Secao
        id="paleta"
        titulo="As oito trilhas de cor"
        descricao="Oito matizes espalhados e nomeáveis, derivados por cálculo: cada par passa em contraste (mínimo 3:1) e nenhum encosta no verde da marca. O par mais próximo fica a 0,119 no claro e 0,116 no escuro — a paleta de referência para daltonismo faz 0,156 com sete cores. Cor nunca vem sozinha: a inicial acompanha sempre."
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {TRILHAS.map(({ trilha, nome }) => (
            <div
              key={trilha}
              data-testid={`amostra-trilha-${trilha}`}
              className="flex items-center gap-2 rounded-md border border-border bg-surface p-2"
            >
              <span
                data-testid={`swatch-${trilha}`}
                className="h-8 w-8 shrink-0 rounded-sm"
                style={{ backgroundColor: corDaTrilha(trilha) }}
                aria-hidden
              />
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold">{nome}</p>
                <p className="font-mono text-[10px] text-text-subtle">trilha {trilha}</p>
              </div>
            </div>
          ))}
        </div>
      </Secao>

      <Secao
        id="grade"
        titulo="A grade"
        descricao="Dia, semana e mês. A régua do agora, os blocos com a faixa na cor de quem atende, e a ocupação vinda do Google — hachurada, esmaecida e sem ações."
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" aria-label="Período anterior">
                <CaretLeft size={16} weight="bold" aria-hidden />
              </Button>
              <Button variant="ghost" size="icon" aria-label="Próximo período">
                <CaretRight size={16} weight="bold" aria-hidden />
              </Button>
            </div>
            <span data-testid="periodo" className="text-sm font-semibold first-letter:uppercase">
              {format(ANCORA, "MMMM 'de' yyyy", { locale: localeDaData })}
            </span>
          </div>

          {/* `flex-wrap` porque no celular o filtro de pessoas e o alternador de
              visão somam 433px numa tela de 390 — medido. Sem a quebra, o
              alternador saía pela direita, e o `overflow-x: hidden` do
              `globals.css` cortava em silêncio: sem barra de rolagem, sem aviso,
              sem como trocar de visão. */}
          <div className="flex flex-wrap items-center gap-3">
            <FiltroDePessoas pessoas={PESSOAS} isolada={isolada} onIsolar={setIsolada} />
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
                  {v.rotulo}
                </button>
              ))}
            </div>
            <Button size="sm">
              <CalendarPlus size={16} weight="bold" aria-hidden />
              <span>Novo agendamento</span>
            </Button>
          </div>
        </div>

        <GradeDaAgenda
          visao={visao}
          ancora={ANCORA}
          agora={ANCORA}
          pessoas={PESSOAS}
          agendamentos={visiveis}
          className="h-[560px]"
        />
      </Secao>

      <Secao
        id="marcacao"
        titulo="O painel de marcar"
        descricao="Três tempos: escolher o dia, escolher o horário, confirmar. A coluna de horários não está lá no começo — ela entra pela direita quando o dia é escolhido, e o painel cresce junto."
      >
        <PainelDeMarcacao
          ancora={ANCORA}
          agora={ANCORA}
          responsavel={PESSOAS[0]!}
          horariosPorDia={HORARIOS_POR_DIA}
          quemSeraAtendido={{ nome: "Marina Alves", aceitaMensagem: true }}
        />
      </Secao>

      <Secao
        id="sem-lembrete"
        titulo="Quando a pessoa pediu para não receber mensagens"
        descricao="Marcar continua permitido — opt-out é vontade sobre o canal, não sobre o atendimento. O que muda é o lembrete, e a tela diz isso ANTES de confirmar: o produto não mandar é uma decisão, o produto não avisar que não ia mandar é um bug."
      >
        <PainelDeMarcacao
          ancora={ANCORA}
          agora={ANCORA}
          responsavel={PESSOAS[2]!}
          horariosPorDia={HORARIOS_POR_DIA}
          quemSeraAtendido={{ nome: "Pedro Lima", aceitaMensagem: false }}
        />
      </Secao>

      <Secao
        id="historico"
        titulo="O histórico"
        descricao="Lista, não grade: a grade responde “como está meu dia”, a lista responde “o que aconteceu com esta pessoa”. Quatro divisões na ordem em que quem atende precisa delas, e ações só onde fazem sentido — remarcar o que já passou seria oferta falsa."
      >
        <HistoricoDaAgenda
          agendamentos={AGENDAMENTOS}
          pessoas={PESSOAS}
          agora={ANCORA}
          className="h-[420px]"
        />
      </Secao>

      <Secao
        id="nao-configurado"
        titulo="Quando ninguém publicou horário — e o que a rota conta além dos slots"
        descricao="“Não publiquei meus horários” e “não tenho vaga” chegariam como a mesma lista vazia se a API não os separasse. A rota separa, e a tela usa: aqui aparecem os três avisos que ela devolve além dos horários — jornada não publicada, fuso suposto por ninguém ter escolhido, e agenda conectada que parou de atualizar."
      >
        <PainelDeMarcacao
          ancora={ANCORA}
          agora={ANCORA}
          responsavel={PESSOAS[3]!}
          horariosPorDia={{}}
          publicouHorarios={false}
          fusoSuposto
          fontesDefasadas={[{ nome: "Google · ana@clinica.com", desde: "ontem às 18h" }]}
        />
      </Secao>

      <Secao
        id="estados"
        titulo="Os estados"
        descricao="Vazio, carregando e erro — os três que aparecem antes de qualquer dado existir, e que decidem a primeira impressão de quem acabou de instalar."
      >
        <div className="rounded-lg border border-border bg-surface">
          <EmptyAgenda primary={{ label: "Criar um tipo de agendamento", onClick: () => {} }} />
        </div>
        <div className="flex h-[280px]">
          <AgendaCarregando />
        </div>
        <div className="flex h-[200px]">
          <AgendaComErro
            motivo="A agenda do Google de Ana Prado desconectou — o Google recusou a credencial guardada. Reconectar resolve; até lá, os agendamentos dela vindos de fora não aparecem."
            onTentarDeNovo={() => {}}
          />
        </div>
      </Secao>
    </div>
  );
}
