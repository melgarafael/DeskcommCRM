import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NextRequest } from "next/server";

import { POST } from "@/app/api/v1/conversations/[id]/notes/route";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * A NOTA COM MENÇÃO ESTRUTURAL AVISA A PESSOA ESCOLHIDA, E SÓ ELA (#2372).
 *
 * ## Por que a asserção é `to_user_id`, e não "o rpc foi chamado"
 *
 * O caminho textual legado (`@Ana`) casa pelo primeiro nome: com duas Anas na
 * organização ele emite DOIS eventos, um para cada. Contar chamadas de
 * `emit_event` passaria no defeito. O que se mede é o id DENTRO do payload —
 * e o do colega, que não foi clicado, tem de estar ausente.
 *
 * ## Por que isto é VERMELHO sem a mudança
 *
 * O corpo abaixo é o que o autocompletar grava. Antes da #2372 a rota olhava
 * `tokensDeMencao(body)` para decidir se valia a pena sequer consultar a
 * tabela de membros — e num corpo `@[Ana Lima](mencao:…)` não existe UM token
 * `@algo` (o `@` é seguido de `[`). Resultado: saía sem emitir nada, sem erro
 * nenhum, sem notificação nenhuma — o silêncio mais caro que existe.
 *
 * O terceiro caso é o de controle, e ele fica verde antes e depois: nota
 * escrita à mão continua notificando pelo caminho textual de sempre.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG = "org-0001";
const CONVERSA = "conv-0001";
const AUTOR = "autor-0001";
const ANA_LIMA = "ana-lima-0001";
const ANA_SOUZA = "ana-souza-0002";
const CARLOS = "carlos-0003";

const MEMBROS: Record<string, { email: string; full_name: string }> = {
  [AUTOR]: { email: "autor@clinica.com", full_name: "Autor da Nota" },
  [ANA_LIMA]: { email: "ana.lima@clinica.com", full_name: "Ana Lima" },
  [ANA_SOUZA]: { email: "souza@clinica.com", full_name: "Ana Souza" },
  [CARLOS]: { email: "carlos@clinica.com", full_name: "Carlos Dias" },
};

interface Emissao {
  nome: string;
  args: Record<string, unknown>;
}

let emissões: Emissao[];
let idasAoAuth: string[];

/** Cliente falso que APPLICA o mínimo que a rota usa: conversa existe, nota insere. */
function clientFalso() {
  return {
    from(tabela: string) {
      if (tabela === "conversations") {
        const cadeia = {
          select: () => cadeia,
          eq: () => cadeia,
          maybeSingle: async () => ({ data: { id: CONVERSA }, error: null }),
        };
        return cadeia;
      }
      if (tabela === "conversation_notes") {
        const cadeia = {
          insert: () => cadeia,
          select: () => cadeia,
          single: async () => ({ data: { id: "nota-0001", conversation_id: CONVERSA }, error: null }),
        };
        return cadeia;
      }
      throw new Error(`[teste] tabela inesperada na rota de notas: ${tabela}`);
    },
  };
}

/** O admin: membership da org, auth por id e o `rpc` que é o que se mede. */
function adminFalso() {
  return {
    from(tabela: string) {
      if (tabela !== "user_organizations") {
        throw new Error(`[teste] tabela inesperada no admin: ${tabela}`);
      }
      const cadeia = {
        select: () => cadeia,
        eq: () => cadeia,
        is: async () => ({ data: Object.keys(MEMBROS).map((user_id) => ({ user_id })), error: null }),
      };
      return cadeia;
    },
    auth: {
      admin: {
        getUserById: async (id: string) => {
          idasAoAuth.push(id);
          const u = MEMBROS[id];
          return {
            data: {
              user: { id, email: u?.email ?? null, user_metadata: { full_name: u?.full_name ?? null } },
            },
          };
        },
      },
    },
    rpc: async (nome: string, args: Record<string, unknown>) => {
      emissões.push({ nome, args });
      return { data: null, error: null };
    },
  };
}

async function criarNota(body: string): Promise<Response> {
  const req = new Request("http://localhost/api/v1/conversations/conv-0001/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  return POST(req as unknown as NextRequest, { params: Promise.resolve({ id: CONVERSA }) });
}

const alvos = () =>
  emissões.map((e) => (e.args.p_payload as { to_user_id: string }).to_user_id).sort();

beforeEach(() => {
  vi.clearAllMocks();
  emissões = [];
  idasAoAuth = [];
  vi.mocked(requireSupportWrite).mockResolvedValue(null as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG, role: "agent", name: "Clínica" },
    user: { id: AUTOR, idioma: "pt-BR", full_name: "Autor da Nota" },
  } as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(createClient).mockResolvedValue(clientFalso() as never);
  vi.mocked(createAdminClient).mockReturnValue(adminFalso() as never);
});

describe("POST /notes — menção de atendente (#2372)", () => {
  it("corpo estrutural → emite para o id ESCOLHIDO, nunca para a colega de mesmo nome", async () => {
    const resposta = await criarNota(`Fala com @[Ana Lima](mencao:${ANA_LIMA}) sobre o orçamento.`);

    expect(resposta.status).toBe(201);
    expect(emissões.map((e) => e.nome)).toEqual(["emit_event"]);
    expect(alvos()).toEqual([ANA_LIMA]);
    expect(alvos()).not.toContain(ANA_SOUZA);
    // E a ida ao auth some neste caminho: o id está no corpo, não há o que
    // perguntar sobre nome ou e-mail de ninguém.
    expect(idasAoAuth).toEqual([]);
  });

  it("o preview do aviso sai LEGÍVEL: `@Ana Lima`, sem resto de token", async () => {
    await criarNota(`Fala com @[Ana Lima](mencao:${ANA_LIMA}) sobre o orçamento.`);

    const payload = emissões[0]!.args.p_payload as { body_preview: string; conversation_id: string };
    expect(payload.body_preview).toBe("Fala com @Ana Lima sobre o orçamento.");
    expect(payload.body_preview).not.toContain("mencao:");
    expect(payload.conversation_id).toBe(CONVERSA);
  });

  it("nota escrita à mão continua notificando pelo caminho textual de sempre", async () => {
    await criarNota("fala com @carlos sobre o orçamento");

    expect(alvos()).toEqual([CARLOS]);
    // caminho legado: vai ao auth de cada membro da org para comparar nome/e-mail
    expect(idasAoAuth).toEqual([ANA_LIMA, ANA_SOUZA, CARLOS]);
  });

  it("id de FORA da empresa no token não gera aviso nem ida ao auth", async () => {
    // O token é texto que o cliente manda: nada impede alguém de escrever à
    // mão o id de um usuário de outra organização. Só quem está na membership
    // da org da sessão pode ser avisado.
    const resposta = await criarNota("olha isso @[Intrusa](mencao:outra-org-0009)");

    expect(resposta.status).toBe(201);
    expect(emissões).toEqual([]);
    expect(idasAoAuth).toEqual([]);
  });

  it("quem escreve a nota não avisa a si mesmo pelo token", async () => {
    await criarNota(`lembrete para @[Autor](mencao:${AUTOR})`);
    expect(emissões).toEqual([]);
  });

  it("sem menção nenhuma, não emite nada", async () => {
    await criarNota("cliente ligou reclamando");
    expect(emissões).toEqual([]);
  });
});
