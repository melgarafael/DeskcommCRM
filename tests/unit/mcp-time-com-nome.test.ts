/**
 * `crm_list_team_members` devolvendo NOME junto do user_id (issue #1539).
 *
 * O problema da issue era literal: a IA só via UUID, e nenhuma tela mostra UUID
 * — então escrever "manda para a Ana" no prompt era impossível sem inventar
 * identidade. O contrato que este arquivo prende tem DUAS pontas:
 *
 *   1. `nome` EXISTE e vem do `user_metadata.full_name` (o mesmo mínimo LGPD
 *      de `team/assignable` e de `resolveUserNames`).
 *   2. `email` NÃO existe: o que sai daqui entra no contexto de um modelo, e a
 *      identidade pessoal de cada um não participa de nenhuma decisão de
 *      encaminhamento — esta é a régua escrita na própria tool.
 *
 * Sem isto, a garantia é só silêncio: `resolveUserNames` engole a falha de
 * lookup e devolveria `null` para sempre sem ninguém notar.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { crmListTeamMembers } from "@/lib/mcp/tools/operacao";
import type { McpContext } from "@/lib/mcp/types";

const ORG = "22222222-2222-4222-8222-222222222222";
const MEMBRO = "11111111-1111-4111-8111-111111111111";
const NOME_ESPERADO = "Joana da Silva";

/** Dublê do PostgREST: o caminho real é `from().select().eq().is().order()`. */
function fazerSupabase() {
  const linhas = [
    {
      user_id: MEMBRO,
      role: "manager",
      accepted_at: "2026-01-01T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
    },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    order: () => chain,
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: linhas, error: null }).then(res),
  };
  return {
    from: () => chain,
    auth: {
      admin: {
        // `unknown` no retorno é de propósito: o caso `not_admin` (user null,
        // error preenchado) é parte do contrato medida em `nome-do-atendente.ts`
        // — o supabase-js NÃO lança, devolve o par `{ data, error }`.
        getUserById: (
          id: string,
        ): Promise<{ data: { user: unknown }; error: unknown }> =>
          Promise.resolve({
            data: { user: { id, user_metadata: { full_name: NOME_ESPERADO } } },
            error: null,
          }),
      },
    },
  };
}

function fazerCtx(supabase = fazerSupabase()): McpContext {
  return {
    organizationId: ORG,
    role: "agent",
    actor: { type: "ai_agent", id: "run_1", role: "agent", api_token_id: "tok" },
    apiTokenId: "tok",
    requestId: "req",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
  } as McpContext;
}

interface LinhaDoTime {
  user_id: string;
  nome: string | null;
  papel: string;
}

describe("crm_list_team_members", () => {
  it("cada membro vem com `nome`, para a regra citar gente e não UUID (#1539)", async () => {
    const res = (await crmListTeamMembers.handler({}, fazerCtx())) as { time: LinhaDoTime[] };

    expect(res.time).toHaveLength(1);
    expect(res.time[0]?.nome).toBe(NOME_ESPERADO);
    expect(res.time[0]?.user_id).toBe(MEMBRO);
    expect(res.time[0]?.papel).toBe("manager");
  });

  it("segue SEM e-mail: a identidade pessoal não entra no contexto do modelo", async () => {
    const res = (await crmListTeamMembers.handler({}, fazerCtx())) as { time: LinhaDoTime[] };

    for (const pessoa of res.time) {
      expect(Object.keys(pessoa)).not.toContain("email");
    }
    expect(JSON.stringify(res.time)).not.toContain("@");
  });

  it("lookup de nome que falha ⇒ `nome: null`, nunca a chamada inteira quebrando", async () => {
    const supabase = fazerSupabase();
    // O supabase-js NÃO lança no 403 `not_admin`: devolve `{ data: null, error }`
    // — é o ramo que o helper trata, e o campo tem de cair no null declarado.
    supabase.auth.admin.getUserById = () =>
      Promise.resolve({ data: { user: null }, error: { message: "not_admin" } });

    const res = (await crmListTeamMembers.handler({}, fazerCtx(supabase))) as {
      time: LinhaDoTime[];
    };

    expect(res.time[0]?.user_id).toBe(MEMBRO);
    expect(res.time[0]?.nome).toBeNull();
  });
});
