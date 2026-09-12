/**
 * LIGAR A CHAMADA DE VOZ DA ORGANIZAÇÃO É AÇÃO DE ADMIN — NO BANCO, NÃO NA ROTA.
 *
 * ## O que está sendo protegido
 *
 * Uma linha `enabled = true` em `org_voice_calls` autoriza vincular um SEGUNDO
 * APARELHO ao número de WhatsApp que a empresa usa para vender, por um caminho
 * que não é o oficial. O risco é a CONTA ser bloqueada.
 *
 * ## Por que a policy, e não o `admin` da rota
 *
 * É a lição que a 0143 pagou como forward-fix da 0142, e ela vale palavra por
 * palavra aqui: **rota não é fronteira**. O `baseline.sql` tem
 * `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated`, e
 * isso vale para toda tabela criada DEPOIS dele — inclusive esta. Com a anon
 * key (que vai para o browser) e o próprio JWT, um membro qualquer escreveria
 * direto pelo PostgREST: sem passar pela rota, sem o aceite do risco que o Zod
 * exige, e sem linha de auditoria, porque o `audit()` vive na rota.
 *
 * Naquele caso o papel mais baixo do produto desarmou a defesa anti-manipulação
 * da organização. Aqui ele autorizaria o pareamento de um aparelho no número da
 * empresa.
 *
 * ## Por que este arquivo, e não o de schema
 *
 * O irmão de schema conecta como `postgres`, que é `rolbypassrls = t`: ele
 * prova CATÁLOGO (a tabela existe, a RLS está ligada, a policy tem tal nome),
 * nunca a policy em vigor. Aqui se roda como `authenticated`, com o JWT de cada
 * papel.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_ADMIN,
  GOV_AGENT_A,
  GOV_MANAGER,
  GOV_ORG,
  GOV_VIEWER,
  countAs,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

beforeAll(() => {
  seedGov();
  sql(`
    delete from public.org_voice_calls where organization_id = '${GOV_ORG}';
    insert into public.org_voice_calls (organization_id, enabled)
      values ('${GOV_ORG}', false);
  `);
});

describe("escrita em org_voice_calls exige admin", () => {
  for (const [rotulo, usuario] of [
    ["viewer", GOV_VIEWER],
    ["agent", GOV_AGENT_A],
    ["manager", GOV_MANAGER],
  ] as const) {
    it(`${rotulo} NÃO liga a chamada de voz da organização`, () => {
      const escritas = writeCountAs(
        usuario,
        `update public.org_voice_calls set enabled = true
           where organization_id = '${GOV_ORG}'`,
      );
      expect(
        escritas,
        `${rotulo} autorizou vincular um segundo aparelho ao número da empresa`,
      ).toBe(0);
    });

    it(`${rotulo} NÃO cria a linha por INSERT`, () => {
      // O UPDATE acima só cobre a linha que existe. Sem este caso, um `with
      // check` frouxo deixaria o mesmo papel LIGAR a feature de uma organização
      // que ainda não tem linha — que é o estado de toda organização do parque.
      const escritas = writeCountAs(
        usuario,
        `insert into public.org_voice_calls (organization_id, enabled)
           values ('${GOV_ORG}', true)
           on conflict (organization_id) do update set enabled = true`,
      );
      expect(escritas).toBe(0);
    });
  }

  it("admin liga", () => {
    // GUARDA DO INSTRUMENTO: sem este caso, uma policy que recusa TODO MUNDO
    // (ou uma tabela inalcançável) deixaria os seis casos acima verdes sem que
    // a regra medida fosse "só admin" — seria "ninguém".
    const escritas = writeCountAs(
      GOV_ADMIN,
      `update public.org_voice_calls set enabled = true
         where organization_id = '${GOV_ORG}'`,
    );
    expect(escritas).toBe(1);
  });

  it("a leitura é org-flat: quem atende enxerga o estado", () => {
    // Leitura org-flat por precedência declarada do repo (mesma forma de
    // `crm_stages_select`): o `manager` exigido no GET da rota é gate de TELA, e
    // tela que oferece menos que o banco permite é decisão de produto, não
    // brecha entre clientes.
    expect(countAs(GOV_VIEWER, `select 1 from public.org_voice_calls where organization_id = '${GOV_ORG}'`)).toBe(1);
  });
});
