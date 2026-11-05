/**
 * #3876 (fatia 1) — a senha provisória é do VÍNCULO, nasce falsa e não se
 * desarma pela mão de quem precisa trocá-la.
 *
 * Roda contra Postgres real porque as três afirmações são de banco, não de
 * código:
 *
 *   1. `user_organizations.senha_provisoria` existe, é `boolean not null` e o
 *      default é `false`. É esse default que preserva TODO o passado — inclusive
 *      cada vínculo criado por convite, que é o fluxo que continua valendo. Se
 *      alguém trocasse o default para `true`, a base inteira acordaria trancada
 *      na tela de troca de senha, e nenhum teste de componente pegaria isso.
 *
 *   2. Vínculo inserido sem a coluna (o INSERT do convite e o de toda rotina
 *      antiga) nasce `false`: o convidado não deve nada.
 *
 *   3. **O gate não se desarma por baixo.** O `authenticated` com a identidade
 *      da pessoa NÃO consegue escrever `senha_provisoria = false` no próprio
 *      vínculo: a policy `user_orgs_update` exige admin na organização
 *      (`fn_role_at_least(organization_id, 'admin')`). Sem isso, o redirect era
 *      só teatro — bastaria um PATCH no PostgREST com o token da sessão para
 *      destravar `/api/v1` inteiro. Quem destrava é a action de troca, com
 *      service-role, depois de o GoTrue aceitar a senha nova.
 *
 * O controle positivo (o admin da organização CONSEGUE) está aqui para provar
 * que o zero do caso 3 é recusa de RLS e não uma varredura cega.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_ADMIN, GOV_ORG, seedGov, sql, writeCountAs } from "./gov-helpers";

function coluna(): { tipo: string; nulo: string; padrao: string | null } {
  const out = sql(`
    select data_type, is_nullable, column_default
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'user_organizations'
       and column_name = 'senha_provisoria';
  `);
  const [tipo, nulo, padrao] = out.split("|");
  return { tipo: tipo ?? "", nulo: nulo ?? "", padrao: padrao ?? null };
}

function valorDoVinculo(userId: string): string {
  return sql(`
    select senha_provisoria::text
      from public.user_organizations
     where user_id = '${userId}' and organization_id = '${GOV_ORG}';
  `);
}

beforeAll(() => {
  seedGov();
});

describe("senha provisória no vínculo (#3876)", () => {
  it("a coluna existe, é boolean not null e o default é false", () => {
    const c = coluna();
    expect(c.tipo).toBe("boolean");
    expect(c.nulo).toBe("NO");
    expect(c.padrao).toBe("false");
  });

  it("todo vínculo do caminho antigo (convite) nasce sem troca obrigatória", () => {
    // O seed insere como o convite insere: sem citar a coluna.
    const pendentes = sql(`
      select count(*) from public.user_organizations
       where organization_id = '${GOV_ORG}' and senha_provisoria;
    `);
    expect(pendentes).toBe("0");
  });

  it("membro não desarma o próprio gate pela API: a RLS recusa", () => {
    // Estado de chegada: criado pelo admin, com a senha provisória de pé.
    sql(`
      update public.user_organizations set senha_provisoria = true
       where user_id = '${GOV_AGENT_A}' and organization_id = '${GOV_ORG}';
    `);
    expect(valorDoVinculo(GOV_AGENT_A)).toBe("true");

    // A tentativa óbvia de quem quer usar o produto antes de trocar a senha.
    const linhas = writeCountAs(
      GOV_AGENT_A,
      `update public.user_organizations set senha_provisoria = false
        where user_id = '${GOV_AGENT_A}'`,
    );

    expect(linhas).toBe(0);
    expect(valorDoVinculo(GOV_AGENT_A)).toBe("true");
  });

  it("o admin da organização consegue destravar (controle positivo da RLS)", () => {
    const linhas = writeCountAs(
      GOV_ADMIN,
      `update public.user_organizations set senha_provisoria = false
        where user_id = '${GOV_AGENT_A}' and organization_id = '${GOV_ORG}'`,
    );
    expect(linhas).toBe(1);
    expect(valorDoVinculo(GOV_AGENT_A)).toBe("false");
  });
});
