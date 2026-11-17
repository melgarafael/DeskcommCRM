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
export const SQL_LINHAS_DA_LISTA = `select p.status,p.attempted_at,p.place_id,p.phone,p.data,p.contact_id,
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

/**
 * A TRILHA da abordagem: a última passagem de `prospecting.approach_sent` por
 * contato, com o NOME da campanha em que ela saiu (`api_audit_log` + a própria
 * campanha). É o único lugar que guarda a abordagem depois que a linha da
 * campanha mudou de estado, e é o que faz a coluna `campanha_anterior` dizer
 * algo verdadeiro quando a empresa já foi tentada por outra campanha.
 *
 * `distinct on` com `order by ... created_at desc` = uma linha por contato, a
 * mais recente. O metadata é jsonb: o `contact_id`/`campaign_id` de lá é texto,
 * e o `join` da campanha converte — `c.id::text` não usa índice, mas a lista é
 * de até 5.000 contatos e a auditoria já vem filtrada pela ação e pela
 * organização.
 *
 * Sem PII: a trilha guarda ponteiros, e o que sai daqui é nome de campanha e
 * data.
 */
export const SQL_ABORDAGEM_DA_TRILHA = `select distinct on ((a.metadata->>'contact_id'))
              (a.metadata->>'contact_id') as contact_id,
              c.name as campanha,
              a.created_at as em
         from api_audit_log a
         left join prospecting_campaigns c
                on c.organization_id=a.organization_id and c.id::text=(a.metadata->>'campaign_id')
        where a.organization_id=$1
          and a.action='prospecting.approach_sent'
          and (a.metadata->>'contact_id')=any($2::text[])
        order by (a.metadata->>'contact_id'), a.created_at desc`;

/** Uma passagem da trilha: o contato, a campanha de onde a abordagem saiu e quando. */
export type AbordagemDaTrilha = {
  contact_id: string;
  campanha?: string | null;
  em: string | Date;
};

/** As abordagens mais recentes dos contatos dados, por contato. */
export async function lerAbordagens(
  db: Banco,
  org: string,
  contatos: readonly string[],
): Promise<Map<string, AbordagemDaTrilha>> {
  if (contatos.length === 0) return new Map();
  const linhas = (await db.query<AbordagemDaTrilha>(SQL_ABORDAGEM_DA_TRILHA, [org, [...contatos]]))
    .rows;
  return new Map(linhas.map((a) => [a.contact_id, a]));
}

/**
 * A abordagem da EMPRESA: a passagem mais recente entre os contatos ligados a
 * ela. A linha sem `contact_id` (a triagem pulou por "Contato já existe")
 * também é coberta, porque `ligarContatos` achou o contato pelo telefone.
 */
export function abordagemDaEmpresa(
  c: CandidatoDaLista,
  abordagens: ReadonlyMap<string, AbordagemDaTrilha>,
): AbordagemDaTrilha | null {
  const candidatos = [
    ...(c.contact_id ? [c.contact_id] : []),
    ...(c.contatos ?? []).map((k) => k.id),
  ];
  let achada: AbordagemDaTrilha | null = null;
  for (const id of new Set(candidatos)) {
    const a = abordagens.get(id);
    if (!a) continue;
    if (!achada || new Date(a.em).getTime() > new Date(achada.em).getTime()) achada = a;
  }
  return achada;
}

/** A lista da campanha `campanhaId` da organização `org`, já com os contatos e a trilha. */
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
  const comContatos = ligarContatos(linhas, contatos);
  const contatosDasEmpresas = [
    ...new Set(comContatos.flatMap((c) => (c.contatos ?? []).map((k) => k.id))),
  ];
  if (contatosDasEmpresas.length === 0) return comContatos;
  const abordagens = await lerAbordagens(db, org, contatosDasEmpresas);
  return comContatos.map((c) => ({
    ...c,
    abordagem: abordagemDaEmpresa(c, abordagens),
  }));
}
