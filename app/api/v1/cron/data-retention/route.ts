/**
 * GET/POST /api/v1/cron/data-retention — issue #261.
 *
 * As duas tabelas que crescem sozinhas numa instalação parada — `job_queue` e
 * `api_audit_log` — não tinham poda nenhuma. Medido no HEAD anterior:
 *
 *     $ grep -rn "from job_queue" lib workers app supabase scripts | grep -i delete
 *     (zero linhas)
 *
 * E a retenção de 5 anos do audit existia só no `COMMENT ON TABLE` e em seis
 * documentos. O plano free do Supabase limita **500 MB de banco**: estas duas
 * estouram antes de qualquer tabela de negócio, e o bloat ainda cobra CPU (715
 * buffers varridos no `count(*)` do claim com zero linhas vivas, issue #260).
 *
 * O que ele faz, e o que deliberadamente NÃO faz:
 *
 *   - chama `fn_podar_fila_de_jobs` e `fn_expurgar_auditoria_vencida` EM LOTES.
 *     Um DELETE grande num banco de cliente trava a tabela e o tempo do lock
 *     cresce com o backlog; lotes de `TAMANHO_DO_LOTE` fecham a transação a cada
 *     rodada e o backlog drena ao longo de vários dias, sem janela de manutenção;
 *   - **não decide o que é podável.** As duas regras (quais status são terminais,
 *     o que ainda tem dono, o piso da retenção) moram DENTRO das funções do
 *     banco, porque lá elas valem para qualquer chamador — inclusive um `psql`
 *     na mão. Este arquivo é só o relógio e o laço;
 *   - **não faz VACUUM.** Espaço liberado por DELETE volta a ser reutilizável
 *     pelo autovacuum, mas só um `VACUUM FULL` (que trava a tabela) o devolve ao
 *     sistema de arquivos. Rodar isso sozinho num banco de cliente, de
 *     madrugada, sem ninguém olhando, é pior que a cota apertada. O runbook
 *     `docs/runbooks/custo-e-cota-do-supabase.md` traz o comando para quem
 *     decidir pagar o lock;
 *   - **não audita rodada vazia.** Varredura que não apagou nada não é mutação
 *     (mesmo critério do snooze-watcher, do followup-flow-worker e do
 *     recover-stuck-messages). Um cron diário que auditasse sempre seria mais
 *     uma fonte do problema que ele existe para resolver. A ÚNICA exceção é a
 *     rodada que FALHOU: sem ela, uma poda que parou de funcionar num clone
 *     ficaria idêntica, na trilha, a uma poda sem nada a fazer.
 *
 * O laço de retorno desta peça é a própria trilha. `retention.sweep_run` aparece
 * no painel de auditoria (o código vem de `AUDIT_ACTIONS`, então entra no filtro
 * sozinho), e o runbook `docs/runbooks/custo-e-cota-do-supabase.md` §4.1 ensina
 * o comando que separa "não havia nada vencido" de "o cron não está rodando" —
 * as duas leituras possíveis da ausência de linhas, que sem isso se confundem.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|
 * INTERNAL_SECRET, fail-closed).
 *
 * NOTA DE DEPLOY: não há `vercel.json` neste repo (self-host). O agendamento
 * vive no serviço `scheduler` (docker/scheduler/entrypoint.sh), diário.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  RETENCAO_AUDITORIA_DIAS_PADRAO,
  RETENCAO_AUDITORIA_DIAS_PISO,
  RETENCAO_CANDIDATOS_GOLDEN_DIAS_PADRAO,
  RETENCAO_CANDIDATOS_GOLDEN_DIAS_PISO,
  RETENCAO_CHECKPOINTS_DIAS_PADRAO,
  RETENCAO_CHECKPOINTS_DIAS_PISO,
  RETENCAO_COPIAS_ENVIADAS_DIAS_PADRAO,
  RETENCAO_COPIAS_ENVIADAS_DIAS_PISO,
  RETENCAO_RITMO_DE_ENVIO_DIAS_PADRAO,
  RETENCAO_RITMO_DE_ENVIO_DIAS_PISO,
  RETENCAO_TELEMETRIA_DE_IA_DIAS_PADRAO,
  RETENCAO_TELEMETRIA_DE_IA_DIAS_PISO,
  RETENCAO_AVISO_DE_CASO_DIAS_PADRAO,
  RETENCAO_AVISO_DE_CASO_DIAS_PISO,
  RETENCAO_CONVERSA_DO_CASO_DIAS_PADRAO,
  RETENCAO_CONVERSA_DO_CASO_DIAS_PISO,
  RETENCAO_ESPELHO_AGENDA_DIAS_PADRAO,
  RETENCAO_ESPELHO_AGENDA_DIAS_PISO,
  RETENCAO_FILA_DIAS_PADRAO,
  RETENCAO_FILA_DIAS_PISO,
  RETENCAO_MIDIA_DIAS_PISO,
  RETENCAO_OBSERVACOES_DO_JEV_DIAS_PADRAO,
  RETENCAO_OBSERVACOES_DO_JEV_DIAS_PISO,
  RETENCAO_PASSAGEM_DIAS_PADRAO,
  RETENCAO_PASSAGEM_DIAS_PISO,
  RETENCAO_PROSPECCAO_DIAS_PADRAO,
  RETENCAO_PROSPECCAO_DIAS_PISO,
  RETENCAO_RASCUNHO_DIAS_PADRAO,
  RETENCAO_RASCUNHO_DIAS_PISO,
  interpretarRetencao,
} from "@/lib/retencao/politica";
import {
  varrerRedacoesIncompletas,
  type ClienteDaCascata,
  type ResultadoDaVarredura,
} from "@/lib/lgpd/cascata";
import {
  BUCKET_DOS_ARQUIVOS_DA_ABORDAGEM,
  type ArquivoDaAbordagemNoBucket,
  type ClienteDeStorageDaAbordagem,
  drenarArquivosOrfaosDaAbordagem,
  type FonteDaProspeccao,
  type ResultadoDoDrenoDaAbordagem,
} from "@/lib/prospecting/arquivos-orfaos-da-abordagem";
import { createAdminClient } from "@/lib/supabase/admin";
import { lerPaginado } from "@/lib/supabase/pagina";

export const dynamic = "force-dynamic";

/**
 * Linhas por transação. Pequeno o bastante para o lock não ser sentido por quem
 * está usando o sistema, grande o bastante para drenar um backlog de anos em
 * poucos dias de rodadas.
 */
export const TAMANHO_DO_LOTE = 1000;

/**
 * Teto de lotes POR TABELA e por invocação. Sem ele, a primeira rodada numa
 * instalação antiga tentaria apagar tudo de uma vez e seguraria a conexão do
 * cron (timeout de 120 s no crontab) até o `curl` desistir — deixando a
 * transação do último lote para o servidor abortar sozinho.
 */
export const MAX_LOTES = 20;

export interface ResultadoDaRetencao {
  jobs_apagados: number;
  auditoria_apagada: number;
  lotes_fila: number;
  lotes_auditoria: number;
  /** O último lote veio cheio e o teto foi atingido: sobrou trabalho para amanhã. */
  fila_tem_resto: boolean;
  auditoria_tem_resto: boolean;
  /** Os nonces de OAuth do Google já queimados (migration 0190). */
  nonces_apagados: number;
  /** As chaves de idempotência vencidas há mais de 1 dia (migration 9506, #1613). */
  chaves_de_idempotencia_apagadas: number;
  lotes_chaves_de_idempotencia: number;
  chaves_de_idempotencia_tem_resto: boolean;
  /** O espelho da agenda conectada — cache com prazo (migration 0187). */
  espelho_apagado: number;
  lotes_espelho: number;
  espelho_tem_resto: boolean;
  /** A conversa da equipe com a IA sobre um caso (migration 0281). */
  conversa_do_caso_apagada: number;
  lotes_conversa_do_caso: number;
  conversa_do_caso_tem_resto: boolean;
  /** O registro da passagem do atendimento para uma pessoa (migration 0291). */
  passagens_apagadas: number;
  lotes_passagens: number;
  passagens_tem_resto: boolean;
  /** O registro de entrega do aviso de caso no WhatsApp da equipe (0292). */
  avisos_de_caso_apagados: number;
  lotes_avisos_de_caso: number;
  avisos_de_caso_tem_resto: boolean;
  /** O registro de entrega do aviso de agendamento no WhatsApp do dono (0753). */
  avisos_de_agendamento_apagados: number;
  lotes_avisos_de_agendamento: number;
  avisos_de_agendamento_tem_resto: boolean;
  /** O candidato de prospecção nativa vencido (migration 0408, issue #1313). */
  prospeccao_apagada: number;
  lotes_prospeccao: number;
  prospeccao_tem_resto: boolean;
  /** A observação do Jev vencida — rótulos, sem texto de cliente (migration 0421). */
  observacoes_do_jev_apagadas: number;
  lotes_observacoes_do_jev: number;
  observacoes_do_jev_tem_resto: boolean;
  /** O rascunho sugerido por integração já vencido (migration 0419, issue #1686). */
  rascunhos_apagados: number;
  lotes_rascunhos: number;
  rascunhos_tem_resto: boolean;
  retencao_rascunho_dias: number;
  /** O candidato ao golden set vencido — rótulo, sem texto de cliente (0428). */
  candidatos_do_golden_apagados: number;
  lotes_candidatos_do_golden: number;
  candidatos_do_golden_tem_resto: boolean;
  /**
   * A MÍDIA de mensagem vencida enfileirada para remoção (migration 0557,
   * issue #1534) — `vencidas + orfas` do `fn_enfileirar_midia_vencida`, a mesma
   * leitura do cron `media-retention`. Os dois crons chamam a MESMA função: a
   * delas (05:20) drena `whatsapp-media` por conta própria, esta (04:40) é o
   * dreno que o autor do #1534 confirmou — cada um para no primeiro lote
   * incompleto, então a dupla só acelera quem já teria drenado sozinho.
   */
  midia_enfileirada: number;
  /** A linha `deleted` da FILA DE MÍDIA expurgada nesta rodada (0435/#1765). */
  midia_expurgada: number;
  lotes_midia: number;
  midia_tem_resto: boolean;
  /**
   * O piso de 30 dias da mídia, em número de relatório. Diferente das irmãs, o
   * prazo da mídia é POR ORGANIZAÇÃO (`organizations.media_retention_days`) e
   * mora dentro do `greatest(...)` do corpo da função — o que se reporta aqui é
   * o degrau abaixo do qual nenhum banco pode ir.
   */
  retencao_midia_dias: number;
  /** A telemetria da IA vencida — llm_calls, metrics, skill_activations, ai_router_decisions (0587). */
  telemetria_de_ia_apagada: number;
  lotes_telemetria_de_ia: number;
  telemetria_de_ia_tem_resto: boolean;
  retencao_telemetria_de_ia_dias: number;
  /** O ritmo de envio vencido — pacing_ledger, menos a última linha de cada número (0587). */
  ritmo_de_envio_apagado: number;
  lotes_ritmo_de_envio: number;
  ritmo_de_envio_tem_resto: boolean;
  retencao_ritmo_de_envio_dias: number;
  /** As cópias enviadas vencidas — outbound_copies, menos a janela do anti-repetição (0587). */
  copias_enviadas_apagadas: number;
  lotes_copias_enviadas: number;
  copias_enviadas_tem_resto: boolean;
  retencao_copias_enviadas_dias: number;
  /** Os checkpoints superados — nunca o último da fronteira nem o de job vivo (0587). */
  checkpoints_apagados: number;
  lotes_checkpoints: number;
  checkpoints_tem_resto: boolean;
  retencao_checkpoints_dias: number;
  /**
   * O traço do turno vencido (migration 9021, issue #3201) — uma linha por
   * execução do agente, e a poda de MAIOR volume da rodada depois da telemetria.
   *
   * Sem janela própria de propósito: a issue #3201 deixou aberta a escolha
   * ("variável nova ou a janela da telemetria?") e a resposta é a segunda — o
   * traço É telemetria da IA. `retencao_traco_dias` está no relatório porque
   * quem lê a rodada precisa ver o prazo que foi APLICADO, e não deduzi-lo do
   * nome de outra poda.
   */
  tracos_apagados: number;
  lotes_tracos: number;
  tracos_tem_resto: boolean;
  retencao_traco_dias: number;
  retencao_fila_dias: number;
  retencao_auditoria_dias: number;
  retencao_espelho_dias: number;
  retencao_conversa_do_caso_dias: number;
  retencao_passagem_dias: number;
  retencao_aviso_de_caso_dias: number;
  retencao_prospeccao_dias: number;
  retencao_observacoes_do_jev_dias: number;
  retencao_candidatos_do_golden_dias: number;
  /**
   * ARQUIVOS ÓRFÃOS DA PRIMEIRA ABORDAGEM removidos do Storage nesta rodada
   * (#5139). A limpeza é o buraco que `fn_enfileirar_midia_vencida` não
   * alcança: ela só enxerga LINHAS de banco, e o arquivo que nenhuma campanha
   * referencia não tem linha. Aqui o bucket é listado direto.
   *
   * `removidos` é a contagem; `trilha` é o caminho e os bytes de cada um (os
   * bytes só aparecem quando o `list` do Storage informa o tamanho). A trilha
   * entra no metadata do `retention.sweep_run`.
   */
  arquivos_orfaos_da_abordagem_removidos: number;
  arquivos_orfaos_da_abordagem_bytes: number;
  arquivos_orfaos_da_abordagem_trilha: Array<{ caminho: string; bytes: number | null }>;
  /** Avisos de configuração — nunca ausentes em silêncio quando existem. */
  avisos: string[];
  /**
   * Os drenos que FALHARAM nesta rodada, um por linha (`"fn_x: motivo"`).
   *
   * A rodada deixou de ser tudo-ou-nada (#2508): cada poda falha sozinha e as
   * demais seguem. Uma função ausente num clone (grant que não veio, timeout)
   * não pode impedir as OUTRAS podas nem a retomada de anonimização, que
   * divide o relógio com elas. A falha entra aqui NOMEADA — é o que mantém a
   * doutrina da casa: aberta na ação e aberta na informação, nunca engolida.
   */
  falhas: string[];
}

/** Só a superfície que este cron usa — o teste injeta uma implementação. */
export interface PodaDb {
  rpc(
    nome:
      | "fn_podar_fila_de_jobs"
      | "fn_expurgar_auditoria_vencida"
      | "fn_expurgar_espelho_da_agenda"
      | "fn_expurgar_nonces_de_oauth"
      | "fn_expurgar_chaves_de_idempotencia_vencidas"
      | "fn_expurgar_conversa_do_caso_vencida"
      | "fn_expurgar_passagens_vencidas"
      | "fn_expurgar_avisos_de_caso_vencidos"
      | "fn_expurgar_avisos_de_agendamento_vencidos"
      | "fn_expurgar_prospeccao_vencida"
      | "fn_expurgar_observacoes_do_jev"
      | "fn_expurgar_candidatos_do_golden"
      | "fn_expurgar_telemetria_de_ia_vencida"
      | "fn_expurgar_ritmo_de_envio_vencido"
      | "fn_expurgar_copias_enviadas_vencidas"
      | "fn_expurgar_checkpoints_superados"
      | "fn_expurgar_traco_do_turno_vencido",
    args: { p_retencao_dias: number; p_limite: number },
  ): Promise<{ data: number | null; error: { message: string } | null }>;
  /**
   * A DÉCIMA segunda poda (migration 0557, issue #1534): a retenção de mídia.
   *
   * Método PRÓPRIO, e não mais uma entrada na união do `rpc` — mesma exceção do
   * rascunho e pela razão inversa: `fn_enfileirar_midia_vencida` recebe UM
   * argumento (`p_limite`) e devolve JSONB (`{vencidas, orfas, expurgadas}`),
   * enquanto o `rpc` das irmãs recebe `p_retencao_dias` + `p_limite` e devolve
   * número. Mandar `p_retencao_dias` para ela é PGRST202 (função não existe
   * para essa assinatura) e ler o JSONB como número é NaN calado no relatório.
   *
   * O prazo NÃO vem daqui: ele é por organização (`media_retention_days`) e
   * mora dentro do `greatest(...)` do corpo da função, com o piso de 30 dias.
   */
  enfileirarMidia(
    lote: number,
  ): Promise<{ data: RetornoDaFilaDeMidia | null; error: { message: string } | null }>;
  /**
   * A DÉCIMA poda é a única que não é `security definer`: a tabela 0419 nunca
   * teve função de expurgo, então o corte (`expires_at` mais velho que o prazo)
   * é calculado em TypeScript e chega AQUI pronto — a mesma exceção declarada
   * para a captação em `lib/retencao/politica.ts`. Mesmo contrato de retorno do
   * `rpc`: contagem ou erro, nunca silêncio.
   */
  apagarRascunhos(
    vencidosAntesDe: string,
    lote: number,
  ): Promise<{ data: number | null; error: { message: string } | null }>;
}

/**
 * Um dreno interrompido NO MEIO carrega o parcial (sugestão 1 do #2645).
 *
 * As três podas apagam em lotes de 1000; quando o banco falha no lote 4 de 20,
 * os 3 lotes anteriores JÁ foram apagados — e o relatório registrava 0. No caso
 * do expurgo da auditoria isso é pior que um número feio: linhas de auditoria
 * apagadas ficavam contadas como zero NA PRÓPRIA TRILHA. A classe carrega as
 * contagens até a falha para o `executarDreno` devolvê-las ao relatório.
 */
class DrenoInterrompido<T> extends Error {
  constructor(
    mensagem: string,
    readonly parcial: T,
  ) {
    super(mensagem);
    this.name = "DrenoInterrompido";
  }
}

async function drenar(
  db: PodaDb,
  nome:
    | "fn_podar_fila_de_jobs"
    | "fn_expurgar_auditoria_vencida"
    | "fn_expurgar_espelho_da_agenda"
    | "fn_expurgar_nonces_de_oauth"
    | "fn_expurgar_chaves_de_idempotencia_vencidas"
    | "fn_expurgar_conversa_do_caso_vencida"
    | "fn_expurgar_passagens_vencidas"
    | "fn_expurgar_avisos_de_caso_vencidos"
    | "fn_expurgar_avisos_de_agendamento_vencidos"
    | "fn_expurgar_prospeccao_vencida"
    | "fn_expurgar_observacoes_do_jev"
    | "fn_expurgar_candidatos_do_golden"
    | "fn_expurgar_telemetria_de_ia_vencida"
    | "fn_expurgar_ritmo_de_envio_vencido"
    | "fn_expurgar_copias_enviadas_vencidas"
    | "fn_expurgar_checkpoints_superados"
    | "fn_expurgar_traco_do_turno_vencido",
  dias: number,
): Promise<{ apagadas: number; lotes: number; temResto: boolean }> {
  let apagadas = 0;
  let lotes = 0;
  for (let i = 0; i < MAX_LOTES; i += 1) {
    const { data, error } = await db.rpc(nome, {
      p_retencao_dias: dias,
      p_limite: TAMANHO_DO_LOTE,
    });
    if (error) {
      throw new DrenoInterrompido(`${nome}: ${error.message}`, { apagadas, lotes, temResto: false });
    }
    const n = data ?? 0;
    lotes += 1;
    apagadas += n;
    // Lote incompleto = a ponta velha acabou. Encerra sem gastar mais uma ida
    // ao banco só para ouvir zero.
    if (n < TAMANHO_DO_LOTE) return { apagadas, lotes, temResto: false };
  }
  return { apagadas, lotes, temResto: true };
}

/**
 * A décima poda (issue #1686): o rascunho sugerido por integração já vencido.
 *
 * Mesmo laço de `drenar` — par no lote incompleto, teto por invocação, `temResto`
 * quando o teto fecha — e a MESMA regra de erro: sobe. O que é diferente é a
 * origem do corte, e ela é o motivo deste helper existir em vez de mais uma
 * entrada na união do `rpc`: `conversation_drafts` não tem função de expurgo,
 * então `p_retencao_dias` não existe para onde ir, e o corte nasce aqui,
 * já convertido em instante absoluto (`expires_at` mais velho que o prazo).
 *
 * O relógio é `expires_at`, nunca `created_at` (como o espelho da agenda corta
 * por `ends_at`): uma janela de 72 h pede 72 h de janela, e cortar pela criação
 * apagaria rascunho que AINDA ABRIRIA o link.
 */
async function drenarRascunhos(
  db: PodaDb,
  dias: number,
): Promise<{ apagadas: number; lotes: number; temResto: boolean }> {
  const corte = new Date(Date.now() - dias * 86_400_000).toISOString();
  let apagadas = 0;
  let lotes = 0;
  for (let i = 0; i < MAX_LOTES; i += 1) {
    const { data, error } = await db.apagarRascunhos(corte, TAMANHO_DO_LOTE);
    if (error) {
      throw new DrenoInterrompido(`conversation_drafts: ${error.message}`, {
        apagadas,
        lotes,
        temResto: false,
      });
    }
    const n = data ?? 0;
    lotes += 1;
    apagadas += n;
    if (n < TAMANHO_DO_LOTE) return { apagadas, lotes, temResto: false };
  }
  return { apagadas, lotes, temResto: true };
}

/**
 * O retorno JSONB do `fn_enfileirar_midia_vencida` (0432/0557).
 *
 * Três chaves, e a leitura delas é o relatório da rodada: `vencidas` (mensagem
 * vencida), `orfas` (arquivo sem ponteiro) e `expurgadas` (linha `deleted` da
 * fila, 0435/#1765). Todas opcionais porque uma função antiga no banco devolve
 * só as duas primeiras — mesmo `?? 0` do cron `media-retention`.
 */
export interface RetornoDaFilaDeMidia {
  vencidas?: number;
  orfas?: number;
  expurgadas?: number;
}

/**
 * A décima segunda poda (migration 0557, issue #1534): a retenção de mídia.
 *
 * Mesmo laço de `drenar` — par no lote incompleto, teto por invocação,
 * `temResto` quando o teto fecha — e a MESMA regra de erro: sobe. As duas
 * diferenças são de formato, não de regra: o argumento é SÓ o lote (o prazo é
 * por organização e mora no `greatest(...)` do corpo da função) e a contagem
 * vem em JSONB.
 *
 * O par é a SOMA de `vencidas` com `orfas`, porque as duas põem arquivo na mesma
 * fila e o relatório pergunta "quanto saiu do caminho do banco"; `expurgadas` é
 * contada à parte porque ela apaga LINHA DE FILA, não mídia — quem só expurgou
 * audita (é mutação), mas não enfileirou nada para remoção.
 */
async function drenarMidia(
  db: PodaDb,
): Promise<{ enfileirada: number; expurgada: number; lotes: number; temResto: boolean }> {
  let enfileirada = 0;
  let expurgada = 0;
  let lotes = 0;
  for (let i = 0; i < MAX_LOTES; i += 1) {
    const { data, error } = await db.enfileirarMidia(TAMANHO_DO_LOTE);
    if (error) {
      throw new DrenoInterrompido(`fn_enfileirar_midia_vencida: ${error.message}`, {
        enfileirada,
        expurgada,
        lotes,
        temResto: false,
      });
    }
    const r = (typeof data === "object" && data !== null ? data : {}) as RetornoDaFilaDeMidia;
    const vencidas = r.vencidas ?? 0;
    const orfas = r.orfas ?? 0;
    expurgada += r.expurgadas ?? 0;
    enfileirada += vencidas + orfas;
    lotes += 1;
    // Par em qualquer uma das duas categorias, como no cron `media-retention`:
    // `vencidas` esgotou mas `orfas` ainda tem o teto = ainda há o que drenar.
    if (vencidas < TAMANHO_DO_LOTE && orfas < TAMANHO_DO_LOTE) {
      return { enfileirada, expurgada, lotes, temResto: false };
    }
  }
  return { enfileirada, expurgada, lotes, temResto: true };
}

/**
 * Cada dreno falha SOZINHO (issue #2508).
 *
 * Antes, o primeiro `throw` de um `drenar` abortava a rodada inteira: as podas
 * seguintes não rodavam, a retomada de anonimização (SLA D+15) era PULADA e a
 * trilha registrava só `{falhou, erro}` — o que já tinha sido apagado nas
 * tabelas anteriores sumia da auditoria. Agora a falha vira uma linha nomeada
 * em `falhas`, e a rodada segue: um grant que não veio num clone derruba UMA
 * tabela, não o dia.
 *
 * `emFalha` é o relatório da poda que não aconteceu (contagens zeradas ou o
 * formato próprio da mídia) — o resultado continua tendo a MESMA forma, para o
 * JSON e `houveEfeito` não precisarem saber que houve falha.
 */
async function executarDreno<T>(
  falhas: string[],
  nome: string,
  tarefa: () => Promise<T>,
  emFalha: T,
): Promise<T> {
  try {
    return await tarefa();
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : String(err);
    // O nome sai UMA vez: as três tarefas já prefixam a própria mensagem
    // (`fn_x: motivo`), e o prefixo daqui a duplicava (`fn_x: fn_x: motivo`).
    const nomeado = detalhe.startsWith(nome) ? detalhe : `${nome}: ${detalhe}`;
    // Mesmo teto do caminho antigo de falha total (300 caracteres): falha de
    // banco cabe num aviso, e mensagem de provider pode vir enorme.
    falhas.push(nomeado.slice(0, 300));
    // O parcial dos lotes que JÁ passaram volta ao relatório (sugestão 1 do
    // #2645): sem isto, o expurgo da auditoria registraria 0 na própria trilha
    // para linhas que ele apagou de verdade. Erro sem parcial (inesperado) cai
    // no zerado de sempre.
    if (err instanceof DrenoInterrompido) return err.parcial as T;
    return emFalha;
  }
}

/**
 * Separado do handler HTTP para o teste exercitar a REGRA (o laço de lotes, o
 * teto, o corte no lote incompleto) sem montar request/auth — mesmo desenho de
 * `recoverStuckMessages`.
 */
export async function podarHistorico(
  db: PodaDb,
  ambiente: {
    JOB_QUEUE_RETENTION_DAYS?: string;
    AUDIT_LOG_RETENTION_DAYS?: string;
    CALENDAR_MIRROR_RETENTION_DAYS?: string;
    CASE_CHAT_RETENTION_DAYS?: string;
    PASSAGEM_RETENTION_DAYS?: string;
    CASE_ALERT_RETENTION_DAYS?: string;
    PROSPECCAO_RETENTION_DAYS?: string;
    JEV_OBSERVACOES_RETENTION_DAYS?: string;
    DRAFT_RETENTION_DAYS?: string;
    GOLDEN_CANDIDATES_RETENTION_DAYS?: string;
    AI_TELEMETRY_RETENTION_DAYS?: string;
    PACING_LEDGER_RETENTION_DAYS?: string;
    OUTBOUND_COPIES_RETENTION_DAYS?: string;
    LEAD_CHECKPOINT_RETENTION_DAYS?: string;
  },
  /**
   * A limpeza de arquivos órfãos da abordagem (#5139), injetada pelo `handle`
   * porque depende do client de Storage, não do `PodaDb` das podas de banco.
   * Ausente nos testes antigos que medem só as podas — o dreno é simplesmente
   * pulado, como se a instalação não tivesse nenhum arquivo a varrer.
   */
  arquivosOrfaosDaAbordagem?: () => Promise<ResultadoDoDrenoDaAbordagem>,
): Promise<ResultadoDaRetencao> {
  const fila = interpretarRetencao(ambiente.JOB_QUEUE_RETENTION_DAYS, {
    chave: "JOB_QUEUE_RETENTION_DAYS",
    padrao: RETENCAO_FILA_DIAS_PADRAO,
    piso: RETENCAO_FILA_DIAS_PISO,
  });
  const auditoria = interpretarRetencao(ambiente.AUDIT_LOG_RETENTION_DAYS, {
    chave: "AUDIT_LOG_RETENTION_DAYS",
    padrao: RETENCAO_AUDITORIA_DIAS_PADRAO,
    piso: RETENCAO_AUDITORIA_DIAS_PISO,
  });

  const espelho = interpretarRetencao(ambiente.CALENDAR_MIRROR_RETENTION_DAYS, {
    chave: "CALENDAR_MIRROR_RETENTION_DAYS",
    padrao: RETENCAO_ESPELHO_AGENDA_DIAS_PADRAO,
    piso: RETENCAO_ESPELHO_AGENDA_DIAS_PISO,
  });

  const conversaDoCaso = interpretarRetencao(ambiente.CASE_CHAT_RETENTION_DAYS, {
    chave: "CASE_CHAT_RETENTION_DAYS",
    padrao: RETENCAO_CONVERSA_DO_CASO_DIAS_PADRAO,
    piso: RETENCAO_CONVERSA_DO_CASO_DIAS_PISO,
  });

  const passagem = interpretarRetencao(ambiente.PASSAGEM_RETENTION_DAYS, {
    chave: "PASSAGEM_RETENTION_DAYS",
    padrao: RETENCAO_PASSAGEM_DIAS_PADRAO,
    piso: RETENCAO_PASSAGEM_DIAS_PISO,
  });

  const avisoDeCaso = interpretarRetencao(ambiente.CASE_ALERT_RETENTION_DAYS, {
    chave: "CASE_ALERT_RETENTION_DAYS",
    padrao: RETENCAO_AVISO_DE_CASO_DIAS_PADRAO,
    piso: RETENCAO_AVISO_DE_CASO_DIAS_PISO,
  });

  const prospeccao = interpretarRetencao(ambiente.PROSPECCAO_RETENTION_DAYS, {
    chave: "PROSPECCAO_RETENTION_DAYS",
    padrao: RETENCAO_PROSPECCAO_DIAS_PADRAO,
    piso: RETENCAO_PROSPECCAO_DIAS_PISO,
  });

  const observacoesDoJev = interpretarRetencao(ambiente.JEV_OBSERVACOES_RETENTION_DAYS, {
    chave: "JEV_OBSERVACOES_RETENTION_DAYS",
    padrao: RETENCAO_OBSERVACOES_DO_JEV_DIAS_PADRAO,
    piso: RETENCAO_OBSERVACOES_DO_JEV_DIAS_PISO,
  });

  const rascunho = interpretarRetencao(ambiente.DRAFT_RETENTION_DAYS, {
    chave: "DRAFT_RETENTION_DAYS",
    padrao: RETENCAO_RASCUNHO_DIAS_PADRAO,
    piso: RETENCAO_RASCUNHO_DIAS_PISO,
  });

  const candidatosDoGolden = interpretarRetencao(ambiente.GOLDEN_CANDIDATES_RETENTION_DAYS, {
    chave: "GOLDEN_CANDIDATES_RETENTION_DAYS",
    padrao: RETENCAO_CANDIDATOS_GOLDEN_DIAS_PADRAO,
    piso: RETENCAO_CANDIDATOS_GOLDEN_DIAS_PISO,
  });

  const telemetriaDeIa = interpretarRetencao(ambiente.AI_TELEMETRY_RETENTION_DAYS, {
    chave: "AI_TELEMETRY_RETENTION_DAYS",
    padrao: RETENCAO_TELEMETRIA_DE_IA_DIAS_PADRAO,
    piso: RETENCAO_TELEMETRIA_DE_IA_DIAS_PISO,
  });

  const ritmoDeEnvio = interpretarRetencao(ambiente.PACING_LEDGER_RETENTION_DAYS, {
    chave: "PACING_LEDGER_RETENTION_DAYS",
    padrao: RETENCAO_RITMO_DE_ENVIO_DIAS_PADRAO,
    piso: RETENCAO_RITMO_DE_ENVIO_DIAS_PISO,
  });

  const copiasEnviadas = interpretarRetencao(ambiente.OUTBOUND_COPIES_RETENTION_DAYS, {
    chave: "OUTBOUND_COPIES_RETENTION_DAYS",
    padrao: RETENCAO_COPIAS_ENVIADAS_DIAS_PADRAO,
    piso: RETENCAO_COPIAS_ENVIADAS_DIAS_PISO,
  });

  const checkpoints = interpretarRetencao(ambiente.LEAD_CHECKPOINT_RETENTION_DAYS, {
    chave: "LEAD_CHECKPOINT_RETENTION_DAYS",
    padrao: RETENCAO_CHECKPOINTS_DIAS_PADRAO,
    piso: RETENCAO_CHECKPOINTS_DIAS_PISO,
  });

  // As falhas desta rodada, uma por dreno (ver `executarDreno`): a rodada
  // segue e cada uma é reportada pelo NOME.
  const falhas: string[] = [];
  const zerado = { apagadas: 0, lotes: 0, temResto: false };

  const jobs = await executarDreno(falhas, "fn_podar_fila_de_jobs", () => drenar(db, "fn_podar_fila_de_jobs", fila.dias), zerado);
  const linhas = await executarDreno(falhas, "fn_expurgar_auditoria_vencida", () => drenar(db, "fn_expurgar_auditoria_vencida", auditoria.dias), zerado);
  const eventos = await executarDreno(falhas, "fn_expurgar_espelho_da_agenda", () => drenar(db, "fn_expurgar_espelho_da_agenda", espelho.dias), zerado);
  // Quarta poda: os nonces de OAuth já queimados. O `state` vale dez minutos,
  // então um dia é folga de duas ordens de grandeza — e sem esta linha a tabela
  // cresceria para sempre, uma linha por conexão tentada, num produto que se
  // instala e ninguém monitora.
  const nonces = await executarDreno(falhas, "fn_expurgar_nonces_de_oauth", () => drenar(db, "fn_expurgar_nonces_de_oauth", 1), zerado);
  // As chaves de idempotência vencidas (migration 9506, #1613): ninguém as lê
  // depois de vencer (`lib/api/idempotency.ts` só aceita `expires_at > now()`),
  // e sem esta linha a tabela só crescia, com o recibo de cada envio dentro.
  // Mesma folga de 1 dia dos nonces: a reserva vale 60 s e o recibo 24 h, e a
  // linha recém-vencida pode ser a de um envio ainda gravando o recibo.
  const chavesDeIdempotencia = await executarDreno(
    falhas,
    "fn_expurgar_chaves_de_idempotencia_vencidas",
    () => drenar(db, "fn_expurgar_chaves_de_idempotencia_vencidas", 1),
    zerado,
  );
  // Quinta poda: a conversa da equipe com a IA sobre um caso (migration 0281).
  // O piso de 90 dias mora no CORPO da função; o número daqui é o que o
  // operador pediu, já elevado, e é ele que aparece no relatório da rodada.
  const conversas = await executarDreno(falhas, "fn_expurgar_conversa_do_caso_vencida", () => drenar(db, "fn_expurgar_conversa_do_caso_vencida", conversaDoCaso.dias), zerado);
  // Sexta poda: o registro da passagem do atendimento para uma pessoa (0291). O
  // piso de 90 dias mora no CORPO da função, como nas anteriores — e ela tem uma
  // segunda guarda que só ela tem: passagem NÃO RECONHECIDA nunca é apagada, em
  // nenhuma idade. Uma passagem aberta é alguém esperando resposta.
  const passagens = await executarDreno(falhas, "fn_expurgar_passagens_vencidas", () => drenar(db, "fn_expurgar_passagens_vencidas", passagem.dias), zerado);
  // Sétima poda: o registro de entrega do aviso de caso no WhatsApp da equipe
  // (0292). O piso de 30 dias mora no CORPO da função, como nas anteriores. Ela
  // não guarda o texto do aviso (só o resumo criptográfico dele), então o que se
  // poda aqui é volume de operação — e é a poda de horizonte mais curto das
  // sete, porque a única pergunta que a linha responde é de semanas.
  const avisosDeCaso = await executarDreno(falhas, "fn_expurgar_avisos_de_caso_vencidos", () => drenar(db, "fn_expurgar_avisos_de_caso_vencidos", avisoDeCaso.dias), zerado);
  // A do aviso de agendamento (0753) é a mesma pergunta de semanas sobre o
  // mesmo canal, e por isso segue o MESMO knob e o mesmo piso do aviso de caso:
  // dois knobs para "o aviso saiu?" seriam dois números para o operador errar.
  const avisosDeAgendamento = await executarDreno(falhas, "fn_expurgar_avisos_de_agendamento_vencidos", () => drenar(db, "fn_expurgar_avisos_de_agendamento_vencidos", avisoDeCaso.dias), zerado);
  // Oitava poda: o candidato de prospecção nativa vencido (migration 0408,
  // issue #1313). Padrão 365 / piso 90 — decisão do dono, alinhada ao
  // horizonte da conversa do caso e da captação. O piso mora no CORPO da
  // função; o relógio é `coalesce(attempted_at, created_at)`; `queued` e
  // `sending` ficam de fora em qualquer idade, e o tombstone de LGPD
  // (`suppression_salt is not null`) nunca entra — é ele que barra a
  // reimportação. É a primeira poda da casa cujo dado é de uma pessoa que
  // NUNCA falou com a empresa, então as duas guardas são a regra, não enfeite.
  const prospeccaoDrenada = await executarDreno(falhas, "fn_expurgar_prospeccao_vencida", () => drenar(db, "fn_expurgar_prospeccao_vencida", prospeccao.dias), zerado);
  // Nona poda: as observações do Jev (0421). Padrão 90 / piso 30, a janela da
  // concordância que o cartão mostra — o piso mora no CORPO da função.
  const observacoesDrenadas = await executarDreno(falhas, "fn_expurgar_observacoes_do_jev", () => drenar(db, "fn_expurgar_observacoes_do_jev", observacoesDoJev.dias), zerado);
  // Décima poda: o rascunho sugerido por integração já VENCIDO (migration 0419,
  // issue #1686). A única que não passa pelo `rpc` — a tabela 0419 não tem
  // função de expurgo, e o corte (`expires_at` + prazo) nasce em TypeScript,
  // mesma exceção da captação. Piso de 7 dias mora AQUI, no interpretador.
  const rascunhosDrenados = await executarDreno(falhas, "conversation_drafts", () => drenarRascunhos(db, rascunho.dias), zerado);
  // Décima primeira poda: o candidato ao golden set (0428, issue #1695).
  // Padrão 90 / piso 30, a janela em que o near-miss ainda é curável — o piso mora no
  // CORPO da função, como nas irmãs. A linha é rótulo, sem texto de cliente.
  const candidatosDrenados = await executarDreno(falhas, "fn_expurgar_candidatos_do_golden", () => drenar(db, "fn_expurgar_candidatos_do_golden", candidatosDoGolden.dias), zerado);
  // Décima segunda poda (migration 0557, issue #1534): a retenção de MÍDIA que a
  // tela prometia e que nada aplicava. O prazo não é knob de ambiente — é
  // `organizations.media_retention_days`, com o piso de 30 dias no `greatest(...)`
  // do corpo da função —, então o que este laço decide é só QUANTO drenar por
  // rodada: lotes de 1000, teto de 20, parando no primeiro incompleto.
  const midiaDrenada = await executarDreno(falhas, "fn_enfileirar_midia_vencida", () => drenarMidia(db), { enfileirada: 0, expurgada: 0, lotes: 0, temResto: false });
  // Da décima terceira à décima sexta: as tabelas append-only da IA (0587). As
  // guardas de cada uma — a última linha do número no ritmo, a janela do
  // anti-repetição nas cópias, o último checkpoint da fronteira e o de job vivo
  // — moram no CORPO das funções, como o piso. `event_log` não entra: é o
  // livro-razão de idempotência dos gatilhos de tempo, e podá-lo reenviaria
  // WhatsApp.
  const telemetriaDrenada = await executarDreno(falhas, "fn_expurgar_telemetria_de_ia_vencida", () => drenar(db, "fn_expurgar_telemetria_de_ia_vencida", telemetriaDeIa.dias), zerado);
  // O traço do turno (migration 9021, issue #3201): a tabela que a 0721 passou a
  // alimentar uma vez por execução do agente e que não aparecia em poda nenhuma.
  // Vai com `telemetriaDeIa.dias` DE PROPÓSITO — um traço é telemetria da IA, e
  // o preço de escolher a janela compartilhada (não dá para guardá-lo por mais
  // tempo que as chamadas de LLM sem separar depois) está escrito no cabeçalho
  // da migration 9021. O piso de 100 continua no CORPO da função: trocar o knob
  // por "1" aqui não apaga investigação de turno com menos de 100 dias.
  const tracosDrenados = await executarDreno(falhas, "fn_expurgar_traco_do_turno_vencido", () => drenar(db, "fn_expurgar_traco_do_turno_vencido", telemetriaDeIa.dias), zerado);
  const ritmoDrenado = await executarDreno(falhas, "fn_expurgar_ritmo_de_envio_vencido", () => drenar(db, "fn_expurgar_ritmo_de_envio_vencido", ritmoDeEnvio.dias), zerado);
  const copiasDrenadas = await executarDreno(falhas, "fn_expurgar_copias_enviadas_vencidas", () => drenar(db, "fn_expurgar_copias_enviadas_vencidas", copiasEnviadas.dias), zerado);
  const checkpointsDrenados = await executarDreno(falhas, "fn_expurgar_checkpoints_superados", () => drenar(db, "fn_expurgar_checkpoints_superados", checkpoints.dias), zerado);

  // A DÉCIMA SÉTIMA etapa não é poda de banco: é a limpeza do Storage que a
  // #5139 pediu. O arquivo da primeira abordagem sobe para `{org}/prospecting/`
  // assim que é escolhido, e trocar de arquivo/desistir/apagar a campanha deixa
  // o anterior no bucket para sempre. `fn_enfileirar_midia_vencida` não o vê
  // porque ela só enxerga linhas de banco — o órfão não tem linha. Mesmo desenho
  // das irmãs: nome próprio, falha vira linha em `falhas`, a rodada SEGUE.
  //
  // Falha POR ORGANIZAÇÃO não aborta as outras: `drenarArquivosOrfaosDaAbordagem`
  // as coleta em `.falhas`, e elas são promovidas aqui para a trilha da rodada
  // (a rodada vira 500 — parcial, mas dita). Se `organizacoes()` em si falhar, a
  // exceção sobe e `executarDreno` nomeia o dreno inteiro.
  const arquivosOrfaos = await executarDreno(
    falhas,
    "prospecting_arquivos_orfaos",
    arquivosOrfaosDaAbordagem ??
      (async (): Promise<ResultadoDoDrenoDaAbordagem> => ({
        organizacoes: 0,
        removidos: 0,
        bytes_removidos: 0,
        caminhos: [],
        falhas: [],
      })),
    { organizacoes: 0, removidos: 0, bytes_removidos: 0, caminhos: [], falhas: [] },
  );
  for (const falhaDaOrganizacao of arquivosOrfaos.falhas) {
    falhas.push(`prospecting_arquivos_orfaos: ${falhaDaOrganizacao}`.slice(0, 300));
  }

  return {
    jobs_apagados: jobs.apagadas,
    auditoria_apagada: linhas.apagadas,
    espelho_apagado: eventos.apagadas,
    nonces_apagados: nonces.apagadas,
    chaves_de_idempotencia_apagadas: chavesDeIdempotencia.apagadas,
    lotes_chaves_de_idempotencia: chavesDeIdempotencia.lotes,
    chaves_de_idempotencia_tem_resto: chavesDeIdempotencia.temResto,
    conversa_do_caso_apagada: conversas.apagadas,
    passagens_apagadas: passagens.apagadas,
    avisos_de_caso_apagados: avisosDeCaso.apagadas,
    avisos_de_agendamento_apagados: avisosDeAgendamento.apagadas,
    prospeccao_apagada: prospeccaoDrenada.apagadas,
    observacoes_do_jev_apagadas: observacoesDrenadas.apagadas,
    candidatos_do_golden_apagados: candidatosDrenados.apagadas,
    lotes_fila: jobs.lotes,
    lotes_auditoria: linhas.lotes,
    lotes_espelho: eventos.lotes,
    lotes_conversa_do_caso: conversas.lotes,
    lotes_passagens: passagens.lotes,
    lotes_avisos_de_caso: avisosDeCaso.lotes,
    lotes_avisos_de_agendamento: avisosDeAgendamento.lotes,
    lotes_prospeccao: prospeccaoDrenada.lotes,
    lotes_observacoes_do_jev: observacoesDrenadas.lotes,
    lotes_candidatos_do_golden: candidatosDrenados.lotes,
    fila_tem_resto: jobs.temResto,
    auditoria_tem_resto: linhas.temResto,
    espelho_tem_resto: eventos.temResto,
    conversa_do_caso_tem_resto: conversas.temResto,
    passagens_tem_resto: passagens.temResto,
    avisos_de_caso_tem_resto: avisosDeCaso.temResto,
    avisos_de_agendamento_tem_resto: avisosDeAgendamento.temResto,
    prospeccao_tem_resto: prospeccaoDrenada.temResto,
    observacoes_do_jev_tem_resto: observacoesDrenadas.temResto,
    rascunhos_apagados: rascunhosDrenados.apagadas,
    lotes_rascunhos: rascunhosDrenados.lotes,
    rascunhos_tem_resto: rascunhosDrenados.temResto,
    candidatos_do_golden_tem_resto: candidatosDrenados.temResto,
    midia_enfileirada: midiaDrenada.enfileirada,
    midia_expurgada: midiaDrenada.expurgada,
    lotes_midia: midiaDrenada.lotes,
    midia_tem_resto: midiaDrenada.temResto,
    telemetria_de_ia_apagada: telemetriaDrenada.apagadas,
    lotes_telemetria_de_ia: telemetriaDrenada.lotes,
    telemetria_de_ia_tem_resto: telemetriaDrenada.temResto,
    retencao_telemetria_de_ia_dias: telemetriaDeIa.dias,
    tracos_apagados: tracosDrenados.apagadas,
    lotes_tracos: tracosDrenados.lotes,
    tracos_tem_resto: tracosDrenados.temResto,
    retencao_traco_dias: telemetriaDeIa.dias,
    ritmo_de_envio_apagado: ritmoDrenado.apagadas,
    lotes_ritmo_de_envio: ritmoDrenado.lotes,
    ritmo_de_envio_tem_resto: ritmoDrenado.temResto,
    retencao_ritmo_de_envio_dias: ritmoDeEnvio.dias,
    copias_enviadas_apagadas: copiasDrenadas.apagadas,
    lotes_copias_enviadas: copiasDrenadas.lotes,
    copias_enviadas_tem_resto: copiasDrenadas.temResto,
    retencao_copias_enviadas_dias: copiasEnviadas.dias,
    checkpoints_apagados: checkpointsDrenados.apagadas,
    lotes_checkpoints: checkpointsDrenados.lotes,
    checkpoints_tem_resto: checkpointsDrenados.temResto,
    retencao_checkpoints_dias: checkpoints.dias,
    // #5139 — os órfãos da abordagem removidos do Storage, com a trilha
    // caminho+bytes. Contagem separada do resto: é a única etapa que apaga
    // OBJETO, não linha de banco.
    arquivos_orfaos_da_abordagem_removidos: arquivosOrfaos.removidos,
    arquivos_orfaos_da_abordagem_bytes: arquivosOrfaos.bytes_removidos,
    arquivos_orfaos_da_abordagem_trilha: arquivosOrfaos.caminhos,
    retencao_fila_dias: fila.dias,
    retencao_auditoria_dias: auditoria.dias,
    retencao_espelho_dias: espelho.dias,
    retencao_conversa_do_caso_dias: conversaDoCaso.dias,
    retencao_passagem_dias: passagem.dias,
    retencao_aviso_de_caso_dias: avisoDeCaso.dias,
    retencao_prospeccao_dias: prospeccao.dias,
    retencao_observacoes_do_jev_dias: observacoesDoJev.dias,
    retencao_rascunho_dias: rascunho.dias,
    retencao_candidatos_do_golden_dias: candidatosDoGolden.dias,
    retencao_midia_dias: RETENCAO_MIDIA_DIAS_PISO,
    avisos: [
      fila.aviso,
      auditoria.aviso,
      espelho.aviso,
      conversaDoCaso.aviso,
      passagem.aviso,
      avisoDeCaso.aviso,
      prospeccao.aviso,
      observacoesDoJev.aviso,
      rascunho.aviso,
      candidatosDoGolden.aviso,
      telemetriaDeIa.aviso,
      ritmoDeEnvio.aviso,
      copiasEnviadas.aviso,
      checkpoints.aviso,
    ].filter((a): a is string => a !== null),
    falhas,
  };
}

/**
 * A rodada mexeu em alguma coisa? É o que decide se ela ocupa uma linha de
 * auditoria. Exportada para o teste medir as DUAS direções — "não audita quando
 * não fez nada" sozinho é satisfeito por um cron que nunca audita.
 */
export function houveEfeito(resultado: ResultadoDaRetencao): boolean {
  return (
    resultado.jobs_apagados > 0 ||
    resultado.auditoria_apagada > 0 ||
    // A terceira conta: sem ela, uma rodada que só podou o espelho apagaria
    // linhas e não deixaria registro — e o CLAUDE.md manda auditar QUANDO HÁ
    // EFEITO, não parar de auditar.
    resultado.espelho_apagado > 0 ||
    // A quarta, pela MESMA razão, e ela quase entrou sem: acrescentei a poda de
    // nonces ao laço e ao retorno e esqueci desta linha. O comentário acima
    // descrevia exatamente o defeito que eu estava criando um parágrafo abaixo.
    resultado.nonces_apagados > 0 ||
    // As chaves de idempotência (#1613), pela mesma razão: uma rodada que só
    // podou chaves vencidas apagaria linhas sem deixar trilha.
    resultado.chaves_de_idempotencia_apagadas > 0 ||
    // A quinta, pela MESMA razão das duas acima: uma rodada que só apagou
    // conversa de caso vencida apagaria linhas e não deixaria registro — e o
    // CLAUDE.md manda auditar QUANDO HÁ EFEITO, nunca parar de auditar.
    resultado.conversa_do_caso_apagada > 0 ||
    // A sexta, pela MESMA razão: uma rodada que só apagou passagem vencida
    // apagaria linhas e não deixaria registro — e o CLAUDE.md manda auditar
    // QUANDO HÁ EFEITO, nunca parar de auditar.
    resultado.passagens_apagadas > 0 ||
    // A sétima, pela mesma razão: uma rodada que só apagou registro de entrega
    // apagaria linhas e não deixaria registro — e o CLAUDE.md
    // manda auditar QUANDO HÁ EFEITO, nunca parar de auditar.
    resultado.avisos_de_caso_apagados > 0 ||
    // A do aviso de agendamento, pela mesma razão.
    resultado.avisos_de_agendamento_apagados > 0 ||
    // A oitava, pela MESMA razão das sete anteriores: uma rodada que só podou
    // candidato de prospecção vencido apagaria linhas e não deixaria registro.
    // Esta é a poda de dado de PESSOA que nunca falou com a empresa (0408) —
    // silenciar aqui seria apagar dado sensível sem trilha.
    resultado.prospeccao_apagada > 0 ||
    // A nona, pela mesma razão: poda que apagou sem deixar trilha é
    // encolhimento silencioso.
    resultado.observacoes_do_jev_apagadas > 0 ||
    // A décima, pela mesma razão das nove anteriores: uma rodada que só apagou
    // rascunho vencido apagaria linhas e não deixaria registro. E esta é a
    // única que apaga TEXTO escrito para uma pessoa — silenciar aqui seria
    // apagar dado pessoal sem trilha.
    resultado.rascunhos_apagados > 0 ||
    // A décima primeira, pela mesma razão das dez: uma rodada que só apagou
    // candidato ao golden set vencido apagaria linha sem deixar registro —
    // encolhimento silencioso.
    resultado.candidatos_do_golden_apagados > 0 ||
    // A décima segunda, pela mesma razão das onze anteriores: a retenção de
    // mídia (#1534) põe arquivo na fila e anula coluna de mensagem — drenar sem
    // trilha seria apagar mídia de cliente em silêncio. `midia_expurgada` entra
    // na mesma conta pelo motivo do #1765: expurgar LINHA DE FILA também é
    // mutação, e uma rodada que só fez isso não pode ser indistinguível de uma
    // que não fez nada.
    resultado.midia_enfileirada > 0 ||
    resultado.midia_expurgada > 0 ||
    // As quatro da 0587, pela mesma razão: o predicado esquecido é mudo.
    resultado.telemetria_de_ia_apagada > 0 ||
    resultado.ritmo_de_envio_apagado > 0 ||
    resultado.copias_enviadas_apagadas > 0 ||
    resultado.checkpoints_apagados > 0 ||
    // A do traço do turno (9021), pela mesma razão das anteriores: uma rodada
    // que só apagou traço de turno apagaria linhas e não deixaria registro.
    // A linha é metadado (nome de ferramenta, ids, erro truncado) — não é texto
    // de cliente —, mas é a trilha do que o agente FEZ: silêncio aqui seria
    // encolhimento de auditoria, não de telemetria.
    resultado.tracos_apagados > 0 ||
    // #5139: uma rodada que só removeu arquivo órfão da abordagem apagou OBJETO
    // do Storage — mutação que precisa de trilha como qualquer DELETE. Sem esta
    // linha, a limpeza existiria e seria indistinguível de "nada a fazer".
    resultado.arquivos_orfaos_da_abordagem_removidos > 0
  );
}

/**
 * A fonte da limpeza de Storage da #5139, montada sobre o admin client.
 *
 * `organizacoes` e `caminhosReferenciados` são as duas leituras de banco; o
 * resto é o Storage. O `list` pagina em lotes de 100 (o default do storage-js),
 * como `apagarDadosOperacionaisDaOrg` faz: sem o laço, uma organização com mais
 * de 100 arquivos de abordagem deixaria órfãos para trás. A paginação usa
 * `offset` porque aqui LISTAMOS tudo antes de remover — a lista não muda debaixo
 * do pé.
 */
const TAMANHO_DO_LOTE_DE_LISTAGEM = 100;
/** Teto de páginas por organização (5 000 arquivos). O cron é diário e repete. */
const MAX_PAGINAS_DE_LISTAGEM = 50;

function fonteDaProspeccaoDoAdmin(
  admin: ReturnType<typeof createAdminClient>,
): FonteDaProspeccao {
  return {
    async organizacoes() {
      // `max_rows` do PostgREST corta a resposta em 1.000 linhas SEM erro: uma
      // instalação com mais organizações perderia as últimas do laço em
      // silêncio. `lerPaginado` prova o fim pelo `count` da primeira página e
      // `truncado` (laço esgotado) vira falha nomeada, não passada incompleta.
      const pagina = await lerPaginado<{ id: string }>((inicio, fim, contar) =>
        admin
          .from("organizations")
          .select("id", { count: contar ? "exact" : undefined })
          .order("id")
          .range(inicio, fim),
      );
      if (pagina.erro) throw new Error(`organizations: ${pagina.erro}`);
      if (pagina.truncado) throw new Error("organizations: leitura truncada");
      return pagina.linhas.map((linha) => linha.id);
    },

    async caminhosReferenciados(organizationId) {
      // AQUI o corte do `max_rows` é perigoso: uma organização com mais de
      // 1.000 campanhas (as arquivadas contam — arquivar não apaga o arquivo)
      // teria as referências das últimas linhas invisíveis, e o arquivo delas
      // seria removido como se fosse órfão. A leitura pagina por `id` e, se o
      // teto de páginas for atingido sem provar o fim, a organização FALHA
      // (nada é removido por ela) em vez de remover com prova incompleta.
      const pagina = await lerPaginado<{ config: unknown }>(
        (inicio, fim, contar) =>
          admin
            .from("prospecting_campaigns")
            .select("config", { count: contar ? "exact" : undefined })
            .eq("organization_id", organizationId)
            .order("id")
            .range(inicio, fim),
        // Teto alto de propósito: 10 páginas = 10.000 campanhas por organização.
        // Passou disso, a organização FALHA (nada é removido por ela) — falhar
        // fechado é o único desfecho aceitável para "referências incompletas".
        10,
      );
      if (pagina.erro) throw new Error(`prospecting_campaigns: ${pagina.erro}`);
      if (pagina.truncado) {
        throw new Error("prospecting_campaigns: leitura truncada — referências incompletas");
      }
      const caminhos: string[] = [];
      for (const linha of pagina.linhas) {
        const config = linha.config as
          | { midia_da_abordagem?: { storage_path?: unknown } }
          | null;
        const caminho = config?.midia_da_abordagem?.storage_path;
        if (typeof caminho === "string" && caminho.length > 0) caminhos.push(caminho);
      }
      return caminhos;
    },

    storageDaAbordagem(_organizationId) {
      const bucket = admin.storage.from(BUCKET_DOS_ARQUIVOS_DA_ABORDAGEM);
      const cliente: ClienteDeStorageDaAbordagem = {
        async list(prefixo) {
          const arquivos: ArquivoDaAbordagemNoBucket[] = [];
          for (let pagina = 0; pagina < MAX_PAGINAS_DE_LISTAGEM; pagina += 1) {
            const { data, error } = await bucket.list(prefixo, {
              limit: TAMANHO_DO_LOTE_DE_LISTAGEM,
              offset: pagina * TAMANHO_DO_LOTE_DE_LISTAGEM,
            });
            if (error) return { arquivos, erro: error.message };
            const lote = data ?? [];
            for (const f of lote) {
              // Pasta vem com `id` nulo; o arquivo da abordagem é plano, então
              // nome com `/` também não é arquivo desta pasta.
              if (f.id === null || f.name.includes("/")) continue;
              arquivos.push({
                caminho: `${prefixo}/${f.name}`,
                bytes: typeof f.metadata?.size === "number" ? f.metadata.size : null,
                criadoEm: f.created_at ? new Date(f.created_at) : null,
                atualizadoEm: f.updated_at ? new Date(f.updated_at) : null,
              });
            }
            if (lote.length < TAMANHO_DO_LOTE_DE_LISTAGEM) break;
          }
          return { arquivos, erro: null };
        },
        async remove(caminhos) {
          const { error } = await bucket.remove([...caminhos]);
          if (error) return { removidos: [], erro: error.message };
          // O `remove` do Storage é uma chamada só; sem erro, os caminhos
          // pedidos (que acabaram de ser listados) saíram.
          return { removidos: [...caminhos], erro: null };
        },
      };
      return cliente;
    },
  };
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let admin: ReturnType<typeof createAdminClient>;
  let resultado: ResultadoDaRetencao;
  try {
    admin = createAdminClient();
    // As duas funções são novas e não estão em `lib/database.types.ts` (gerado a
    // partir de um projeto Supabase vivo) — mesmo tratamento que
    // `recover-stuck-messages` dá a `emit_event`.
    const db: PodaDb = {
      async rpc(nome, args) {
        const { data, error } = await admin.rpc(nome as never, args as never);
        return { data: typeof data === "number" ? data : null, error };
      },
      // A décima poda: DELETE do admin client, sem função de expurgo no banco.
      // Lote curto, transação fechada a cada rodada, e o retorno `select("id")`
      // é a CONTAGEM que o relatório e `houveEfeito` usam. O `.order("id")` NÃO
      // é enfeite: o PostgREST 12.2 recusa `limit` sem `order` num DELETE
      // (400 PGRST109) — e o erro sobe até o `executarDreno` da rodada, que o
      // NOMEIA em `falhas` sem derrubar as podas irmãs nem a retomada da
      // cascata de LGPD (#2508).
      async apagarRascunhos(vencidosAntesDe, lote) {
        const { data, error } = await admin
          .from("conversation_drafts")
          .delete()
          .lt("expires_at", vencidosAntesDe)
          .select("id")
          .order("id")
          .limit(lote);
        return { data: Array.isArray(data) ? data.length : null, error };
      },
      // A décima segunda poda (migration 0557, #1534): a retenção de mídia. O
      // retorno é JSONB (`{vencidas, orfas, expurgadas}`), por isso um método
      // próprio em vez de mais uma entrada na união do `rpc` — ver a JSDoc de
      // `PodaDb.enfileirarMidia`.
      async enfileirarMidia(lote) {
        const { data, error } = await admin.rpc("fn_enfileirar_midia_vencida" as never, {
          p_limite: lote,
        } as never);
        return { data: (data ?? null) as RetornoDaFilaDeMidia | null, error };
      },
    };
    resultado = await podarHistorico(db, {
      JOB_QUEUE_RETENTION_DAYS: env.JOB_QUEUE_RETENTION_DAYS,
      AUDIT_LOG_RETENTION_DAYS: env.AUDIT_LOG_RETENTION_DAYS,
      CASE_CHAT_RETENTION_DAYS: env.CASE_CHAT_RETENTION_DAYS,
      PASSAGEM_RETENTION_DAYS: env.PASSAGEM_RETENTION_DAYS,
      CASE_ALERT_RETENTION_DAYS: env.CASE_ALERT_RETENTION_DAYS,
      PROSPECCAO_RETENTION_DAYS: env.PROSPECCAO_RETENTION_DAYS,
      JEV_OBSERVACOES_RETENTION_DAYS: env.JEV_OBSERVACOES_RETENTION_DAYS,
      DRAFT_RETENTION_DAYS: env.DRAFT_RETENTION_DAYS,
      GOLDEN_CANDIDATES_RETENTION_DAYS: env.GOLDEN_CANDIDATES_RETENTION_DAYS,
      AI_TELEMETRY_RETENTION_DAYS: env.AI_TELEMETRY_RETENTION_DAYS,
      PACING_LEDGER_RETENTION_DAYS: env.PACING_LEDGER_RETENTION_DAYS,
      OUTBOUND_COPIES_RETENTION_DAYS: env.OUTBOUND_COPIES_RETENTION_DAYS,
      LEAD_CHECKPOINT_RETENTION_DAYS: env.LEAD_CHECKPOINT_RETENTION_DAYS,
    }, () => drenarArquivosOrfaosDaAbordagem(fonteDaProspeccaoDoAdmin(admin)));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[data-retention] poda falhou", { error: detail, requestId });
    // A falha ENTRA na trilha. Este catch só alcança falha de CRIAÇÃO do client
    // (as podas isolam seus drenos desde o #2508): rodada que morre aqui não
    // apagou nada por definição, e é o laço de retorno desta peça — sem esta
    // linha, um clone sem env/credencial seria indistinguível de um dia sem
    // nada a fazer. A falha PARCIAL também audita sem efeito (ver abaixo).
    void audit({
      action: "retention.sweep_run",
      organizationId: null,
      bypassedRls: true,
      metadata: { falhou: true, erro: detail.slice(0, 300) },
      requestId,
    });
    return fail("internal_error", "Failed to prune history.", 500, { requestId });
  }

  // ── A poda do OAuth do MCP (migration 9390) ──────────────────────────
  //
  // Cliente registrado e nunca autorizado em 24 h, código vencido, concessão
  // morta e cliente parado: a regra mora em `fn_mcp_oauth_podar`, aqui é só o
  // relógio — e é aqui, e não no `/register`, para a poda não rodar dentro de
  // uma requisição pública. Falha entra em `falhas`, como as podas irmãs, e
  // a contagem vai na MESMA linha `retention.sweep_run` da rodada.
  const podaOAuth = await admin.rpc("fn_mcp_oauth_podar" as never);
  const oauthMcpPodados = !podaOAuth.error && typeof podaOAuth.data === "number" ? podaOAuth.data : 0;
  if (podaOAuth.error) resultado.falhas.push(`fn_mcp_oauth_podar: ${podaOAuth.error.message}`.slice(0, 300));

  // ── A cascata de anonimização que ficou pela metade ──────────────────
  //
  // Mora AQUI, e não numa rota de cron própria, por uma razão de packaging: o
  // agendamento vive no serviço `scheduler`, e um cron novo exigiria linha
  // nova no `docker/scheduler/entrypoint.sh` — que só chega a quem já
  // instalou depois de a imagem do scheduler ser trocada. Pendurado no
  // varredor diário que TODO clone já roda, o conserto alcança o parque
  // instalado sem ninguém editar nada (DoD 15). Nome e cadência também
  // servem: retenção é remover dado pessoal no prazo, e a LGPD dá D+15.
  //
  // O client aqui é o de SERVICE ROLE, que bypassa a RLS — por isso
  // `completarRedacaoDoContato` filtra `organization_id` à mão em toda query,
  // com a org vinda da própria linha de `contacts` (fonte confiável).
  //
  // Try PRÓPRIO, FORA do try da poda (#2508): uma varredura que explodisse
  // derrubaria o relatório da PODA junto, e o cron passaria a auditar
  // `falhou: true` num dia em que o expurgo funcionou; pior, uma poda que
  // falhasse PULAVA este bloco e a anonimização pendente perdia o dia. As duas
  // tarefas dividem o relógio, não o desfecho — quem falha aqui falha aqui, e
  // a falha é dita, não engolida.
  let varredura: ResultadoDaVarredura = {
    examinados: 0,
    comResiduo: 0,
    completados: [],
    temResto: false,
    falhas: [],
  };
  try {
    varredura = await varrerRedacoesIncompletas(admin as unknown as ClienteDaCascata);
  } catch (err) {
    varredura.falhas.push(err instanceof Error ? err.message : String(err));
  }

  for (const aviso of resultado.avisos) {
    logger.warn("[data-retention] configuração de retenção ajustada", { aviso, requestId });
  }

  // Ver o cabeçalho: rodada que não apagou nada não é mutação. E rodada que
  // apagou SEMPRE deixa rastro — é isto que impede o expurgo do audit de ser
  // encolhimento silencioso da trilha.
  //
  // Falha PARCIAL também audita sem efeito (#2508): a rodada em que uma poda
  // quebrou precisa ser distinguível, na trilha, da rodada que não tinha nada
  // a fazer. E o metadata leva as contagens do que JÁ foi apagado — antes, o
  // catch registrava só `{falhou, erro}` e o trabalho que aconteceu sumia.
  const houveFalhaParcial = resultado.falhas.length > 0;
  if (houveEfeito(resultado) || oauthMcpPodados > 0 || houveFalhaParcial) {
    void audit({
      action: "retention.sweep_run",
      organizationId: null,
      bypassedRls: true,
      metadata: { ...(houveFalhaParcial ? { falhou: true } : {}), ...resultado, oauth_mcp_podados: oauthMcpPodados },
      requestId,
    });
  }

  for (const falha of resultado.falhas) {
    logger.error("[data-retention] poda parcial falhou", { falha, requestId });
  }

  for (const falha of varredura.falhas) {
    logger.error("[data-retention] retomada de anonimização falhou", { falha, requestId });
  }

  // Uma linha POR CONTATO, na org dele: é a auditoria que responde ao titular, e
  // uma linha global `retention.sweep_run` não responde a ninguém em particular.
  // Ela aparece em `/app/audit` como qualquer outra (a tela filtra por `action`
  // em campo livre, não por lista fechada) — é o laço de retorno desta peça.
  // Só para quem TINHA resíduo — `completados` já é a lista filtrada, e o `if`
  // deixa isso explícito para o guarda de AST que varre esta pasta (ele não
  // conta `for` como condição, e está certo em não contar).
  for (const feito of varredura.completados) {
    if (feito.resultado.tabelas.length > 0) {
      void audit({
        action: "lgpd.anonymize_catchup",
        organizationId: feito.organizationId,
        bypassedRls: true,
        resourceType: "contact",
        resourceId: feito.contactId,
        requestId,
        metadata: {
          contact_id: feito.contactId,
          origem: "cron.data-retention",
          redacted_tables: feito.resultado.tabelas,
          redacted_lead_ids: feito.resultado.leadsRedigidas,
          redacted_activities: feito.resultado.atividadesRedigidas,
        },
      });
    }
  }

  const corpo = {
    ...resultado,
    oauth_mcp_podados: oauthMcpPodados,
    anonimizacoes_examinadas: varredura.examinados,
    anonimizacoes_completadas: varredura.completados.length,
    anonimizacoes_tem_resto: varredura.temResto,
  };
  // Poda parcial é 500: a rodada NÃO está completa, e o operador precisa poder
  // distinguir isso de um dia em que nada havia a fazer. O detalhe leva o
  // RELATÓRIO inteiro — contagens das podas que funcionaram, as de anonimização
  // e as falhas nomeadas: a resposta 500 não pode perder o que a rodada
  // conseguiu fazer (sugestão 3 do #2645).
  if (houveFalhaParcial) {
    return fail("internal_error", "Failed to prune history.", 500, {
      requestId,
      details: corpo,
    });
  }
  return ok(corpo, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
