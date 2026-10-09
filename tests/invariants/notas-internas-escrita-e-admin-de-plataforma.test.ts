/**
 * 0478 — a outra metade do conserto das notas internas (#1863).
 *
 * `notas-internas-respeitam-a-visibilidade-da-conversa.test.ts` mede a LEITURA.
 * Este arquivo mede o que a 0478 também mudou e ninguém media:
 *
 *   · a ESCRITA. `conversation_notes_write` é `for all` e ganhou a mesma
 *     condição de `fn_can_view_conversation`. Sem ela, o agent que não vê a
 *     conversa inseria, alterava e apagava nota nela — e o `for all` ainda
 *     concederia SELECT, anulando a leitura nova.
 *   · o ADMIN DE PLATAFORMA. O ramo `or fn_is_platform_admin()` da policy
 *     antiga virou `conversation_notes_select_platform_admin`; o admin de
 *     plataforma não é membro de organização nenhuma, e sem essa policy a nota
 *     sumiria para ele.
 *
 * Previsão escrita antes de rodar: com a write policy antiga (só org + papel)
 * os três casos de "não" ficam vermelhos (1 em vez de 0); sem a policy própria
 * do admin de plataforma, o caso dele devolve 0.
 *
 * Arquivo à parte (e não casos no irmão) porque `tests/invariants/**` é
 * congelado para modificação pelo pre-commit — acrescentar é o caminho da casa.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_CONV_AGENT_B,
  GOV_ORG,
  countAs,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

const NOTA = "d0d0d0d0-0478-4000-8000-000000000040";
/** Sondas de INSERT; apagadas no seed para o controle positivo contar 1 a cada rodada. */
const SONDA_A = "d0d0d0d0-0478-4000-8000-000000000041";
const SONDA_B = "d0d0d0d0-0478-4000-8000-000000000042";
/** Admin de plataforma SEM vínculo com GOV_ORG. */
const PLAT_ADMIN = "d0d0d0d0-0478-4000-8000-000000000050";

const inserirNota = (id: string, autor: string) =>
  `insert into public.conversation_notes (id, organization_id, conversation_id, body, created_by_user_id, created_by_name)
     values ('${id}', '${GOV_ORG}', '${GOV_CONV_AGENT_B}', 'sonda de escrita', '${autor}', 'sonda')`;

beforeAll(() => {
  seedGov();
  sql(`
    delete from public.conversation_notes where id in ('${SONDA_A}', '${SONDA_B}');
    insert into public.conversation_notes
      (id, organization_id, conversation_id, body, created_by_user_id, created_by_name)
      values ('${NOTA}', '${GOV_ORG}', '${GOV_CONV_AGENT_B}', 'nota na conversa do B', '${GOV_AGENT_B}', 'seed')
      on conflict (id) do update set body = excluded.body, created_by_user_id = '${GOV_AGENT_B}';

    insert into auth.users (id, email)
      values ('${PLAT_ADMIN}', 'plat-admin-0478@invariant.test') on conflict do nothing;
    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason)
      values ('${PLAT_ADMIN}', '${PLAT_ADMIN}', 'full', false, 'Invariante 0478')
      on conflict (user_id) do update set revoked_at = null, scope = 'full';
  `);
});

describe("0478 — a escrita acompanha a visibilidade da conversa", () => {
  it("quem NÃO vê a conversa não insere nota nela", () => {
    expect(writeCountAs(GOV_AGENT_A, inserirNota(SONDA_A, GOV_AGENT_A))).toBe(0);
  });

  it("quem NÃO vê a conversa não altera a nota dela", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.conversation_notes set body = 'alterada' where id = '${NOTA}'`,
      ),
    ).toBe(0);
  });

  it("quem NÃO vê a conversa não apaga a nota dela", () => {
    expect(
      writeCountAs(GOV_AGENT_A, `delete from public.conversation_notes where id = '${NOTA}'`),
    ).toBe(0);
  });

  it("CONTROLE POSITIVO: o dono da conversa insere e altera nota nela", () => {
    expect(writeCountAs(GOV_AGENT_B, inserirNota(SONDA_B, GOV_AGENT_B))).toBe(1);
    expect(
      writeCountAs(
        GOV_AGENT_B,
        `update public.conversation_notes set body = 'nota na conversa do B' where id = '${NOTA}'`,
      ),
    ).toBe(1);
  });
});

describe("0478 — o admin de plataforma continua vendo", () => {
  it("admin de plataforma sem vínculo com a org lê a nota", () => {
    const contar = `select count(*) from public.conversation_notes where id = '${NOTA}';`;
    expect(countAs(PLAT_ADMIN, contar)).toBe(1);
  });
});
