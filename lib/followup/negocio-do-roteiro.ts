/**
 * O NEGÓCIO DA EXECUÇÃO DO ROTEIRO (#3363) — o vínculo explícito e estável.
 *
 * Decisão do mantenedor (27/10, PR #3492): "a execução do roteiro deve ficar
 * ligada a um card explícito e preservar esse destino até terminar. Quando
 * houver vários candidatos, será exigida escolha; editar outro card não pode
 * redirecionar uma resposta."
 *
 * O desenho que isto substitui escolhia o card por `updated_at` mais recente em
 * CADA leitura e CADA escrita: quem editasse outro card do mesmo contato no
 * meio do roteiro mudava o destino das respostas seguintes — dado do cliente no
 * card errado, sem aviso e sem teste vermelho.
 *
 * Aqui há três peças, e só três:
 *
 *   1. CANDIDATOS (`lerCandidatosAoNegocio`): os cards ABERTOS do contato, em
 *      ordem determinística (criação, depois id). Nunca `updated_at`: a ordem
 *      não pode depender de quem editou por último.
 *   2. VÍNCULO (`fixarNegocioDoRoteiro` / `lerNegocioFixado`): o `lead_id`
 *      gravado UMA vez na trilha da execução
 *      (`followup_enrollment_events.event_type = 'roteiro_negocio'`), que é o
 *      estado que a execução já tinha para o passo a passo do roteiro — sem
 *      tabela nova e sem migration. A chave de idempotência fixa
 *      (`roteiro_negocio`) + `on conflict do nothing` dão o "primeiro vence":
 *      duas tentativas simultâneas de fixar o MESMO enrollment convergem para o
 *      mesmo card, e nenhuma troca o destino depois.
 *   3. ESCOLHA (`resumoDoNegocio`): com 2+ candidatos e nada fixado, a tela
 *      recebe `escolha_pendente` e a lista — sem default, sem "o mais recente".
 *
 * O vínculo é POR ENROLLMENT, não por contato: duas execuções (inclusive de
 * contatos diferentes, ou uma retomada e uma nova) não se contaminam, e uma
 * execução nova resolve de novo em vez de herdar o card da anterior.
 *
 * O card do vínculo é lido e escrito PELO ID (`crm_leads.id = $n`), com
 * `status = 'open'` na escrita: card fechado no meio da execução não recebe
 * dado novo — e o vínculo permanece, porque trocá-lo seria justamente o
 * redirecionamento que a decisão veda.
 */
import type pg from "pg";

/** O mínimo do `pg.Pool` que este módulo usa — o teste injeta um dublê. */
export type BancoDoNegocio = Pick<pg.Pool, "query">;

/** Um card aberto do contato, como a tela o mostra para escolher. */
export interface CandidatoAoNegocio {
  id: string;
  titulo: string | null;
}

/**
 * O estado do negócio DESTA execução:
 *
 *   - `fixado`: há um card, e é dele que se lê e nele que se grava;
 *   - `ambiguo`: há mais de um candidato e NADA foi fixado — exige escolha;
 *   - `nenhum`: o contato não tem negócio aberto — não há onde gravar.
 */
export type VinculoDoNegocio =
  | { tipo: "fixado"; leadId: string; titulo: string | null }
  | { tipo: "ambiguo"; candidatos: CandidatoAoNegocio[] }
  | { tipo: "nenhum" };

/** O tipo de evento da trilha que guarda o vínculo. */
export const EVENTO_DO_VINCULO = "roteiro_negocio";

/** A chave fixa: um vínculo por execução, e o primeiro é o que vale. */
const CHAVE_DO_VINCULO = "roteiro_negocio";

/**
 * A régua, pura: 0 ⇒ nenhum; 1 ⇒ o único; 2+ ⇒ ambíguo.
 *
 * Não existe ramo "o mais recente" de propósito — é a decisão de produto
 * escrita em código. A função é a única fonte da escolha, e é ela que os testes
 * exercitam sem banco.
 */
export function resolverVinculoDoNegocio(
  candidatos: readonly CandidatoAoNegocio[],
): VinculoDoNegocio {
  if (candidatos.length === 0) return { tipo: "nenhum" };
  const unico = candidatos[0]!;
  if (candidatos.length === 1) return { tipo: "fixado", leadId: unico.id, titulo: unico.titulo };
  return { tipo: "ambiguo", candidatos: [...candidatos] };
}

/**
 * Os cards ABERTOS do contato, em ordem de criação (e id no desempate).
 *
 * Só `status = 'open'`: card ganho/perdido não recebe dado novo, do mesmo jeito
 * que não liga um roteiro por etapa. O título vem junto porque é o que a tela
 * oferece — um seletor de ids não é escolha para ninguém.
 */
export async function lerCandidatosAoNegocio(
  db: BancoDoNegocio,
  args: { organizationId: string; contactId: string },
): Promise<CandidatoAoNegocio[]> {
  const { rows } = await db.query<{ id: string; title: string | null }>(
    `select id, title
       from crm_leads
      where organization_id = $1 and contact_id = $2 and status = 'open'
      order by created_at asc, id asc`,
    [args.organizationId, args.contactId],
  );
  return rows.map((r) => ({ id: r.id, titulo: r.title ?? null }));
}

/**
 * O card que ESTA execução já fixou — `null` quando ainda não há vínculo.
 *
 * Lê o PRIMEIRO evento da trilha (`created_at`, `id`): o vínculo não é
 * reescrito, então o primeiro é o único. Um enrollment que nunca fixou não vê o
 * vínculo de outro: a leitura é sempre por `enrollment_id`.
 */
export async function lerNegocioFixado(
  db: BancoDoNegocio,
  args: { organizationId: string; enrollmentId: string },
): Promise<string | null> {
  const { rows } = await db.query<{ lead_id: string | null }>(
    `select payload->>'lead_id' as lead_id
       from followup_enrollment_events
      where organization_id = $1 and enrollment_id = $2 and event_type = '${EVENTO_DO_VINCULO}'
      order by created_at asc, id asc
      limit 1`,
    [args.organizationId, args.enrollmentId],
  );
  const lead = rows[0]?.lead_id ?? null;
  return lead === null || lead === "" ? null : lead;
}

/**
 * Fixa o negócio desta execução e devolve o card que VALE.
 *
 * `on conflict do nothing` + chave fixa (`roteiro_negocio`): duas chamadas
 * simultâneas para o mesmo enrollment não criam dois vínculos, e a segunda não
 * sobrescreve a primeira — quando o insert não entra, o valor efetivo é lido de
 * volta. É o que impede a execução de trocar de card no meio do caminho (a
 * proposta de "escolher de novo" seria o redirecionamento vedado pela decisão).
 *
 * O payload leva SÓ o id do card: a trilha do roteiro não é dado pessoal e não
 * passa a ser por causa do vínculo.
 */
export async function fixarNegocioDoRoteiro(
  db: BancoDoNegocio,
  args: { organizationId: string; enrollmentId: string; leadId: string },
): Promise<string> {
  const r = await db.query(
    `insert into followup_enrollment_events
        (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
     values ($1, $2, $3, $4, $5::jsonb, $6)
     on conflict do nothing`,
    [
      args.organizationId,
      args.enrollmentId,
      null,
      EVENTO_DO_VINCULO,
      JSON.stringify({ lead_id: args.leadId }),
      CHAVE_DO_VINCULO,
    ],
  );
  if ((r.rowCount ?? 0) > 0) return args.leadId;
  const existente = await lerNegocioFixado(db, args);
  // Sem linha e sem leitura (condição de corrida com o DELETE da cascata do
  // contato) o honesto é devolver o pedido: quem grava descobre em seguida que
  // o card sumiu, como descobriria com o card fechado.
  return existente ?? args.leadId;
}

/** O que a tela recebe de cada roteiro para poder PEDIR a escolha. */
export interface NegocioNaTela {
  /** O card que a execução fixou (com título, para a tela nomear o destino). */
  vinculo: CandidatoAoNegocio | null;
  /** Todos os cards abertos do contato, em ordem determinística. */
  candidatos: CandidatoAoNegocio[];
  /**
   * true = 2+ candidatos e nada fixado: a tela PEDE a escolha. Com um só card
   * ele já está fixado e não se pergunta; sem card não há escolha a fazer.
   */
  escolha_pendente: boolean;
}

/** Puro: o resumo do negócio de UM roteiro, para a ficha e o painel. */
export function resumoDoNegocio(
  candidatos: readonly CandidatoAoNegocio[],
  vinculoId: string | null,
): NegocioNaTela {
  const vinculo =
    vinculoId === null
      ? null
      : (candidatos.find((c) => c.id === vinculoId) ?? { id: vinculoId, titulo: null });
  return {
    vinculo,
    candidatos: [...candidatos],
    escolha_pendente: vinculo === null && candidatos.length > 1,
  };
}
