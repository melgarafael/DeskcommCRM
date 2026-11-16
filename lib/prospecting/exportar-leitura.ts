/**
 * A LEITURA da lista da campanha: as linhas e os contatos do CRM delas, numa
 * função que a rota (`app/api/v1/prospecting/[id]/exportar/route.ts`) e o
 * invariante de banco (`tests/invariants/prospeccao-baixar-lista-completa.test.ts`)
 * chamam do mesmo jeito.
 *
 * Por que separada da rota: a régua D13 (dados apagados, quem pediu para parar
 * e contato pessoal nunca saem) e a coluna `situacao` dependem de expressões SQL
 * (`suppression_salt is not null`, o `join` com a conversa, a união com os
 * telefones extras). O teste da rota usa um banco de mentira que devolve as
 * linhas prontas, venha a consulta que vier; só um Postgres de verdade, sobre o
 * `baseline.sql`, prova essas expressões. A régua pura continua em
 * `exportar.ts`, que a tela também importa (só os tipos).
 *
 * MULTI-TENANCY: a rota usa `getRequestPool()`, que passa por cima da RLS. O
 * filtro `organization_id` em CADA ponta (a campanha, os candidatos, a conversa,
 * as duas metades da união com os contatos) é a única cerca entre empresas.
 */
import type pg from "pg";

import {
  ligarContatos,
  telefonesDaEmpresa,
  type CandidatoDaLista,
  type ContatoDaLista,
} from "@/lib/prospecting/exportar";

/** Mesmo teto da tela (o GET de candidatos lê 5.000 linhas): o arquivo não é maior que a lista. */
export const TETO_DA_LEITURA = 5_000;

type Banco = Pick<pg.PoolClient, "query">;

/**
 * Linhas da campanha. `suppression_*` são tokens só do servidor (migration
 * 0370): sai daqui só o booleano "esta linha foi apagada", nunca o token.
 * `respondeu` é a mesma régua do "Responderam" da tela (`prospecting/route.ts`).
 */
export const SQL_LINHAS_DA_LISTA = `select p.status,p.attempted_at,p.phone,p.data,p.contact_id,
              (p.suppression_salt is not null) as suprimida,
              (v.last_inbound_at is not null) as respondeu
         from prospecting_candidates p
         left join conversations v on v.organization_id=p.organization_id and v.id=p.conversation_id
        where p.organization_id=$1 and p.campaign_id=$2
        order by p.created_at,p.id limit $3`;

/**
 * Os contatos do CRM destas empresas numa consulta só: pelo vínculo da linha,
 * pelo telefone da ficha e pelo telefone extra. As DUAS metades filtram a
 * organização, e o `join` do extra também.
 */
export const SQL_CONTATOS_DA_LISTA = `select c.id,c.phone_number as telefone,c.is_blocked,c.is_personal,c.is_anonymized,c.consent
               from contacts c
              where c.organization_id=$1 and (c.id=any($2::uuid[]) or c.phone_number=any($3::text[]))
             union all
             select c.id,cp.phone_number as telefone,c.is_blocked,c.is_personal,c.is_anonymized,c.consent
               from contact_phones cp
               join contacts c on c.organization_id=cp.organization_id and c.id=cp.contact_id
              where cp.organization_id=$1 and c.organization_id=$1 and cp.phone_number=any($3::text[])`;

/** A lista da campanha `campanhaId` da organização `org`, já com os contatos ligados. */
export async function lerListaDaCampanha(
  db: Banco,
  org: string,
  campanhaId: string,
  teto: number = TETO_DA_LEITURA,
): Promise<CandidatoDaLista[]> {
  const linhas = (await db.query<CandidatoDaLista>(SQL_LINHAS_DA_LISTA, [org, campanhaId, teto])).rows;
  const ids = [...new Set(linhas.map((c) => c.contact_id).filter((x): x is string => !!x))];
  const telefones = [...new Set(linhas.flatMap(telefonesDaEmpresa))];
  const contatos =
    ids.length === 0 && telefones.length === 0
      ? []
      : (await db.query<ContatoDaLista>(SQL_CONTATOS_DA_LISTA, [org, ids, telefones])).rows;
  return ligarContatos(linhas, contatos);
}
