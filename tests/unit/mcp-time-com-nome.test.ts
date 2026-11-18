/**
 * `crm_list_team_members` devolvendo NOME junto do user_id (issue #1539).
 *
 * O problema da issue era literal: a IA só via UUID, e nenhuma tela mostra UUID
 * — então escrever "manda para a Ana" no prompt era impossível sem inventar
 * identidade. O contrato que este arquivo prende tem DUAS pontas:
 *
 *   1. `nome` EXISTE e vem do `user_metadata.full_name` (o mesmo mínimo LGPD
 *      de `team/assignable` e de `nomesDosAtendentesCom`).
 *   2. `email` NÃO existe: o que sai daqui entra no contexto de um modelo, e a
 *      identidade pessoal de cada um não participa de nenhuma decisão de
 *      encaminhamento — esta é a régua escrita na própria tool.
 *
 * Sem isto, a garantia é só silêncio: `nomesDosAtendentesCom` engole a falha de
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

/**
 * Dublê do PostgREST: o caminho real é `from().select().eq().is().order()`; o
 * vínculo que libera o nome (`.eq().in()` em `user_organizations`) lê as mesmas linhas.
 */
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
    in: () => chain,
    order: () => chain,
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: linhas, error: null }).then(res),
  };
  return {
    from: () => chain,
    // O nome vem de UMA consulta a `fn_nomes_dos_membros` (#4326, fatia 3) —
    // zero chamadas HTTP ao GoTrue. Devolve `{ data, error }` como o
    // supabase-js: falha é par, não exceção.
    rpc: (
      funcao: string,
      args: { p_org: string; p_ids: string[] },
    ): Promise<{ data: unknown; error: unknown }> => {
      if (funcao !== "fn_nomes_dos_membros") {
        return Promise.resolve({ data: null, error: { message: "rpc inesperado" } });
      }
      return Promise.resolve({
        data: args.p_ids.map((id) => ({ user_id: id, full_name: NOME_ESPERADO, email: null })),
        error: null,
      });
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
    // A leitura de nomes falha (org sem vínculo, função sem EXECUTE, banco fora):
    // o campo cai no null declarado e a tool não quebra.
    supabase.rpc = () =>
      Promise.resolve({ data: null, error: { message: "permission denied for function" } });

    const res = (await crmListTeamMembers.handler({}, fazerCtx(supabase))) as {
      time: LinhaDoTime[];
    };

    expect(res.time[0]?.user_id).toBe(MEMBRO);
    expect(res.time[0]?.nome).toBeNull();
  });
});
