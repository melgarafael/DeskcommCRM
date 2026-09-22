"use client";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useAgentMapping,
  useSaveAgentMapping,
  type EtapaDoFunil,
  type MapaDoAgente,
} from "@/hooks/pipelines/useAgentMapping";
import { LEAD_STAGES, type LeadStage } from "@/lib/agent-engine/agent/lead-state";
import { ApiError } from "@/lib/api/types";
import { ROTULO_DO_PASSO } from "@/lib/leads/agent-mapping";
import { ArrowRight, Warning } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

/**
 * Onde o dono do negócio diz ao agente para onde levar o card em cada momento do
 * atendimento.
 *
 * ⚠️ A TELA INVERTE O BANCO, DE PROPÓSITO. `crm_stages.agent_stage_hint` guarda
 * etapa → passo; aqui é uma linha por PASSO, na ordem em que o cliente avança,
 * escolhendo a etapa. É o modelo mental de quem configura ("quando o agente
 * qualificar, mova para…") e torna impossível pedir dois destinos para o mesmo
 * passo — o formulário não tem como expressar isso.
 *
 * ⚠️ O ÍNDICE ÚNICO DO BANCO VIRA AUSÊNCIA, NÃO ERRO. Etapa já escolhida por
 * outro passo simplesmente não aparece nas demais listas; o mesmo vale para a
 * coerência com ganho/perda (CHECK da 0084). A recusa da API continua existindo
 * para a tela desatualizada — mas o caminho normal nunca a alcança.
 *
 * ⚠️ «NÃO MOVER» É ESCOLHA, NÃO PENDÊNCIA (migration 0084, com todas as letras).
 * Nada nesta tela marca esse estado como erro, incompleto ou faltando.
 */

/** Sentinela do «não mover»: o Radix Select proíbe item com valor vazio. */
const SEM_ETAPA = "__sem_etapa__";

/** A âncora desta seção. A tela de etapas linka para cá quando o vínculo com o assistente trava a edição. */
export const ancoraDoMapeamento = (pipelineId: string) => `mapeamento-${pipelineId}`;

/**
 * Quando cada passo acontece, em linguagem de quem atende — não é uma segunda
 * tradução do nome (esse vem inteiro de `ROTULO_DO_PASSO`, fonte única), é a
 * explicação que responde "e quando é isso?" sem obrigar o dono da clínica a
 * adivinhar o vocabulário de CRM.
 */
const QUANDO_ACONTECE: Readonly<Record<LeadStage, string>> = {
  new: "a pessoa acabou de chamar e ninguém respondeu ainda",
  contacted: "o agente já respondeu pela primeira vez",
  qualifying: "o agente está entendendo o que a pessoa precisa",
  qualified: "o agente já entendeu a necessidade",
  negotiating: "conversa de preço, proposta ou agendamento",
  won: "a pessoa fechou",
  lost: "a pessoa desistiu ou parou de responder",
} as const;

/**
 * As etapas que este passo pode receber — a regra da API escrita como ausência.
 *
 * Três filtros, e cada um evita um erro DIFERENTE que o banco devolveria:
 *  • etapa já escolhida por outro passo → índice único `uniq_crm_stages_pipeline_hint`;
 *  • «Ganho»/«Perdido» só em etapa de fechamento/perda → CHECK da 0084;
 *  • os outros cinco passos NUNCA em etapa de fechamento/perda → o mesmo CHECK,
 *    no sentido inverso (uma etapa de ganho só pode representar «Ganho»).
 */
function serveParaOPasso(passo: LeadStage, etapa: EtapaDoFunil): boolean {
  if (passo === "won") return etapa.is_won;
  if (passo === "lost") return etapa.is_lost;
  return !etapa.is_won && !etapa.is_lost;
}

export function opcoesDoPasso(
  passo: LeadStage,
  etapas: EtapaDoFunil[],
  mapa: MapaDoAgente,
): EtapaDoFunil[] {
  const ocupadasPorOutros = new Set(
    LEAD_STAGES.filter((p) => p !== passo)
      .map((p) => mapa[p])
      .filter((id): id is string => id !== null),
  );
  return etapas.filter((e) => !ocupadasPorOutros.has(e.id) && serveParaOPasso(passo, e));
}

/**
 * Por que a lista está vazia — lista vazia muda é o pior desfecho possível:
 * o usuário conclui que a tela está quebrada.
 *
 * ⚠️ "JÁ ESTÃO EM USO" É UMA AFIRMAÇÃO, e só pode ser feita depois de conferir
 * que existe alguma etapa que serviria. Num funil só com ganho e perda, os cinco
 * passos comuns não têm nenhuma candidata — mandar "libere uma delas" ali seria
 * pedir para liberar uma etapa que não existe. Por isso o primeiro teste é
 * SEMPRE "existe candidata?", e só o segundo é sobre ocupação.
 *
 * As duas causas pedem respostas opostas: a ausência de etapa é fato sobre o
 * funil (e conserta-se na seção de ETAPAS, logo acima — hoje ela existe), a
 * ocupação é reversível aqui mesmo.
 */
export function motivoDaListaVazia(
  passo: LeadStage,
  etapas: EtapaDoFunil[],
  t: (texto: string) => string = (texto) => texto,
): string {
  if (etapas.some((e) => serveParaOPasso(passo, e))) {
    // Sem direção ("acima"): o passo que segura a etapa pode estar em qualquer
    // linha, inclusive abaixo desta.
    return t(
      "As etapas que serviriam para este passo já estão sendo usadas por outros passos. Libere uma delas para poder escolhê-la aqui.",
    );
  }
  if (passo === "won") {
    return t(
      "Este funil não tem nenhuma etapa marcada como fechamento, então não há para onde levar o card quando a pessoa fecha. Marque uma etapa como «aqui o cliente fecha» em «Etapas deste funil».",
    );
  }
  if (passo === "lost") {
    return t(
      "Este funil não tem nenhuma etapa marcada como perda, então não há para onde levar o card quando a pessoa desiste. Marque uma etapa como «aqui o cliente desiste» em «Etapas deste funil».",
    );
  }
  return t(
    "Este funil só tem etapas de fechamento e de perda, então não há etapa comum para receber o card neste passo. Crie as etapas do meio do caminho em «Etapas deste funil».",
  );
}

/**
 * A lacuna se conserta na seção de ETAPAS, e não aqui — é quando vale mostrar o
 * link para lá.
 *
 * Definida pela MESMA condição de `motivoDaListaVazia` (a negação do primeiro
 * ramo, sobre o mesmo `serveParaOPasso`) de propósito: um segundo critério para
 * decidir a mesma coisa acabaria mandando o usuário para a seção errada. O teste
 * de coerência entre as duas está em `_mapping.test.tsx`.
 */
export function conserteNasEtapas(passo: LeadStage, etapas: EtapaDoFunil[]): boolean {
  return !etapas.some((e) => serveParaOPasso(passo, e));
}

/**
 * ⚠️ NEM TODA MENSAGEM DO SERVIDOR É TEXTO DE TELA.
 *
 * As recusas de REGRA (409/422) foram escritas em português, citam o nome da
 * etapa e ensinam o que fazer — vão inteiras para o usuário, e é para isso que
 * a camada pura existe. O MESMO canal, porém, carrega frase de infraestrutura:
 * «Permissão insuficiente. Requer role >= manager» (a palavra "role" na tela do
 * dono de clínica) e, nos 500, texto cru do Postgres em inglês — exatamente o
 * que o docblock de `agent-mapping.ts` diz existir para evitar. Imprimir tudo
 * verbatim traz de volta pela porta dos fundos o que a Task 1 fechou.
 */
export function mensagemDeErro(
  e: unknown,
  t: (texto: string) => string = (texto) => texto,
): string {
  if (e instanceof ApiError) {
    if (e.status === 409 || e.status === 422) return t(e.message);
    if (e.status === 401)
      return t("Sua sessão expirou. Entre de novo para salvar suas escolhas.");
    if (e.status === 403)
      return t("Você não tem permissão para mudar a configuração deste funil.");
  }
  return t("Não deu para salvar agora. Tente de novo em instantes.");
}

function iguais(a: MapaDoAgente, b: MapaDoAgente): boolean {
  return LEAD_STAGES.every((p) => a[p] === b[p]);
}

export function AgentMappingSection({
  pipelineId,
  ancoraEtapas,
}: {
  pipelineId: string;
  /** Onde o dono do funil cria a etapa que falta ou marca a de fechamento/perda. */
  ancoraEtapas: string;
}) {
  const t = useT();
  const consulta = useAgentMapping(pipelineId);
  const salvar = useSaveAgentMapping(pipelineId);
  const [rascunho, setRascunho] = useState<MapaDoAgente | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const ultimaLeitura = useRef(0);

  // ⚠️ TODA LEITURA NOVA DO SERVIDOR SUBSTITUI O RASCUNHO — inclusive a releitura
  // que o erro dispara. É o que impede o usuário de reenviar sobre um funil que
  // mudou embaixo dele: sem isto, o segundo envio grava por cima da decisão de
  // outra pessoa e ninguém fica sabendo. `dataUpdatedAt` e não a referência de
  // `data`: o react-query preserva a referência quando o conteúdo volta igual, e
  // aí o rascunho velho sobreviveria justamente ao caso que motivou a releitura.
  const { data, dataUpdatedAt } = consulta;
  useEffect(() => {
    if (!data || dataUpdatedAt === ultimaLeitura.current) return;
    ultimaLeitura.current = dataUpdatedAt;
    setRascunho(data.mapeamento);
  }, [data, dataUpdatedAt]);

  if (consulta.isError) {
    return (
      <p className="text-sm text-text-muted" data-testid="mapeamento-erro-leitura">
        {t("Não foi possível carregar as etapas deste funil agora. Recarregue a página.")}
      </p>
    );
  }
  if (!data || !rascunho) {
    return (
      <p className="text-sm text-text-muted" data-testid="mapeamento-carregando">
        {t("Carregando as etapas deste funil…")}
      </p>
    );
  }

  const etapas = data.etapas;
  const mudou = !iguais(rascunho, data.mapeamento);
  const gravando = salvar.isPending || consulta.isFetching;

  function escolher(passo: LeadStage, valor: string) {
    setErro(null);
    setRascunho((atual) =>
      atual ? { ...atual, [passo]: valor === SEM_ETAPA ? null : valor } : atual,
    );
  }

  function enviar() {
    if (!rascunho) return;
    setErro(null);
    // Os SETE passos, sempre — `null` explícito é "não mover", e a rota recusa
    // corpo parcial com 422.
    salvar.mutate(rascunho, {
      // Sucesso em toast, igual ao resto da tela (e do app). O ERRO fica inline
      // e persistente de propósito: ele explica por que as escolhas na frente do
      // usuário mudaram sozinhas, e um toast some antes de ele ler.
      onSuccess: () => toast.success(t("Escolhas salvas.")),
      onError: (e) => setErro(mensagemDeErro(e, t)),
    });
  }

  return (
    <div
      className="space-y-4"
      id={ancoraDoMapeamento(pipelineId)}
      data-testid={`mapeamento-${pipelineId}`}
    >
      <div className="space-y-1">
        {/* "O funil do agente" seria o nome óbvio e é o errado: a página inteira
            se chama Funis e trata dos funis do tenant. Duas coisas diferentes
            com o mesmo nome, na mesma tela, fazem o dono da clínica procurar um
            segundo funil que não existe. O título diz o que a seção FAZ. */}
        <h3 className="text-sm font-semibold">{t("Para onde o card vai em cada passo")}</h3>
        <p className="max-w-3xl text-sm leading-relaxed text-text-muted">
          {t(
            "Quando o agente avança no atendimento, o card do cliente pode andar sozinho no seu funil. Escolha para qual etapa ele vai em cada momento. Deixar em «não mover» é uma escolha válida — o card fica onde está e o agente segue trabalhando.",
          )}
        </p>
      </div>

      <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border">
        {LEAD_STAGES.map((passo) => {
          const opcoes = opcoesDoPasso(passo, etapas, rascunho);
          // A etapa já escolhida some das opções DOS OUTROS passos, nunca das
          // suas — por isso lista vazia implica escolha nenhuma, e o Select
          // nunca fica com um valor sem rótulo.
          const escolhida = rascunho[passo];
          return (
            <li
              key={passo}
              className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:gap-4"
              data-testid={`passo-${passo}`}
            >
              <div className="min-w-0 sm:w-64">
                <p className="text-sm font-medium">{t(ROTULO_DO_PASSO[passo])}</p>
                <p className="text-xs text-text-muted">{t(QUANDO_ACONTECE[passo])}</p>
              </div>
              <ArrowRight
                size={16}
                className="hidden shrink-0 text-text-muted sm:block"
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                {opcoes.length === 0 ? (
                  <p className="text-xs leading-relaxed text-text-muted" data-testid={`vazio-${passo}`}>
                    {motivoDaListaVazia(passo, etapas, t)}
                    {/* O ciclo se fecha aqui: o mapeamento APONTA a lacuna, a
                        seção de etapas RESOLVE. Sem o link, o texto acima é um
                        diagnóstico que manda o usuário procurar sozinho a tela
                        que conserta — e a Task anterior mostrou que ele não
                        procura, desiste. */}
                    {conserteNasEtapas(passo, etapas) && (
                      <>
                        {" "}
                        <a
                          className="underline underline-offset-2"
                          href={`#${ancoraEtapas}`}
                          data-testid={`ir-para-etapas-${passo}`}
                        >
                          {t("Ir para as etapas do funil")}
                        </a>
                        .
                      </>
                    )}
                  </p>
                ) : (
                  <Select
                    value={escolhida ?? SEM_ETAPA}
                    onValueChange={(v) => escolher(passo, v)}
                  >
                    <SelectTrigger
                      aria-label={`${t("Etapa para")} «${t(ROTULO_DO_PASSO[passo])}»`}
                      data-testid={`etapa-${passo}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SEM_ETAPA}>{t("Não mover o card")}</SelectItem>
                      {opcoes.map((e) => (
                        <SelectItem key={e.id} value={e.id}>
                          {e.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {erro && (
        <Card
          className="flex items-start gap-3 border-warning bg-warning-bg p-4"
          data-testid="mapeamento-erro"
        >
          <Warning size={18} className="mt-0.5 shrink-0 text-warning-fg" aria-hidden />
          <p className="text-sm leading-relaxed">
            {erro}{" "}
            {t(
              "As escolhas voltaram para o que está gravado agora — confira e escolha de novo.",
            )}
          </p>
        </Card>
      )}

      <div className="flex items-center justify-end gap-3">
        <Button onClick={enviar} disabled={!mudou || gravando} data-testid="salvar-mapeamento">
          {gravando ? t("Salvando…") : t("Salvar estas escolhas")}
        </Button>
      </div>
    </div>
  );
}
