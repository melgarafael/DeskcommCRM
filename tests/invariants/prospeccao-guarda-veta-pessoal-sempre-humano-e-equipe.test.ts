/**
 * A GUARDA DA ABORDAGEM FRIA CONTRA O SCHEMA DO BASELINE.
 *
 * O teste de unidade (`lib/prospecting/guarda-veta-pessoal-sempre-humano-e-equipe.test.ts`)
 * mede a régua com um cliente falso. Aqui a guarda REAL lê o banco do
 * `baseline.sql` — o que o self-host instala —, então uma coluna com o nome
 * errado no `select` (`is_personal`, `ai_opt_out`, `tags`) ou a lista de
 * etiquetas lida do lugar errado de `organizations.settings` aparecem aqui, e
 * não no cliente falso.
 *
 * O cliente é um PostgREST mínimo sobre o `pg.Pool`: `from().select().eq()
 * .maybeSingle()` vira `select <colunas> from public.<tabela> where ...`. As
 * colunas e as tabelas vêm do código da guarda, nunca do teste — transcrevê-las
 * aqui mediria o teste contra ele mesmo.
 *
 * SABOTAGEM (prevista sem Docker; rodada na triagem da #4652 com
 * `pnpm test:db` deste arquivo, e o resultado bateu): voltar
 * `COLUNAS_DO_CONTATO` (`lib/prospecting/guard.ts`) para
 * `is_blocked,force_human,is_anonymized,source,consent` derruba os 7 casos de
 * marca — 4 da guarda cheia e 3 da leitura antes da vaga, que usa a mesma
 * constante —; os 2 controles (contato limpo e isolamento) seguem verdes.
 * 7 vermelhos de 9.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { assertProspectingDelivery, vetoDoContatoAntesDaVaga } from "@/lib/prospecting/guard";
import { ProspectingError } from "@/lib/prospecting/provider";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});
afterAll(() => pool.end());

/** O PostgREST mínimo que a guarda usa. Identificadores vêm do código da guarda. */
function clienteSobreOPostgres(): SupabaseClient {
  return {
    from(tabela: string) {
      const filtros: Array<[string, unknown]> = [];
      let colunas = "*";
      const consulta = {
        select(c: string) {
          colunas = c;
          return consulta;
        },
        eq(coluna: string, valor: unknown) {
          filtros.push([coluna, valor]);
          return consulta;
        },
        async maybeSingle() {
          const where = filtros.map(([c], i) => `${c} = $${i + 1}`).join(" and ");
          try {
            const { rows } = await pool.query(
              `select ${colunas} from public.${tabela}${where ? ` where ${where}` : ""} limit 2`,
              filtros.map(([, v]) => v),
            );
            if (rows.length > 1) return { data: null, error: { message: "mais de uma linha" } };
            return { data: rows[0] ?? null, error: null };
          } catch (e) {
            return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
          }
        },
      };
      return consulta;
    },
  } as unknown as SupabaseClient;
}

/** Uma organização com uma campanha rodando e UMA empresa no instante do envio. */
async function cenario(opcoes: {
  contato?: Partial<{ is_personal: boolean; ai_opt_out: boolean; tags: string[] }>;
  settings?: Record<string, unknown>;
}) {
  const org = randomUUID();
  const contato = randomUUID();
  const sessao = randomUUID();
  const conversa = randomUUID();
  const campanha = randomUUID();
  const candidata = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name,settings) values($1,$2,'Guarda','Guarda',$3)",
    [org, `guarda-${org.slice(0, 8)}`, JSON.stringify(opcoes.settings ?? {})],
  );
  await pool.query(
    `insert into contacts(id,organization_id,name,phone_number,source,consent,is_personal,ai_opt_out,tags)
     values($1,$2,'Empresa',$3,'prospecting',$4,$5,$6,$7)`,
    [
      contato,
      org,
      `+55119${Math.floor(10000000 + Math.random() * 89999999)}`,
      JSON.stringify({ legitimate_interest: { ref: "LIA-teste" } }),
      opcoes.contato?.is_personal ?? false,
      opcoes.contato?.ai_opt_out ?? false,
      opcoes.contato?.tags ?? [],
    ],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1,$2,$3,'\\x00'::bytea)",
    [sessao, org, `guarda-${sessao.slice(0, 8)}`],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')",
    [conversa, org, contato, sessao],
  );
  await pool.query(
    "insert into prospecting_campaigns(id,organization_id,request_id,name,search,config,status,channel_session_id) values($1,$2,$3,'c','{}','{}','running',$4)",
    [campanha, org, randomUUID(), sessao],
  );
  await pool.query(
    `insert into prospecting_candidates(id,organization_id,campaign_id,conversation_id,contact_id,status,place_id,data)
     values($1,$2,$3,$4,$5,'sending',$6,'{"name":"Empresa"}')`,
    [candidata, org, campanha, conversa, contato, `place-${candidata.slice(0, 8)}`],
  );
  return { organizationId: org, candidateId: candidata, conversationId: conversa };
}

async function vetoDe(ctx: Awaited<ReturnType<typeof cenario>>) {
  return assertProspectingDelivery(clienteSobreOPostgres(), ctx).then(
    () => null,
    (e: unknown) => e,
  );
}

describe("a guarda da abordagem fria lê as três marcas do banco do baseline", () => {
  it.each([
    { caso: "ficha pessoal", opcoes: { contato: { is_personal: true } }, motivo: "Contato marcado como pessoal." },
    {
      caso: "sempre atendimento humano",
      opcoes: { contato: { ai_opt_out: true } },
      motivo: "Contato marcado como sempre atendimento humano.",
    },
    {
      caso: "etiqueta de contato interno",
      opcoes: { contato: { tags: ["interno"] }, settings: { crm: { internal_contact_tags: [" Interno "] } } },
      motivo: "Contato interno (marcado por etiqueta).",
    },
    {
      caso: "etiqueta de contato da equipe",
      opcoes: { contato: { tags: ["socio"] }, settings: { crm: { team_contact_tags: ["socio"] } } },
      motivo: "Contato da equipe (marcado por etiqueta).",
    },
  ])("$caso: recusa com o motivo e escopo do candidato", async ({ opcoes, motivo }) => {
    const erro = await vetoDe(await cenario(opcoes));
    expect(erro).toBeInstanceOf(ProspectingError);
    expect((erro as ProspectingError).message).toBe(motivo);
    expect((erro as ProspectingError).escopo).toBe("candidato");
  });

  it("controle: contato sem marca nenhuma passa", async () => {
    expect(await vetoDe(await cenario({}))).toBeNull();
  });

  it("isolamento: a lista de etiquetas lida é a da organização do envio, não a de outra", async () => {
    // Outra organização marca "interno" como etiqueta interna; a do envio não
    // configurou lista nenhuma. O contato etiquetado da organização do envio passa.
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name,settings) values($1,$2,'Outra','Outra',$3)",
      [randomUUID(), `guarda-outra-${randomUUID().slice(0, 8)}`, JSON.stringify({ crm: { internal_contact_tags: ["interno"] } })],
    );
    expect(await vetoDe(await cenario({ contato: { tags: ["interno"] } }))).toBeNull();
  });
});

describe("a leitura ANTES da vaga lê as mesmas marcas do banco do baseline", () => {
  // O worker confere as marcas antes de reservar a vaga do número; se esta
  // leitura errasse uma coluna, ela devolveria `null` e a vetada gastaria a
  // vaga (a guarda cheia ainda barraria o envio, mais tarde).
  it.each([
    { opcoes: { contato: { is_personal: true } }, motivo: "Contato marcado como pessoal." },
    { opcoes: { contato: { ai_opt_out: true } }, motivo: "Contato marcado como sempre atendimento humano." },
    {
      opcoes: { contato: { tags: ["socio"] }, settings: { crm: { team_contact_tags: ["socio"] } } },
      motivo: "Contato da equipe (marcado por etiqueta).",
    },
  ])("$motivo", async ({ opcoes, motivo }) => {
    const ctx = await cenario(opcoes);
    const { rows } = await pool.query<{ contact_id: string }>(
      "select contact_id from prospecting_candidates where id=$1",
      [ctx.candidateId],
    );
    expect(
      await vetoDoContatoAntesDaVaga(clienteSobreOPostgres(), ctx.organizationId, rows[0]!.contact_id),
    ).toBe(motivo);
  });
});
