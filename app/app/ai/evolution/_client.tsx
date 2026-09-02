"use client";
import * as React from "react";
import Link from "next/link";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { EvolutionGaps } from "@/components/ai/EvolutionGaps";
import { EvolutionTimeline } from "@/components/ai/EvolutionTimeline";
import { useEvolution } from "@/hooks/ai/useEvolution";
import type { EvolutionPayload } from "@/lib/ai/evolution/aggregate";

/**
 * O painel responde UMA pergunta do dono do negócio: "o que meu agente aprendeu
 * este mês, e o que melhorou?". Por isso a tela é uma narrativa em quatro
 * blocos, nesta ordem — aprendeu → fez → mudou o resultado → o que ainda trava —
 * e não uma grade de indicadores.
 *
 * Regra de escrita: TODO número leva uma frase dizendo o que ele significa.
 * Quem construiu o sistema entende "handoff rate"; o dono da clínica entende
 * "casos que precisaram de uma pessoa". A tela é escrita para o segundo.
 */

// DÓLAR: `outcome.cost_cents` vem de `llm_calls`, que `pricing.ts` grava em centavo de USD.
const usd = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "USD" });

/**
 * O bloco se chama "o que MUDOU", mas o payload traz um período só — não há
 * comparação embutida. Em vez de prometer uma variação que a tela não calcula,
 * a descrição diz como o dono do negócio consegue a comparação com as próprias
 * mãos. Prometer a mais é o defeito que esta fase passou o dia consertando.
 */
const DESCRICAO_RESULTADO =
  "O que aconteceu com os seus negócios neste período. Para saber se melhorou, mude as datas acima e compare com o mês anterior.";

/**
 * Os três primeiros números deste bloco vêm de `lead_state_transitions`, e o
 * ÚNICO escritor dessa tabela no repo é a máquina de estados do agente
 * (`lib/agent-engine/agent/lead-state.ts`). Atendente arrastando cartão no
 * Kanban não gera linha nenhuma ali. Sem esta ressalva, um mês em que a equipe
 * fechou doze negócios na mão apareceria como "0" num bloco chamado "o que
 * mudou no resultado" — e o dono do negócio concluiria que o mês foi zero.
 *
 * O vocabulário também é deliberado: o bloco 4 usa "funil"/"etapa" para
 * `crm_pipelines`/`crm_stages` e "passo do atendimento" para o estado do agente.
 * Chamar isto de "avanço no funil" faria a mesma tela dizer que os cartões
 * andaram e que os cartões não andam.
 */
const SIGNIFICA_GANHOS =
  "Clientes que o agente marcou como fechados. Negócio que a sua equipe fechou na mão, movendo o cartão no quadro, não entra aqui.";
const SIGNIFICA_PERDIDOS =
  "Clientes que o agente marcou como perdidos — contraponto necessário, porque ganhos sem perdidos ao lado enganam. Também não conta o que a sua equipe marcou na mão.";
/**
 * "Avanço" prometeria DIREÇÃO, e o dado não tem: `stage_transitions` é o total
 * de transições, e o grafo do funil do agente permite `qualquer → lost`. Num mês
 * de 1 ganho e 5 perdas, 6 das transições seriam justamente os desfechos — e 5
 * delas, perdas contadas como avanço. A redação neutra é a única fiel.
 */
const SIGNIFICA_MUDANCAS =
  "Quantas vezes o agente registrou que um cliente mudou de passo no atendimento — o sinal de que a conversa andou, e não só aconteceu. Inclui as mudanças para fechado e para perdido, então não leia como só progresso. Cartão movido à mão no quadro não entra aqui.";

/**
 * O numerador soma DUAS fontes com garantias diferentes: o runtime atual
 * deduplica por episódio aberto; o antigo só ignora repetição dentro de 5s com a
 * mesma razão. "Conta uma vez só" seria verdade para metade do número, e "modo
 * antigo do sistema" seria jargão que o dono da clínica não sabe se o afeta — a
 * frase entrega a CONSEQUÊNCIA (leia como estimativa) e para por aí.
 */
const SIGNIFICA_AJUDA =
  "Conversas que o agente passou para um atendente humano, a cada 100 mensagens recebidas. Leia como estimativa: no geral o mesmo caso conta uma vez só, mesmo que o cliente peça ajuda várias vezes, mas em parte dos atendimentos ele pode contar mais de uma.";

/**
 * Uma ajuda em 5.000 mensagens é 0,02 a cada 100 — com uma casa decimal isso
 * vira "0", que lê como "nunca precisou de gente". É o mesmo zero lisonjeiro
 * dos outros números do bloco, só que produzido pelo formatador. Exportada por
 * ser o único jeito de alcançar o ramo `< 0,1`: a org de prova não o produz.
 */
export function taxaDeAjuda(rate: number): string {
  if (rate <= 0) return "0";
  const porCem = rate * 100;
  if (porCem < 0.1) return "menos de 0,1 a cada 100";
  return `${porCem.toLocaleString("pt-PT", { maximumFractionDigits: 1 })} a cada 100`;
}

/**
 * Sem atendimento nenhum no período, "0 casos precisaram de uma pessoa" LÊ como
 * "sua IA deu conta de tudo" — a mentira mais lisonjeira que este bloco poderia
 * contar, e a mais fácil de acreditar. O zero continua lá (é o valor certo); o
 * que muda é a frase que diz do que ele é feito.
 */
const DESCRICAO_RESULTADO_SEM_ATIVIDADE =
  "Não houve atendimento neste período, então os zeros abaixo querem dizer \"nada aconteceu\", e não \"foi mal\". Mude as datas acima para um período com movimento.";

/**
 * A escolha da descrição olha SÓ `messages_received`, e recebe o `outcome`
 * inteiro de propósito: é o que torna sabotável — se alguém voltar a somar
 * `cost_cents` aqui, o teste fica vermelho.
 *
 * O guarda anterior usava custo como SUBSTITUTO de "houve atendimento", e
 * substituto não é evidência: `llm_calls` inclui `connection_test` (script de
 * ops) e as chamadas do flywheel, cujo cron julga turnos PASSADOS e carimba o
 * custo no dia em que rodou. Num período sem atendimento nenhum, o custo do cron
 * apagaria justamente a ressalva que existe para impedir a leitura lisonjeira.
 * O fato exato já era calculado na rota; só faltava chegar ao payload.
 */
export function descricaoResultado(outcome: EvolutionPayload["outcome"]): string {
  return outcome.messages_received > 0 ? DESCRICAO_RESULTADO : DESCRICAO_RESULTADO_SEM_ATIVIDADE;
}

function num(n: number): string {
  return n.toLocaleString("pt-PT");
}

function diaCurto(s: string): string {
  return new Date(`${s}T00:00:00Z`).toLocaleDateString("pt-PT", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "UTC",
  });
}

function Bloco({
  titulo,
  descricao,
  children,
  testId,
}: {
  titulo: string;
  descricao: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <section className="flex flex-col gap-3" data-testid={testId}>
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{titulo}</h2>
        <p className="text-sm text-text-muted">{descricao}</p>
      </div>
      {children}
    </section>
  );
}

function StatCard({
  rotulo,
  valor,
  significa,
}: {
  rotulo: string;
  valor: string;
  /** O que o número quer dizer. Nunca opcional: número sozinho não informa. */
  significa: string;
}) {
  return (
    <Card className="flex flex-col p-4">
      <p className="text-xs text-text-muted">{rotulo}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{valor}</p>
      <p className="mt-2 text-xs leading-relaxed text-text-muted">{significa}</p>
    </Card>
  );
}

/**
 * Estado vazio que ENSINA. Um traço mudo aqui seria falha de produto: num tenant
 * recém-instalado o vazio é a REGRA, não a exceção, e é a primeira coisa que o
 * dono do negócio vê. Então o vazio diz o que é aquilo, por que está vazio, e
 * qual é a tela onde ele deixa de estar.
 */
function Vazio({
  texto,
  acoes,
}: {
  texto: string;
  acoes?: Array<{ href: string; label: string }>;
}) {
  return (
    <div className="flex flex-col items-start gap-2 p-1">
      <p className="text-sm leading-relaxed text-text-muted">{texto}</p>
      {acoes && acoes.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {acoes.map((a) => (
            <Link
              key={a.href}
              href={a.href}
              className="text-sm font-medium text-accent underline underline-offset-4"
            >
              {a.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function GraficoDiario({
  titulo,
  significa,
  dados,
  cor,
  vazio,
}: {
  titulo: string;
  significa: string;
  dados: Array<{ day: string; value: number }>;
  cor: string;
  vazio: React.ReactNode;
}) {
  const temDado = dados.some((p) => p.value > 0);
  const total = dados.reduce((acc, p) => acc + p.value, 0);
  return (
    <Card className="p-4">
      <h3 className="text-sm font-medium">{titulo}</h3>
      <p className="mt-1 text-xs leading-relaxed text-text-muted">{significa}</p>
      {!temDado ? (
        <div className="mt-4">{vazio}</div>
      ) : (
        <>
          <p className="mt-3 text-2xl font-semibold tracking-tight">
            {num(total)}{" "}
            <span className="text-xs font-normal text-text-muted">no período</span>
          </p>
          <div className="mt-2">
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={dados} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                <XAxis
                  dataKey="day"
                  tickFormatter={diaCurto}
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                  width={36}
                />
                <Tooltip
                  formatter={(v) => [num(Number(v)), "no dia"]}
                  labelFormatter={(l) => diaCurto(String(l))}
                  contentStyle={{
                    borderRadius: "8px",
                    fontSize: "12px",
                    border: "1px solid hsl(var(--border))",
                    background: "hsl(var(--popover))",
                  }}
                />
                <Line type="monotone" dataKey="value" stroke={cor} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </Card>
  );
}

function Ranking({
  titulo,
  significa,
  contagem,
  vazio,
}: {
  titulo: string;
  significa: string;
  contagem: Record<string, number>;
  vazio: React.ReactNode;
}) {
  const linhas = Object.entries(contagem)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const maior = linhas[0]?.[1] ?? 0;
  return (
    <Card className="p-4">
      <h3 className="text-sm font-medium">{titulo}</h3>
      <p className="mt-1 text-xs leading-relaxed text-text-muted">{significa}</p>
      {linhas.length === 0 ? (
        <div className="mt-4">{vazio}</div>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {linhas.map(([nome, qtd]) => (
            <li key={nome} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-sm" title={nome}>
                  {nome}
                </span>
                <span className="shrink-0 text-sm tabular-nums text-text-muted">
                  {num(qtd)}
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-surface-elevated">
                <div
                  className="h-1.5 rounded-full bg-accent"
                  style={{ width: `${maior > 0 ? Math.max(4, (qtd / maior) * 100) : 0}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Carregando() {
  return (
    <div className="flex flex-col gap-4" data-testid="evolution-carregando">
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="p-4">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="mt-2 h-8 w-16" />
            <Skeleton className="mt-3 h-3 w-full" />
          </Card>
        ))}
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function EvolutionClient({ defaultRange }: { defaultRange: { from: string; to: string } }) {
  const [from, setFrom] = React.useState(defaultRange.from);
  const [to, setTo] = React.useState(defaultRange.to);
  const q = useEvolution({ from, to });

  return (
    <div className="flex flex-col gap-8">
      <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end sm:gap-4">
        <div className="flex-1">
          <p className="text-sm font-medium">Período analisado</p>
          <p className="text-xs text-text-muted">
            Todos os números desta página são só deste intervalo. Mude as datas para comparar
            um mês com o outro.
          </p>
        </div>
        <div className="flex gap-3">
          <div className="space-y-1">
            <Label htmlFor="evolution-de" className="text-xs text-text-muted">
              De
            </Label>
            <Input
              id="evolution-de"
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="evolution-ate" className="text-xs text-text-muted">
              Até
            </Label>
            <Input
              id="evolution-ate"
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </div>
      </Card>

      {q.error ? (
        <Card className="p-6 text-sm" data-testid="evolution-erro">
          Não conseguimos carregar os números agora. Recarregue a página em alguns instantes —
          se continuar assim, avise quem cuida da sua instalação.
        </Card>
      ) : !q.data ? (
        <Carregando />
      ) : (
        <Conteudo payload={q.data} />
      )}
    </div>
  );
}

function Conteudo({ payload }: { payload: NonNullable<ReturnType<typeof useEvolution>["data"]> }) {
  const { learned, activity, outcome, gaps } = payload;

  const soma = (s: Array<{ value: number }>) => s.reduce((a, p) => a + p.value, 0);
  // Contagens SEPARADAS, não um booleano só: cada frase de "nada travando" é uma
  // afirmação sobre uma fonte diferente, e um guarda único as autorizaria todas
  // com a evidência de uma. Ver o comentário em EvolutionGaps.
  const buscas = soma(activity.series.knowledge_searches);
  const decisoes = soma(activity.series.router_decisions);

  return (
    <>
      <Bloco
        testId="bloco-aprendeu"
        titulo="O que seu agente aprendeu"
        descricao="Tudo o que entrou na cabeça dele neste período, e de onde veio."
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard
            rotulo="Regras que você ensinou"
            valor={num(learned.memory_entries)}
            significa="Instruções publicadas na Memória da IA. Valem para toda conversa, de todos os agentes."
          />
          <StatCard
            rotulo="Melhorias que você aprovou"
            valor={num(learned.proposals_applied)}
            significa="Sugestões que o sistema tirou dos próprios atendimentos e que você revisou e aceitou."
          />
          <StatCard
            rotulo="Habilidades instaladas"
            valor={num(learned.skills_installed)}
            significa="Skills que o agente passou a carregar quando a conversa pede — por exemplo, fechar um agendamento."
          />
        </div>
        <Card className="p-4">
          <h3 className="text-sm font-medium">Linha do tempo do aprendizado</h3>
          <p className="mt-1 text-xs text-text-muted">
            Cada linha é uma coisa nova que o agente passou a saber, na ordem em que aconteceu.
          </p>
          <div className="mt-3">
            {learned.timeline.length === 0 ? (
              // Um só texto, e não dois: a linha do tempo é montada das MESMAS três
              // fontes dos três contadores acima, então `timeline.length === 0` é
              // equivalente a "os três contadores são zero". O ramo "aprendeu algo
              // mas não tem data" era inalcançável.
              <Vazio
                texto="Seu agente ainda não aprendeu nada neste período. Ele aprende de três jeitos: você publica uma regra na Memória da IA, aprova uma sugestão de melhoria na aba Propostas do agente, ou instala uma habilidade em Skills da IA."
                acoes={[
                  { href: "/app/ai/memory", label: "Publicar uma regra" },
                  { href: "/app/ai/agents", label: "Ver sugestões de melhoria" },
                  { href: "/app/ai/skills", label: "Instalar uma habilidade" },
                ]}
              />
            ) : (
              <EvolutionTimeline items={learned.timeline} />
            )}
          </div>
        </Card>
      </Bloco>

      <Bloco
        testId="bloco-fez"
        titulo="O que ele fez"
        descricao="O trabalho do dia a dia: quantas vezes ele usou cada recurso que você deu a ele."
      >
        <div className="grid gap-3 lg:grid-cols-3">
          <GraficoDiario
            titulo="Habilidades usadas"
            significa="Quantas vezes o agente puxou uma habilidade especializada para dar conta da conversa."
            dados={activity.series.skill_activations}
            cor="hsl(262 83% 58%)"
            vazio={
              <Vazio
                texto="Nenhuma habilidade foi usada. Ou o agente ainda não tem nenhuma instalada, ou as conversas do período não pediram nenhuma."
                acoes={[{ href: "/app/ai/skills", label: "Ver habilidades disponíveis" }]}
              />
            }
          />
          <GraficoDiario
            titulo="Conversas encaminhadas"
            significa="Quantas vezes o sistema leu o que o cliente queria e escolheu qual atendimento devia responder."
            dados={activity.series.router_decisions}
            cor="hsl(199 89% 48%)"
            vazio={
              <Vazio
                texto="Nenhuma conversa foi encaminhada. Isso só acontece em números que têm um roteador configurado — sem ele, tudo cai no atendimento padrão."
                acoes={[{ href: "/app/ai/routers", label: "Configurar um roteador" }]}
              />
            }
          />
          <GraficoDiario
            titulo="Consultas aos seus materiais"
            significa="Quantas vezes o agente foi procurar a resposta no que você escreveu, em vez de improvisar."
            dados={activity.series.knowledge_searches}
            cor="hsl(142 76% 36%)"
            vazio={
              <Vazio
                texto="O agente não consultou seus materiais. Ou não há nada publicado na base de conhecimento, ou as conversas não chegaram a precisar."
                acoes={[{ href: "/app/ai/knowledge/sources", label: "Publicar material" }]}
              />
            }
          />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Ranking
            titulo="Habilidades mais usadas"
            significa="Onde o agente mais precisou de conhecimento especializado."
            contagem={activity.by_skill}
            vazio={
              <Vazio
                texto="Nenhuma habilidade foi usada neste período, então não há o que ranquear."
                acoes={[{ href: "/app/ai/skills", label: "Ver habilidades disponíveis" }]}
              />
            }
          />
          <Ranking
            titulo="Assuntos mais procurados"
            significa="O que os clientes mais quiseram, segundo o que o roteador entendeu de cada conversa."
            contagem={activity.by_intent}
            vazio={
              <Vazio
                texto="Nenhuma conversa foi classificada por assunto. Os assuntos são os que você cadastra no roteador do seu número."
                acoes={[{ href: "/app/ai/routers", label: "Cadastrar assuntos" }]}
              />
            }
          />
        </div>
      </Bloco>

      <Bloco
        testId="bloco-resultado"
        titulo="O que mudou no resultado"
        descricao={descricaoResultado(outcome)}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            rotulo="Negócios fechados pelo agente"
            valor={num(outcome.won)}
            significa={SIGNIFICA_GANHOS}
          />
          <StatCard
            rotulo="Negócios perdidos pelo agente"
            valor={num(outcome.lost)}
            significa={SIGNIFICA_PERDIDOS}
          />
          <StatCard
            rotulo="Mudanças de passo no atendimento"
            valor={num(outcome.stage_transitions)}
            significa={SIGNIFICA_MUDANCAS}
          />
          <StatCard
            rotulo="Casos que precisaram de uma pessoa"
            valor={taxaDeAjuda(outcome.handoff_rate)}
            significa={SIGNIFICA_AJUDA}
          />
          <StatCard
            rotulo="Custo da IA no período"
            valor={usd.format(outcome.cost_cents / 100)}
            significa="O que você pagou aos provedores de IA para tudo isto acontecer."
          />
        </div>
      </Bloco>

      <Bloco
        testId="bloco-travando"
        titulo="O que está travando"
        descricao="Cada linha aqui é uma coisa que está limitando seu agente, e o que fazer a respeito — às vezes você mesmo, às vezes quem cuida da sua instalação."
      >
        <EvolutionGaps gaps={gaps} buscas={buscas} decisoes={decisoes} />
      </Bloco>
    </>
  );
}
