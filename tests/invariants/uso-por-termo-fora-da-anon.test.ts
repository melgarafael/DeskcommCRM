import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * A LEITURA POR TERMO (#484) NÃO É ALCANÇÁVEL PELA ANON KEY.
 *
 * `fn_agent_tool_usage_por_termo` é `security invoker`, e a VARREDURA anon do
 * baseline (0116) só percorre `security definer`: sem o `revoke ... from public,
 * anon` escrito no próprio bloco, a função ficaria com EXECUTE para `anon` por
 * DUAS origens (o grant a PUBLIC da criação e o default ACL do corpo do
 * baseline), e o PostgREST a exporia como RPC à chave que vai para o browser.
 * `hardening-definer-varredura` não a enxerga, por ser invoker — por isso a
 * medição mora aqui.
 */
const FN = "public.fn_agent_tool_usage_por_termo(uuid,uuid,timestamptz)";

describe("fn_agent_tool_usage_por_termo × anon (doutrina 9)", () => {
  it("anon NÃO executa; authenticated e service_role executam", () => {
    expect(sql(`select has_function_privilege('anon', '${FN}', 'EXECUTE');`)).toBe("f");
    expect(sql(`select has_function_privilege('authenticated', '${FN}', 'EXECUTE');`)).toBe("t");
    expect(sql(`select has_function_privilege('service_role', '${FN}', 'EXECUTE');`)).toBe("t");
  });

  it("nenhum grant a PUBLIC sobrou no ACL da função", () => {
    // `=X/` no aclitem é o grant a PUBLIC; `revoke from anon` não o remove.
    const acl = sql(
      `select coalesce(proacl::text, '') from pg_proc where oid = '${FN}'::regprocedure;`,
    );
    expect(acl).not.toMatch(/(^|[{,])=X/);
  });
});
