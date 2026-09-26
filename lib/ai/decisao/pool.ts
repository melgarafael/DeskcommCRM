/**
 * O QUE AS TAREFAS DO JEV FAZEM PELO `pg.Pool` — a pilha do agente, e não a do
 * Next (`./ponto.ts` lê a chave pelo cliente admin do Supabase).
 *
 * Duas coisas, iguais para toda tarefa que o turno pergunta (a manipulação, o
 * roteador): ler o estado da tarefa na organização, e gravar a linha de erro da
 * falha que pede ação. Nenhuma das duas lança: o turno é o atendimento do
 * cliente.
 */
import type pg from "pg";

import { logger } from "@/lib/logger";

import { MODELO_DO_JEV, type FalhaDaDecisao } from "./cliente";
import { lerConfigDoJev, type EstadoDaTarefa } from "./config";
import { estadoEfetivoDaTarefa, type TarefaDoJev } from "./tarefas";
import { codigoDoErroDoJev } from "./textos";

/**
 * O estado da tarefa nesta organização. Leitura que falha vale desligada: sem
 * saber se a empresa consentiu, nada sai para a rede.
 */
export async function estadoDaTarefaNoPool(
  pool: pg.Pool,
  organizationId: string,
  tarefa: TarefaDoJev,
): Promise<EstadoDaTarefa> {
  try {
    const { rows } = await pool.query<{ settings: unknown }>(
      "select settings from public.organizations where id = $1",
      [organizationId],
    );
    return estadoEfetivoDaTarefa(lerConfigDoJev(rows[0]?.settings), tarefa);
  } catch (erro) {
    logger.warn("estado do Jev não pôde ser lido; a tarefa segue só com a IA de sempre", {
      organization_id: organizationId,
      tarefa: tarefa.id,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
    return "desligada";
  }
}

/**
 * A linha de erro da falha que pede ação (chave recusada, sem crédito, pergunta
 * recusada) — a mesma forma da do clima (`workers/ai-sentiment-worker.ts`), com
 * uma diferença: a origem é `jev_observacao`, e não `jev`. No clima, a linha de
 * erro com `jev` só existe quando ninguém mediu, e Execuções mostra a
 * consequência; nas tarefas do turno nada depende só do Jev (a IA de sempre
 * decide, ou, sem ela, a regra de antes), e a tela diz isso
 * (`JEV_FALHOU_AO_LADO`) — com palavras que valem também para a tela "Testar
 * classificação" do roteador, que grava a mesma linha sem atender ninguém: a
 * chave recusada num teste é a mesma recusada no atendimento. É dela que o
 * cartão tira a "Última falha" da tarefa. Devolve o id da linha — o roteador
 * decidindo a remarca quando a IA de sempre cobriu (`./roteador.ts`) — ou
 * `null`. Nunca lança: é telemetria.
 */
export async function registrarFalhaQuePedeAcao(
  pool: pg.Pool,
  entrada: { organizationId: string; purpose: string; contactId?: string | null; jobId?: string | null },
  falha: FalhaDaDecisao,
): Promise<string | null> {
  if (falha.motivo === "sem_credencial" || falha.motivo === "disjuntor_aberto") return null;
  try {
    const { rows } = await pool.query<{ id: string }>(
      `insert into public.llm_calls
         (organization_id, contact_id, job_id, purpose, provider, model,
          input_tokens, output_tokens, cost_cents, latency_ms, status, error_code, http_status, origem_da_escolha)
       values ($1, $2, $3, $4, 'typesafe', $5, 0, 0, 0, $6, 'erro', $7, $8, 'jev_observacao')
       returning id`,
      [
        entrada.organizationId,
        entrada.contactId ?? null,
        entrada.jobId ?? null,
        entrada.purpose,
        `typesafe/${MODELO_DO_JEV}`,
        falha.latenciaMs ?? null,
        codigoDoErroDoJev(falha.motivo),
        falha.status,
      ],
    );
    return rows[0]?.id ?? null;
  } catch (erro) {
    logger.warn("falha do Jev não foi gravada", {
      organization_id: entrada.organizationId,
      purpose: entrada.purpose,
      erro: erro instanceof Error ? erro.message.slice(0, 200) : typeof erro,
    });
    return null;
  }
}
