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
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  RETENCAO_AUDITORIA_DIAS_PADRAO,
  RETENCAO_AUDITORIA_DIAS_PISO,
  RETENCAO_ESPELHO_AGENDA_DIAS_PADRAO,
  RETENCAO_ESPELHO_AGENDA_DIAS_PISO,
  RETENCAO_FILA_DIAS_PADRAO,
  RETENCAO_FILA_DIAS_PISO,
  interpretarRetencao,
} from "@/lib/retencao/politica";
import {
  varrerRedacoesIncompletas,
  type ClienteDaCascata,
  type ResultadoDaVarredura,
} from "@/lib/lgpd/cascata";
import { createAdminClient } from "@/lib/supabase/admin";

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
  /** O espelho da agenda conectada — cache com prazo (migration 0187). */
  espelho_apagado: number;
  lotes_espelho: number;
  espelho_tem_resto: boolean;
  retencao_fila_dias: number;
  retencao_auditoria_dias: number;
  retencao_espelho_dias: number;
  /** Avisos de configuração — nunca ausentes em silêncio quando existem. */
  avisos: string[];
}

/** Só a superfície que este cron usa — o teste injeta uma implementação. */
export interface PodaDb {
  rpc(
    nome: "fn_podar_fila_de_jobs" | "fn_expurgar_auditoria_vencida" | "fn_expurgar_espelho_da_agenda" | "fn_expurgar_nonces_de_oauth",
    args: { p_retencao_dias: number; p_limite: number },
  ): Promise<{ data: number | null; error: { message: string } | null }>;
}

async function drenar(
  db: PodaDb,
  nome: "fn_podar_fila_de_jobs" | "fn_expurgar_auditoria_vencida" | "fn_expurgar_espelho_da_agenda" | "fn_expurgar_nonces_de_oauth",
  dias: number,
): Promise<{ apagadas: number; lotes: number; temResto: boolean }> {
  let apagadas = 0;
  let lotes = 0;
  for (let i = 0; i < MAX_LOTES; i += 1) {
    const { data, error } = await db.rpc(nome, {
      p_retencao_dias: dias,
      p_limite: TAMANHO_DO_LOTE,
    });
    if (error) throw new Error(`${nome}: ${error.message}`);
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
  },
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

  const jobs = await drenar(db, "fn_podar_fila_de_jobs", fila.dias);
  const linhas = await drenar(db, "fn_expurgar_auditoria_vencida", auditoria.dias);
  const eventos = await drenar(db, "fn_expurgar_espelho_da_agenda", espelho.dias);
  // Quarta poda: os nonces de OAuth já queimados. O `state` vale dez minutos,
  // então um dia é folga de duas ordens de grandeza — e sem esta linha a tabela
  // cresceria para sempre, uma linha por conexão tentada, num produto que se
  // instala e ninguém monitora.
  const nonces = await drenar(db, "fn_expurgar_nonces_de_oauth", 1);

  return {
    jobs_apagados: jobs.apagadas,
    auditoria_apagada: linhas.apagadas,
    espelho_apagado: eventos.apagadas,
    nonces_apagados: nonces.apagadas,
    lotes_fila: jobs.lotes,
    lotes_auditoria: linhas.lotes,
    lotes_espelho: eventos.lotes,
    fila_tem_resto: jobs.temResto,
    auditoria_tem_resto: linhas.temResto,
    espelho_tem_resto: eventos.temResto,
    retencao_fila_dias: fila.dias,
    retencao_auditoria_dias: auditoria.dias,
    retencao_espelho_dias: espelho.dias,
    avisos: [fila.aviso, auditoria.aviso, espelho.aviso].filter(
      (a): a is string => a !== null,
    ),
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
    resultado.nonces_apagados > 0
  );
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let resultado: ResultadoDaRetencao;
  let varredura: ResultadoDaVarredura = {
    examinados: 0,
    comResiduo: 0,
    completados: [],
    temResto: false,
    falhas: [],
  };
  try {
    const admin = createAdminClient();
    // As duas funções são novas e não estão em `lib/database.types.ts` (gerado a
    // partir de um projeto Supabase vivo) — mesmo tratamento que
    // `recover-stuck-messages` dá a `emit_event`.
    const db: PodaDb = {
      async rpc(nome, args) {
        const { data, error } = await admin.rpc(nome as never, args as never);
        return { data: typeof data === "number" ? data : null, error };
      },
    };
    resultado = await podarHistorico(db, {
      JOB_QUEUE_RETENTION_DAYS: env.JOB_QUEUE_RETENTION_DAYS,
      AUDIT_LOG_RETENTION_DAYS: env.AUDIT_LOG_RETENTION_DAYS,
    });
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
    // Try PRÓPRIO, e não o de fora: uma varredura que explodisse derrubaria o
    // relatório da PODA junto, e o cron passaria a auditar `falhou: true` num
    // dia em que o expurgo funcionou. As duas tarefas dividem o relógio, não o
    // desfecho — quem falha aqui falha aqui, e a falha é dita, não engolida.
    try {
      varredura = await varrerRedacoesIncompletas(admin as unknown as ClienteDaCascata);
    } catch (err) {
      varredura.falhas.push(err instanceof Error ? err.message : String(err));
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[data-retention] poda falhou", { error: detail, requestId });
    // A falha ENTRA na trilha, e é o único caso em que uma rodada que não apagou
    // nada audita. É o laço de retorno desta peça: sem esta linha, uma poda que
    // parou de funcionar — grants que não vieram no `update.sh` de um clone,
    // função ausente — seria indistinguível de uma poda que não tinha nada a
    // fazer, e o único sinal viveria num `logger.error` dentro do contêiner,
    // atrás de um `curl` que manda tudo para /dev/null. Teto de 1 linha/dia.
    void audit({
      action: "retention.sweep_run",
      organizationId: null,
      bypassedRls: true,
      metadata: { falhou: true, erro: detail.slice(0, 300) },
      requestId,
    });
    return fail("internal_error", "Failed to prune history.", 500, { requestId });
  }

  for (const aviso of resultado.avisos) {
    logger.warn("[data-retention] configuração de retenção ajustada", { aviso, requestId });
  }

  // Ver o cabeçalho: rodada que não apagou nada não é mutação. E rodada que
  // apagou SEMPRE deixa rastro — é isto que impede o expurgo do audit de ser
  // encolhimento silencioso da trilha.
  if (houveEfeito(resultado)) {
    void audit({
      action: "retention.sweep_run",
      organizationId: null,
      bypassedRls: true,
      metadata: resultado as unknown as Record<string, unknown>,
      requestId,
    });
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

  return ok(
    {
      ...resultado,
      anonimizacoes_examinadas: varredura.examinados,
      anonimizacoes_completadas: varredura.completados.length,
      anonimizacoes_tem_resto: varredura.temResto,
    },
    { requestId },
  );
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
