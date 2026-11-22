/**
 * O RECEBIMENTO DO CLIENTE FINAL SÓ É ESCRITO PELO SERVIDOR (migration 9312, #3509).
 *
 * As duas portas de escrita de `pagamento_recebimentos` são rotas do servidor:
 * o registro na conversa (confere papel e organização) e o aviso do provedor
 * (confere o segredo do recebimento e o valor). Uma terceira, pela REST com a
 * sessão do usuário, seria um "pago" que o provedor não disse — e depois o aviso
 * real cairia em "duplicado". A sessão LÊ; não escreve.
 */
import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

describe("pagamento_recebimentos: a sessão do usuário lê e não escreve", () => {
  it("authenticated e anon não têm insert, update, delete nem truncate", () => {
    for (const papel of ["anon", "authenticated"]) {
      for (const privilegio of ["insert", "update", "delete", "truncate"]) {
        expect(
          sql(`
            select case when to_regrole('${papel}') is null then 'sem-role'
                        when has_table_privilege('${papel}', 'public.pagamento_recebimentos', '${privilegio}')
                          then 'exposta'
                        else 'fechada' end;
          `),
          `pagamento_recebimentos com ${privilegio} para ${papel}`,
        ).toBe("fechada");
      }
    }
  });

  it("controle: authenticated lê, e o servidor escreve", () => {
    expect(sql(`select has_table_privilege('authenticated', 'public.pagamento_recebimentos', 'select');`)).toBe("t");
    expect(sql(`select has_table_privilege('service_role', 'public.pagamento_recebimentos', 'update');`)).toBe("t");
  });

  it("nenhuma policy de escrita para a sessão", () => {
    expect(
      sql(`
        select count(*) from pg_policies
         where schemaname = 'public' and tablename = 'pagamento_recebimentos' and cmd <> 'SELECT';
      `),
    ).toBe("0");
  });
});
