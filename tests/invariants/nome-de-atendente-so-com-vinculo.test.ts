/**
 * O NOME DE ATENDENTE NA CONVERSA SÓ EXISTE PARA QUEM TEM OU TEVE VÍNCULO COM A
 * ORGANIZAÇÃO (migration 9219).
 *
 * `conversations.assigned_to_user_name` é a cópia desnormalizada do nome de
 * quem atende. Dois trechos do `baseline.sql` — que o `update.sh` re-aplica a
 * cada atualização — escrevem nela:
 *
 *   1. o backfill da 0202, que preenche o nome das linhas atribuídas sem nome;
 *   2. o bloco da 9219, que zera o nome das linhas fora da regra.
 *
 * Os dois são EXTRAÍDOS do arquivo que o self-hoster aplica e EXECUTADOS dentro
 * de uma transação revertida (o resto da suíte não herda o efeito). Um `grep`
 * pelo predicado mediria presença de texto, não comportamento.
 *
 * Vínculo é linha em `user_organizations` com a organização DA CONVERSA, sem
 * filtro de `revoked_at`: ex-membro segue com o nome. Membro de OUTRA
 * organização não tem vínculo — é o caso que separa "existe vínculo" de
 * "existe vínculo com esta organização".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

/** O UPDATE de backfill do bloco da 0202, exatamente como está no arquivo. */
function backfillDa0202(): string {
  const inicio = BASELINE.indexOf(
    "update public.conversations c\n   set assigned_to_user_name = u.raw_user_meta_data ->> 'full_name'",
  );
  if (inicio < 0) throw new Error("backfill da 0202 não encontrado em supabase/baseline.sql");
  const fim = BASELINE.indexOf(";\n", inicio);
  return BASELINE.slice(inicio, fim + 2);
}

const MARCADOR_9219 = "-- ---- nome de atendente só para quem tem vínculo com a organização (migration 9219)";

/** O bloco da 9219 no apêndice, até o próximo rótulo de bloco (ou o fim). */
function blocoDa9219(): string {
  const inicio = BASELINE.indexOf(MARCADOR_9219);
  if (inicio < 0) throw new Error("bloco da 9219 não encontrado em supabase/baseline.sql");
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + MARCADOR_9219.length);
  const bloco = fim < 0 ? BASELINE.slice(inicio) : BASELINE.slice(inicio, fim);
  if (!/set assigned_to_user_name = null/.test(bloco)) {
    throw new Error("bloco extraído não zera o nome (extração quebrada)");
  }
  return bloco;
}

const ORG = "9219cccc-0000-4000-8000-000000000001";
const OUTRA_ORG = "9219cccc-0000-4000-8000-000000000002";
const SESSAO = "9219cccc-2222-4000-8000-000000000001";

const MEMBRO = "9219cccc-1111-4000-8000-000000000001";
const EX_MEMBRO = "9219cccc-1111-4000-8000-000000000002";
const DE_OUTRA_ORG = "9219cccc-1111-4000-8000-000000000003";
const SEM_VINCULO = "9219cccc-1111-4000-8000-000000000004";

const USUARIOS: Array<[string, string]> = [
  [MEMBRO, "Ana Membro"],
  [EX_MEMBRO, "Bia Ex-Membro"],
  [DE_OUTRA_ORG, "Caio Outra Org"],
  [SEM_VINCULO, "Davi Sem Vinculo"],
];

/** Uma conversa por usuário, cada uma com o próprio contato. */
const CONVERSA: Record<string, string> = Object.fromEntries(
  USUARIOS.map(([id], i) => [id, `9219cccc-4444-4000-8000-00000000000${i + 1}`]),
);

beforeAll(() => {
  const usuarios = USUARIOS.map(
    ([id, nome]) =>
      `insert into auth.users (id, email, raw_user_meta_data)
         values ('${id}', '${id}@invariant.test', '{"full_name": "${nome}"}'::jsonb)
         on conflict do nothing;`,
  ).join("\n");
  const conversas = USUARIOS.map(([id], i) => {
    const contato = `9219cccc-3333-4000-8000-00000000000${i + 1}`;
    return `
      insert into public.contacts (id, organization_id, display_name)
        values ('${contato}', '${ORG}', 'Contato 9219 ${i + 1}') on conflict do nothing;
      insert into public.conversations
          (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at)
        values ('${CONVERSA[id]}', '${ORG}', '${contato}', '${SESSAO}', 'claimed', '${id}', now())
        on conflict do nothing;`;
  }).join("\n");

  sql(`
    ${usuarios}
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'inv-9219', 'Org 9219', 'Org 9219'),
             ('${OUTRA_ORG}', 'inv-9219-outra', 'Outra 9219', 'Outra 9219')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at, revoked_at)
      values ('${MEMBRO}', '${ORG}', 'agent', now(), null),
             ('${EX_MEMBRO}', '${ORG}', 'agent', now(), now()),
             ('${DE_OUTRA_ORG}', '${OUTRA_ORG}', 'agent', now(), null)
      on conflict do nothing;
    do $s$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO}', '${ORG}', 'inv-9219', '\\x00'::bytea);
    exception when unique_violation then null; end $s$;
    ${conversas}
  `);
});

/** Roda `preparo` + `bloco` numa transação revertida e devolve o nome de cada conversa. */
function nomesDepois(preparo: string, bloco: string): Record<string, string | null> {
  const ids = USUARIOS.map(([id]) => `'${CONVERSA[id]}'`).join(", ");
  const out = sql(`
    begin;
    ${preparo}
    ${bloco}
    select assigned_to_user_id || '=' || coalesce(assigned_to_user_name, '<null>')
      from public.conversations where id in (${ids});
    rollback;
  `);
  const nomes: Record<string, string | null> = {};
  for (const linha of out.split("\n")) {
    const m = /^([0-9a-f-]{36})=(.*)$/.exec(linha.trim());
    const [, id, nome] = m ?? [];
    if (id) nomes[id] = nome === "<null>" ? null : (nome ?? null);
  }
  if (Object.keys(nomes).length !== USUARIOS.length) {
    throw new Error(`esperava ${USUARIOS.length} conversas, li: ${out}`);
  }
  return nomes;
}

const IDS = USUARIOS.map(([id]) => `'${CONVERSA[id]}'`).join(", ");

describe("backfill da 0202 (re-aplicado pelo update.sh)", () => {
  it("só preenche o nome de quem tem ou teve vínculo com a organização da conversa", () => {
    const nomes = nomesDepois(
      `update public.conversations set assigned_to_user_name = null where id in (${IDS});`,
      backfillDa0202(),
    );
    expect(nomes[MEMBRO]).toBe("Ana Membro");
    expect(nomes[EX_MEMBRO]).toBe("Bia Ex-Membro");
    expect(nomes[DE_OUTRA_ORG]).toBeNull();
    expect(nomes[SEM_VINCULO]).toBeNull();
  });
});

describe("bloco da 9219 (forward-fix, re-aplicado pelo update.sh)", () => {
  const nomesGravados = USUARIOS.map(
    ([id, nome]) =>
      `update public.conversations set assigned_to_user_name = '${nome}' where id = '${CONVERSA[id]}';`,
  ).join("\n");

  it("zera o nome de quem não tem vínculo e mantém o de membro e ex-membro", () => {
    const nomes = nomesDepois(nomesGravados, blocoDa9219());
    expect(nomes[MEMBRO]).toBe("Ana Membro");
    expect(nomes[EX_MEMBRO]).toBe("Bia Ex-Membro");
    expect(nomes[DE_OUTRA_ORG]).toBeNull();
    expect(nomes[SEM_VINCULO]).toBeNull();
  });

  it("re-aplicado duas vezes, termina no mesmo estado", () => {
    const bloco = blocoDa9219();
    expect(nomesDepois(nomesGravados, `${bloco}\n${bloco}`)).toEqual(nomesDepois(nomesGravados, bloco));
  });
});
