/**
 * O RETORNO AGENDADO SEGURA O FLUXO DE SILÊNCIO.
 *
 * ─── O defeito ─────────────────────────────────────────────────────────────
 *
 * Medido numa instalação real (25/09/2026): a cliente disse "só recebo o
 * salário no dia 30", o agente agendou o retorno para o dia 30 com
 * `schedule_followup` e respondeu "te escrevo no dia 30, sem pressa". Uma hora
 * depois, o fluxo de silêncio — que não sabia de retorno nenhum — voltou a
 * escrever pedindo os dados de entrega; no dia seguinte repetiria a oferta que
 * ela já tinha aceitado, e dois dias depois a "última oportunidade". O sistema
 * desmentia, sozinho, a promessa que ele mesmo tinha feito.
 *
 * ─── A regra ───────────────────────────────────────────────────────────────
 *
 * Com um retorno VIVO para o contato, o fluxo de silêncio não fala por cima:
 *   - a varredura não inscreve o contato (`contatosComRetornoVivo`);
 *   - a inscrição que já estava andando fica segurada até a folga do fluxo
 *     (`folgaDepoisDoRetorno`) depois do retorno (`quandoDoRetornoVivo` +
 *     `reavaliarDepoisDoRetorno`).
 *     Se o cliente responder ao retorno, o `cancel_on_reply` do fluxo o encerra
 *     como sempre; se não responder, o fluxo retoma de onde estava.
 *
 * ─── O retorno que JÁ SAIU também segura (issue #2907) ─────────────────────
 *
 * A folga acima valia só enquanto o retorno estava VIVO. Quando o one-shot
 * DISPARA, a linha de `cron_jobs` sai de "agendado" (`enabled=false` —
 * `situacaoDoRetorno`, em `retorno.ts`) e a varredura no minuto seguinte voltava
 * a ver o contato como simplesmente silencioso. Medido em produção, com gatilho
 * de 40 min: 18:05 o lead pede retorno em 50 min; 18:55 agendado; 18:45 não
 * inscreve (certo); 18:56:04 sai a mensagem do retorno; 18:56:00 nasce a
 * inscrição; 18:58:05 sai o "Follow-up 1" — duas mensagens seguidas, sem o lead
 * responder. O que o retorno tinha a dizer já foi dito.
 *
 * O que muda é só a inscrição NOVA: `contatosQueORetornoSegura` une o retorno
 * vivo ao RECÉM-EXECUTADO — a mesma linha de `cron_jobs`, uma janela depois —
 * para o corte de silêncio valer também para quem ainda não estava inscrito.
 * A folga é a mesma (`folgaDepoisDoRetorno`), ancorada no mesmo instante
 * (`next_run_at`, que o disparo não move).
 *
 * Só o gatilho de SILÊNCIO: é ele que insiste com quem parou de falar, e é ele
 * que contradiz "te escrevo no dia 30". Fluxo por etapa ou por caso responde a um
 * FATO novo (o pedido foi confirmado, o caso foi aberto) e não deve esperar.
 *
 * ─── O que conta como retorno ──────────────────────────────────────────────
 *
 * Uma linha de `cron_jobs` `kind='at'`, `job_kind='followup_turn'`, agendada
 * (`enabled`, sem `cancelled_at` — ver `situacaoDoRetorno` em `retorno.ts`) e que
 * NÃO é o turno de um passo de fluxo. O motor de fluxo enfileira os próprios
 * passos na mesma tabela e no mesmo `job_kind`, com `followup_enrollment_id` no
 * payload; contá-los faria cada fluxo segurar a si mesmo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Menor espera depois de um retorno, qualquer que seja o gatilho do fluxo. É a
 * proteção da issue #2907: com gatilho de 40 min, o retorno saiu às 18:56 e o
 * "Follow-up 1" às 18:58 — duas mensagens seguidas sem o lead responder.
 */
export const PISO_DA_FOLGA_DEPOIS_DO_RETORNO_MS = 4 * 3_600_000;

/**
 * Quanto o fluxo de silêncio espera DEPOIS do retorno antes de falar: o retorno
 * conta como a última conversa e o relógio do silêncio recomeça dali — o próprio
 * gatilho do fluxo (`threshold_minutes`), nunca menos que o piso. O fluxo de 3
 * dias espera 3 dias; o de 1 h e o de 40 min esperam 4 h. Antes era 1 dia para
 * todos: o fluxo de 1 h ficava um dia parado depois do retorno (PR #3692).
 */
export function folgaDepoisDoRetorno(gatilhoMinutos: number): number {
  return Math.max(gatilhoMinutos * 60_000, PISO_DA_FOLGA_DEPOIS_DO_RETORNO_MS);
}

export function reavaliarDepoisDoRetorno(quandoDoRetorno: string, gatilhoMinutos: number): string {
  return new Date(Date.parse(quandoDoRetorno) + folgaDepoisDoRetorno(gatilhoMinutos)).toISOString();
}

function retornosVivos(admin: SupabaseClient, orgId: string) {
  return admin
    .from("cron_jobs")
    .select("contact_id, next_run_at")
    .eq("organization_id", orgId)
    .eq("kind", "at")
    .eq("job_kind", "followup_turn")
    .eq("enabled", true)
    .is("cancelled_at", null)
    .is("payload->>followup_enrollment_id", null);
}

/** Contatos da organização com retorno vivo — a varredura de silêncio os pula. */
export async function contatosComRetornoVivo(admin: SupabaseClient, orgId: string): Promise<Set<string>> {
  const { data, error } = await retornosVivos(admin, orgId);
  if (error) throw new Error(`retorno_vivo_query_failed: ${error.message}`);
  const ids = new Set<string>();
  for (const row of (data ?? []) as Array<{ contact_id: string | null }>) {
    if (row.contact_id) ids.add(row.contact_id);
  }
  return ids;
}

/**
 * Retornos one-shot JÁ EXECUTADOS dentro da folga — a mesma linha de `cron_jobs`,
 * uma janela depois. "Disparado" é `enabled=false` SEM `cancelled_at` (cancelar
 * marca — `cancelaRetorno`) e SEM `last_error`: o disparo bem-sucedido grava
 * `enabled=false, last_error=null`; a empresa parada grava
 * `last_error='org_nao_operante'` e a falha definitiva de disparo grava a razão
 * — nesses dois o retorno NÃO saiu (é o que o disparo grava em
 * `lib/agent-engine/cron/scheduler.ts`). `situacaoDoRetorno` (`retorno.ts`) é mais
 * largo: conta a falha definitiva como "disparado"; aqui ela não segura.
 * Também não entram os turnos de passo de fluxo (mesma tabela, mesmo `job_kind`,
 * com `followup_enrollment_id` no payload).
 *
 * `next_run_at` é a âncora do "quando o retorno saiu": o disparo one-shot só
 * desabilita a linha, não move a data — é o MESMO instante que
 * `reavaliarDepoisDoRetorno` usa para soltar a inscrição que já estava andando.
 * A consulta exige a data no PASSADO (`<= agora`): desabilitar antes da hora é o
 * que o cancelamento de emergência faz (opt-out irrevogável e handoff humano
 * desabilitam os pendentes do lead sem marcar `cancelled_at`), e isso não é um
 * retorno que falou.
 */
function retornosJaDisparados(admin: SupabaseClient, orgId: string, folgaMs: number, agora: Date) {
  return admin
    .from("cron_jobs")
    .select("contact_id, next_run_at")
    .eq("organization_id", orgId)
    .eq("kind", "at")
    .eq("job_kind", "followup_turn")
    .eq("enabled", false)
    .is("cancelled_at", null)
    .is("last_error", null)
    .is("payload->>followup_enrollment_id", null)
    .lte("next_run_at", agora.toISOString())
    .gt("next_run_at", new Date(agora.getTime() - folgaMs).toISOString());
}

/**
 * Contatos que o retorno AINDA segura: o vivo e o recém-executado. É este o
 * corte que a varredura de silêncio respeita — sem o segundo, a inscrição nova
 * nascia no minuto seguinte ao disparo e o fluxo falava por cima do retorno que
 * acabara de sair (issue #2907).
 *
 * `folgaMs` é a do fluxo que pergunta (`folgaDepoisDoRetorno`): a varredura
 * chama por pointer, e cada fluxo tem o seu gatilho. `agora` é injetável só para
 * o teste provar a janela; a regra é a mesma dos dois lados.
 */
export async function contatosQueORetornoSegura(
  admin: SupabaseClient,
  orgId: string,
  folgaMs: number,
  agora: Date = new Date(),
): Promise<Set<string>> {
  const segura = await contatosComRetornoVivo(admin, orgId);
  const { data, error } = await retornosJaDisparados(admin, orgId, folgaMs, agora);
  if (error) throw new Error(`retorno_disparado_query_failed: ${error.message}`);
  const fim = agora.getTime();
  const corte = fim - folgaMs;
  for (const row of (data ?? []) as Array<{ contact_id: string | null; next_run_at: string }>) {
    if (!row.contact_id) continue;
    const quando = Date.parse(row.next_run_at);
    if (Number.isNaN(quando)) continue;
    // A mesma janela da consulta, refeita aqui: o PostgREST já corta, e uma data
    // torta que escapasse dele não pode segurar o fluxo deste contato para sempre.
    if (quando > fim || quando <= corte) continue;
    segura.add(row.contact_id);
  }
  return segura;
}

/**
 * Quando dispara o retorno vivo MAIS TARDIO do contato, ou `null` sem retorno.
 * O mais tardio porque é depois dele que o fluxo pode voltar a falar.
 */
export async function quandoDoRetornoVivo(
  admin: SupabaseClient,
  orgId: string,
  contactId: string,
): Promise<string | null> {
  const { data, error } = await retornosVivos(admin, orgId)
    .eq("contact_id", contactId)
    .order("next_run_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`retorno_vivo_query_failed: ${error.message}`);
  const row = (data ?? [])[0] as { next_run_at: string } | undefined;
  return row?.next_run_at ?? null;
}
