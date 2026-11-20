/**
 * A PORTA 3 DO ROTEAMENTO (#3916): a jornada de um atendente COMEÇA ⇒ o canal
 * daquela organização acorda a distribuição.
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * A jornada é DERIVADA na leitura (`lib/routing/eligibility.ts`): `estaDePlantao`
 * e `isWithinSchedule` calculam "está aberto agora?" a cada consulta, e NADA é
 * escrito no banco quando a janela vira. Do lado da escrita, os quatro
 * chamadores de `fn_wake_channel_routing` na `main` são todos de escrita
 * (salvar a política do número, revogar membro) e nenhum olha para o relógio; o
 * cron que poderia olhar (`attendant-heartbeat`) foi removido.
 *
 * Resultado: a conversa reenfileirada por `requeued_no_eligible` só é tentada
 * de novo no backoff (`decide.ts`: `backoff_seconds` nas primeiras tentativas,
 * depois `max(900, backoff_seconds)`). Quando a fila ABRE, não há evento novo —
 * ele é justamente a abertura. O atendente entra de plantão, a fila está com
 * gente disponível, e a conversa espera até 15 minutos (ou 1 hora) pela
 * próxima tentativa.
 *
 * ─── O desenho ──────────────────────────────────────────────────────────────
 *
 * 1. uma leitura de `attendant_availability` e uma de `attendant_sectors` por
 *    tick, pelo pool `pg` (`getRequestPool`), fora da cota do PostgREST — o
 *    mesmo caminho do portão do piso ocioso (#3878), que é quem paga a conta de
 *    egress nesta rota;
 * 2. a decisão é a regra PURA `abriuOHorario` (mesma conta nos dois instantes,
 *    idempotente sem coluna de estado e sem migration);
 * 3. o acorde é POR ORGANIZAÇÃO (`fn_wake_channel_routing(p_org)`), nunca por
 *    canal: a função já varre as conversas sem dono da organização e é
 *    idempotente (uma conversa com dono não é tocada).
 *
 * ─── Custo declarado (corpo do PR) ──────────────────────────────────────────
 *
 * 2 SELECT por tick — cerca de 2.880 por dia, uma vez por minuto, fora da cota
 * do PostgREST — mais 1 ida por organização que abriu (K), ou seja 1+K por
 * abertura. ZERO migration e ZERO escrita nas tabelas de jornada: o acorde é
 * chamada de TS, não trigger novo.
 *
 * ─── A FILA TAMBÉM TEM JORNADA ──────────────────────────────────────────────
 *
 * `attendant_sectors.schedule` (migration 9062) é o horário de funcionamento da
 * FILA, e `loadEligibleAttendants` devolve vazio enquanto ela está fechada
 * (`lib/routing/eligibles.ts`). Sem a segunda leitura, abrir uma fila sem
 * ninguém de plantão individual não acordaria ninguém — e é esse o desenho que
 * o produto oferece (fila com horário, gente que entra de plantão depois).
 *
 * ─── A REGRA DE FALHA: o acorde NUNCA derruba o tick ────────────────────────
 *
 * Banco fora, tabela ausente numa instalação antiga, RLS que recusa: o passo
 * loga e devolve lista vazia. A rodada logo abaixo é o trabalho; o acorde é a
 * promoção dele. Falhar aqui dentro teria transformado um aviso em queda de
 * distribuição — o oposto do que esta porta existe para fazer.
 */
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { logger } from "@/lib/logger";
import { availabilityScheduleSchema } from "@/lib/schemas/routing";

import { abriuOHorario } from "./eligibility";

/**
 * O que o passo precisa do pool — só `query`, como o `BancoDoPortao` do piso
 * ocioso (`lib/cron/piso-ocioso.ts`). É o ponto de injeção do teste.
 */
export type BancoDoAcorde = {
  query: (texto: string, valores?: unknown[]) => Promise<{ rows?: unknown[] }>;
};

/**
 * A janela da abertura = a cadência do crontab
 * (`* * * * *` em `docker/scheduler/entrypoint.sh`). Um tick por abertura,
 * e o tick seguinte já vê a janela aberta dos dois lados.
 */
export const JANELA_DA_ABERTURA_MS = 60_000;

/**
 * As jornadas que podem ABRIR neste tick.
 *
 * O corte de `windows` vazio é feito no SQL, não em TS: sem janela publicada a
 * jornada é 24/7 e nunca "abre" (ver `abriuOHorario`), então trazer essas linhas
 * para descartá-las em memória seria ler o mesmo que não ler. É o lado barato,
 * e é o mesmo critério da regra pura.
 */
const SQL_DA_DISPONIBILIDADE = `
select organization_id, schedule
  from public.attendant_availability
 where is_available
   and jsonb_typeof(schedule -> 'windows') = 'array'
   and jsonb_array_length(schedule -> 'windows') > 0
`;

const SQL_DAS_FILAS = `
select organization_id, schedule
  from public.attendant_sectors
 where jsonb_typeof(schedule -> 'windows') = 'array'
   and jsonb_array_length(schedule -> 'windows') > 0
`;

type LinhaDaJornada = { organization_id: string; schedule: unknown };

/**
 * Acorda a distribuição de cada organização cuja jornada (de atendente ou de
 * fila) começou NESTE tick. Devolve as organizações acordadas — a rota usa a
 * lista para o log; nada nelas é estado.
 *
 * `agora` e `db` são os pontos de injeção do teste; a rota não passa nenhum.
 */
export async function acordarCanaisQueAbriram(
  agora: Date = new Date(),
  db?: BancoDoAcorde,
): Promise<string[]> {
  let linhas: LinhaDaJornada[];
  let banco: BancoDoAcorde;
  try {
    banco = db ?? getRequestPool();
    const disponibilidade = await banco.query(SQL_DA_DISPONIBILIDADE);
    const filas = await banco.query(SQL_DAS_FILAS);
    linhas = [...(disponibilidade.rows ?? []), ...(filas.rows ?? [])] as LinhaDaJornada[];
  } catch (erro) {
    // Fail-open para o TICK (a rodada segue), fail-safe para o acorde (ninguém
    // é acordado sem evidência).
    logger.warn("[routing-worker] leitura das jornadas falhou — nenhum canal acordado neste tick", {
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return [];
  }

  const organizacoes = new Set<string>();
  for (const linha of linhas) {
    // O schedule vem de jsonb: um valor fora do shape (instalação antiga, escrita
    // manual no banco) não pode derrubar o acorde das outras organizações.
    const agenda = availabilityScheduleSchema.safeParse(linha.schedule ?? {});
    if (!agenda.success) continue;
    if (abriuOHorario(agenda.data, agora, JANELA_DA_ABERTURA_MS)) {
      organizacoes.add(String(linha.organization_id));
    }
  }

  const acordadas: string[] = [];
  for (const organizacao of organizacoes) {
    try {
      await banco.query("select public.fn_wake_channel_routing($1)", [organizacao]);
      acordadas.push(organizacao);
    } catch (erro) {
      // Uma organização que falha não impede as outras: o laço continua.
      logger.warn("[routing-worker] acorde da jornada falhou", {
        organization_id: organizacao,
        detalhe: erro instanceof Error ? erro.message : String(erro),
      });
    }
  }
  return acordadas;
}
