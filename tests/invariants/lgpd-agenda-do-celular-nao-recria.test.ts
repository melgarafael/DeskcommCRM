/**
 * #3432, a SEGUNDA PORTA: a agenda do celular não pode recriar a ficha que o
 * titular pediu para anonimizar.
 *
 * ─── O defeito medido ──────────────────────────────────────────────────────
 *
 * A anonimização LGPD ZERA o telefone da ficha e apaga as linhas de
 * `contact_phones` (migration 9243). A pré-leitura da agenda do celular
 * ("Sincronizar agenda do celular", #2736, `lib/contacts/agenda-do-celular.ts`)
 * procura o número em `contacts.phone_number` e em `contact_phones` — nas duas,
 * a ficha anonimizada é invisível. Sem a pergunta da 0750, o
 * `fn_upsert_wa_contact` do lote INSERE uma ficha nova com o número e o nome da
 * agenda: o pedido do titular desfeito por um caminho lateral que roda sozinho,
 * sem ninguém clicar em nada (a agenda do aparelho sincroniza por conta própria).
 *
 * ─── O que este arquivo prova, com o banco de verdade ──────────────────────
 *
 * As duas portas rodam o CÓDIGO DE PRODUÇÃO sobre o Postgres do harness:
 *
 *   · `smb_app_state_sync` → `ingestMetaAppContactSync` (a porta fechada no
 *     #4251);
 *   · "Sincronizar agenda do celular" → `sincronizarAgendaDoCelular` com as
 *     deps reais (`criarDepsDeAgenda`), inclusive o `fn_upsert_wa_contact`.
 *
 * E as duas recebem a MESMA asserção: depois de rodar, não existe ficha viva
 * com nenhuma grafia do número — a marca de apagamento continua de pé.
 *
 * A pergunta é a mesma nas duas: a unitária `fn_titular_apagado_a_pedido` (porta
 * da coexistência) e a de lote `fn_titulares_apagados_a_pedido` (porta da
 * agenda, migration 9321). Falha fechada nas duas: sem resposta, nada é criado.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/** O `audit()` real fala com o Supabase do ambiente; aqui as deps o substituem. */
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import type { ContatoDoAparelho } from "@/lib/channels";
import { ingestMetaAppContactSync } from "@/lib/channels/meta/ingest";
import type { AppContactSyncEvent } from "@/lib/channels/meta/webhook";
import { canonicalPhoneBR, phoneLookupVariants } from "@/lib/channels/phone-variants";
import { criarDepsDeAgenda, sincronizarAgendaDoCelular } from "@/lib/contacts/agenda-do-celular";
import { meetPgSupabase } from "../support/meet-pg-supabase";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});

const ORG = "3432a000-0000-4000-8000-00000000000a";
const CONTATO_APAGADO = "3432a000-2222-4000-8000-000000000001";
const MEMBRO = "3432a000-1111-4000-8000-000000000001";
const SESSAO = "3432a000-3333-4000-8000-000000000001";
/** Como o número está GRAVADO na ficha antes da anonimização. */
const TELEFONE = "5531988887777";
/**
 * Como as duas portas entregam o MESMO número: a agenda do aparelho e o
 * `smb_app_state_sync` mandam só os dígitos, e a Meta pode omitir o nono.
 */
const TELEFONE_ENTREGUE = "553188887777";

const { client } = meetPgSupabase(pool);

/** Todas as grafias do número — a pergunta e a contagem usam a mesma lista. */
const VARIANTES = [...new Set([...phoneLookupVariants(TELEFONE_ENTREGUE), `+${TELEFONE}`])];

async function contarFichasComONumero(): Promise<number> {
  const r = await pool.query(
    `select count(*)::int as n from public.contacts
      where organization_id = $1 and phone_number = any($2::text[])`,
    [ORG, VARIANTES],
  );
  return (r.rows[0] as { n: number }).n;
}

/** A ficha do titular continua no acervo, anonimizada e sem telefone. */
async function fichaAnonimizadaEstaLa(): Promise<boolean> {
  const r = await pool.query(
    `select (is_anonymized and phone_number is null) as ok
       from public.contacts where id = $1`,
    [CONTATO_APAGADO],
  );
  return (r.rows[0] as { ok: boolean } | undefined)?.ok === true;
}

/**
 * A MESMA asserção das duas portas: o número não voltou para o cadastro, e a
 * ficha anonimizada continua lá (o que não volta é o DADO, não o histórico).
 */
async function nenhumaFichaComONumero(): Promise<void> {
  expect(await contarFichasComONumero()).toBe(0);
  expect(await fichaAnonimizadaEstaLa()).toBe(true);
}

beforeAll(async () => {
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name)
     values ($1, 'agenda-lgpd-3432', 'Agenda LGPD', 'Agenda LGPD')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into public.contacts (id, organization_id, name, phone_number)
     values ($1, $2, 'Titular Apagado', $3)
     on conflict (id) do nothing`,
    [CONTATO_APAGADO, ORG, `+${TELEFONE}`],
  );
  // O gesto do titular: a cascata zera o telefone, apaga os extras e grava a
  // marca de apagamento (que é o que as duas portas perguntam).
  await pool.query(`select public.fn_lgpd_cascade_redact_contact($1, $2, gen_random_uuid());`, [
    ORG,
    CONTATO_APAGADO,
  ]);
});

afterAll(async () => {
  await pool.end();
});

describe("o número apagado a pedido não volta por nenhuma das duas portas", () => {
  it("ponto de partida: o número não existe em ficha viva e a ficha anonimizada ficou", async () => {
    await nenhumaFichaComONumero();
    // A pré-leitura da agenda não tem o que achar — é por isso que ela precisa
    // da pergunta: sem ela, o upsert insere.
    const sobrou = await pool.query(
      `select count(*)::int as n from public.contact_phones
        where organization_id = $1 and phone_number = any($2::text[])`,
      [ORG, VARIANTES],
    );
    expect((sobrou.rows[0] as { n: number }).n).toBe(0);
  });

  it("sem a pergunta, o upsert RECRIA a ficha — é a pergunta que fecha a porta", async () => {
    const criado = await pool.query(
      `select public.fn_upsert_wa_contact(
         p_org => $1, p_kind => 'phone', p_phone => $2, p_lid => null,
         p_chat_id => $3, p_notify => null) as id`,
      [ORG, `+${TELEFONE_ENTREGUE}`, `${TELEFONE_ENTREGUE}@c.us`],
    );
    expect((criado.rows[0] as { id: string }).id).toBeTruthy();
    expect(await contarFichasComONumero()).toBe(1);
    // Volta ao ponto de partida: o resto do arquivo mede as portas, não a RPC solta.
    await pool.query(
      `delete from public.contacts where organization_id = $1 and phone_number = any($2::text[])`,
      [ORG, VARIANTES],
    );
    await nenhumaFichaComONumero();
  });

  it("porta da coexistência (smb_app_state_sync): ignora, e não cria ficha", async () => {
    const evento: AppContactSyncEvent = {
      kind: "app_contact_sync",
      wabaId: "waba-3432",
      phoneNumberId: "phone-3432",
      phone: TELEFONE_ENTREGUE,
      name: "Ana Souza",
      action: "add",
    };

    const r = await ingestMetaAppContactSync(client, evento, {
      organizationId: ORG,
      channelSessionId: SESSAO,
    });

    expect(r).toEqual({ status: "ignored", reason: "titular_apagado_a_pedido" });
    await nenhumaFichaComONumero();
  });

  it("porta da agenda do celular: ignora, e não cria ficha", async () => {
    const contatoDoAparelho: ContatoDoAparelho = {
      id: `${TELEFONE_ENTREGUE}@c.us`,
      name: "Ana Souza",
      pushname: null,
      isMyContact: true,
      isWAContact: true,
      isMe: false,
    };
    const deps = criarDepsDeAgenda(client, async () => [contatoDoAparelho]);

    const resumo = await sincronizarAgendaDoCelular(
      {
        ...deps,
        // O `audit()` real escreve pelo client de serviço do ambiente; o que
        // interessa aqui é o resumo, e ele é o mesmo objeto.
        audit: async () => undefined,
      },
      {
        organizationId: ORG,
        session: "sessao-3432",
        actorUserId: MEMBRO,
        requestId: randomUUID(),
      },
    );

    expect(resumo.importados).toBe(0);
    expect(resumo.ignorados).toBe(1);
    // A pergunta foi feita ANTES de qualquer escrita: nada foi para a fila do upsert.
    expect(resumo.erros).toBe(0);
    await nenhumaFichaComONumero();
  });

  it("as duas portas fazem a MESMA pergunta, e ela responde sim nas duas grafias", async () => {
    // Porta fechada: a pergunta unitária.
    const unitaria = await pool.query(
      `select public.fn_titular_apagado_a_pedido($1, $2, null) as apagado`,
      [ORG, `+${TELEFONE_ENTREGUE}`],
    );
    expect((unitaria.rows[0] as { apagado: boolean }).apagado).toBe(true);
    // Porta nova: a pergunta em lote, com as duas grafias do mesmo número.
    const lote = await pool.query(
      `select public.fn_titulares_apagados_a_pedido($1, $2::text[]) as apagados`,
      [ORG, VARIANTES],
    );
    expect([...(lote.rows[0] as { apagados: string[] }).apagados].sort()).toEqual(
      [...VARIANTES].sort(),
    );
    expect(canonicalPhoneBR(`+${TELEFONE_ENTREGUE}`)).toBe(`+${TELEFONE}`);
  });
});
