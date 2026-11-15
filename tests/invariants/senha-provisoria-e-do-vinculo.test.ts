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
 *      vínculo: a policy `user_orgs_update` exige admin na organização. Sem
 *      isso, bastaria um PATCH no PostgREST com o token da sessão para destravar
 *      `/api/v1` inteiro.
 *
 *   4. **Nem o admin da organização escreve a marca** (migration 9381). A policy
 *      deixa o admin reescrever o vínculo, e a obrigação vale para a PESSOA:
 *      sem o gatilho `trg_senha_provisoria_so_pelo_servidor`, o admin de uma
 *      empresa forçaria a troca de senha de quem também está em outra empresa,
 *      ou desligaria a marca de quem ele criou. Quem liga a marca é a rota de
 *      criação e quem desliga é a troca de senha — os dois com service role,
 *      que é o controle positivo abaixo.
 *
 * O controle do admin editando OUTRA coluna prova que o gatilho recusa só a
 * marca, não o vínculo inteiro.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_AGENT_B, GOV_ADMIN, GOV_ORG, seedGov, sql, writeCountAs } from "./gov-helpers";

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

/** O erro do psql de uma escrita da sessão (stderr), ou `null` se ela passou. */
function recusaDaSessao(userId: string, dml: string): string | null {
  try {
    writeCountAs(userId, dml);
    return null;
  } catch (err) {
    return (err as { stderr?: string }).stderr ?? String(err);
  }
}

/** Escrita como o cliente de serviço da rota de criação / da troca de senha. */
function comoServidor(dml: string): void {
  sql(`set role service_role; ${dml};`);
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

  it("o admin da organização NÃO desliga a marca de um membro: o gatilho recusa", () => {
    expect(valorDoVinculo(GOV_AGENT_A)).toBe("true");
    const erro = recusaDaSessao(
      GOV_ADMIN,
      `update public.user_organizations set senha_provisoria = false
        where user_id = '${GOV_AGENT_A}' and organization_id = '${GOV_ORG}'`,
    );
    expect(erro).toMatch(/senha_provisoria_so_pelo_servidor/);
    expect(valorDoVinculo(GOV_AGENT_A)).toBe("true");
  });

  it("o admin da organização NÃO liga a marca de um membro: o gatilho recusa", () => {
    expect(valorDoVinculo(GOV_AGENT_B)).toBe("false");
    const erro = recusaDaSessao(
      GOV_ADMIN,
      `update public.user_organizations set senha_provisoria = true
        where user_id = '${GOV_AGENT_B}' and organization_id = '${GOV_ORG}'`,
    );
    expect(erro).toMatch(/senha_provisoria_so_pelo_servidor/);
    expect(valorDoVinculo(GOV_AGENT_B)).toBe("false");
  });

  it("o admin segue editando o resto do vínculo (o gatilho recusa só a marca)", () => {
    const linhas = writeCountAs(
      GOV_ADMIN,
      `update public.user_organizations set role = role
        where user_id = '${GOV_AGENT_B}' and organization_id = '${GOV_ORG}'`,
    );
    expect(linhas).toBe(1);
  });

  it("o servidor (service role) liga e desliga a marca — a rota de criação e a troca", () => {
    comoServidor(`update public.user_organizations set senha_provisoria = true
      where user_id = '${GOV_AGENT_B}' and organization_id = '${GOV_ORG}'`);
    expect(valorDoVinculo(GOV_AGENT_B)).toBe("true");
    comoServidor(`update public.user_organizations set senha_provisoria = false
      where user_id = '${GOV_AGENT_B}' and organization_id = '${GOV_ORG}'`);
    expect(valorDoVinculo(GOV_AGENT_B)).toBe("false");
  });
});
