// @vitest-environment node
/**
 * #3479 — A CONVERSA QUE O CADASTRO ABRE NASCE DE QUEM CADASTROU.
 *
 * ─── O defeito, do lado do cadastro ────────────────────────────────────────
 *
 * `abrirConversaDoContatoNovo` (lib/contacts/conversa-ao-criar.ts) manda o
 * `fn_service_begin` criar a conversa do contato novo. Essa RPC INSERTA com
 * `assigned_to_user_id` NULO. Em `visibility_mode = 'own'`,
 * `fn_can_view_conversation(org, null)` responde "não vejo" (0035), então a
 * conversa que o próprio Atendente acabou de criar não aparece para ele: o
 * Inbox fica vazio, o ícone dos Contatos "pisca", e o diálogo traduz o 409 em
 * "está com outro atendente" — sobre uma conversa de ninguém.
 *
 * O fluxo de ABRIR já dá dono (`open-with-contact` → claim). O de CRIAR não
 * dava, e é a assimetria que esta issue mede: o negócio criado pelo "Novo
 * Lead" nasce do Atendente (#2547); a conversa criada junto com o contato
 * nascia de ninguém.
 *
 * ─── O que se prova aqui, e o que NÃO se prova ─────────────────────────────
 *
 * Aqui se prova a DECISÃO e o EFEITO do lado da rota: quem vira dono, quem
 * nunca vira, e o que acontece quando a conversa já tinha dono. A visibilidade
 * em si é do banco e já é vigiada onde ela mora
 * (`tests/invariants/assumir-conversa-livre-no-modo-own.test.ts`,
 * `tests/invariants/gov-5-visibility-scope.test.ts`) — um dublê não deve fingir
 * que prova RLS.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mantido = vi.hoisted(() => ({
  db: null as unknown as SupabaseClient,
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mantido.db }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mantido.db }));

import type { Actor, HandlerCtx } from "@/lib/api/handlers/types";

import { createContactHandler } from "./_handler";

const ORG = "c0d00000-0000-4000-8000-000000000001";
const OUTRA_ORG = "c0d00000-0000-4000-8000-000000000002";
const ATENDENTE = "c0d00000-1111-4000-8000-000000000001";
const COLEGA = "c0d00000-1111-4000-8000-000000000002";
const GERENTE = "c0d00000-1111-4000-8000-000000000003";
const CONTATO = "c0d00000-3333-4000-8000-000000000001";
const CONVERSA = "c0d00000-4444-4000-8000-000000000001";
const SESSAO = "c0d00000-2222-4000-8000-000000000001";

type Rpc = { nome: string; args: Record<string, unknown> };

type Cenario = {
  /** `organizations.settings.visibility_mode` da organização do contexto. */
  modo?: string | null;
  /** O INSERT de contato falha com este erro (contato já existente, etc.). */
  erroDoInsert?: { code: string; message: string; details?: string; constraint?: string };
  /** A RPC do claim devolve zero linhas = a conversa já tinha dono. */
  conversaJaTinhaDono?: boolean;
  /** A RPC do claim falha (rede, permissão). */
  erroDoClaim?: { message: string };
};

function bancoDeMentira(cenario: Cenario = {}) {
  const rpcs: Rpc[] = [];
  const leituras: Array<{ tabela: string; filtros: Array<[string, unknown]> }> = [];

  const CONTATO_GRAVADO = {
    id: CONTATO,
    organization_id: ORG,
    name: "Cliente Novo",
    display_name: null,
    is_group: false,
    is_personal: false,
    phone_number: "5532999990000",
    email: null,
    cpf_hash: null,
    created_at: "2026-11-05T00:00:00Z",
    updated_at: "2026-11-05T00:00:00Z",
  };

  /**
   * `lista` é como o PostgREST responde a um `select` sem `single()` — o que a
   * RELEITURA por telefone do 23505 usa. Devolver o objeto solto ali fazia o
   * dublê explodir em `candidatos.filter`, e o 409 nunca era medido.
   */
  const resultado = (
    tabela: string,
    filtros: Array<[string, unknown]>,
    op: string,
    forma: "single" | "lista",
  ) => {
    if (tabela === "channel_sessions") {
      return {
        data: [
          {
            id: SESSAO,
            organization_id: ORG,
            provider: "whatsapp",
            status: "WORKING",
            archived_at: null,
            created_at: "2026-01-01T00:00:00Z",
            metadata: {},
          },
        ],
        error: null,
      };
    }
    if (tabela === "organizations") {
      return { data: { settings: { visibility_mode: cenario.modo ?? "own" } }, error: null };
    }
    if (tabela === "contacts") {
      // O INSERT é o único que falha; a RELEITURA por telefone é o que
      // transforma o 23505 no 409 `contact_exists`.
      if (op === "insert" && cenario.erroDoInsert) return { data: null, error: cenario.erroDoInsert };
      return { data: forma === "lista" ? [CONTATO_GRAVADO] : CONTATO_GRAVADO, error: null };
    }
    return { data: [], error: null };
  };

  const cadeia = (tabela: string, filtros: Array<[string, unknown]>) => {
    let op = "select";
    const elo = {
      select: () => elo,
      insert: () => {
        op = "insert";
        return elo;
      },
      update: () => elo,
      upsert: () => elo,
      delete: () => elo,
      eq: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return elo;
      },
      in: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return elo;
      },
      is: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return elo;
      },
      or: () => elo,
      not: () => elo,
      order: () => elo,
      limit: () => elo,
      single: () => Promise.resolve(resultado(tabela, filtros, op, "single")),
      maybeSingle: () => Promise.resolve(resultado(tabela, filtros, op, "single")),
      then: (ok: (r: unknown) => unknown) =>
        Promise.resolve(resultado(tabela, filtros, op, "lista")).then(ok),
    };
    return elo;
  };

  const db = {
    from: (tabela: string) => {
      const filtros: Array<[string, unknown]> = [];
      leituras.push({ tabela, filtros });
      return cadeia(tabela, filtros);
    },
    rpc: async (nome: string, args: Record<string, unknown> = {}) => {
      rpcs.push({ nome, args });
      if (nome === "fn_service_begin") {
        return {
          data: {
            organization_id: ORG,
            contact_id: CONTATO,
            conversation_id: CONVERSA,
            service_revision: 1,
            demanda_id: null,
            demanda_revision: null,
            status: "open",
            demanda_fechada_em: null,
          },
          error: null,
        };
      }
      if (nome === "fn_conversation_assign") {
        if (cenario.erroDoClaim) return { data: null, error: cenario.erroDoClaim };
        if (cenario.conversaJaTinhaDono) return { data: [], error: null };
        return {
          data: [
            {
              id: CONVERSA,
              organization_id: ORG,
              contact_id: CONTATO,
              assigned_to_user_id: args.p_to_user_id,
              status: "claimed",
            },
          ],
          error: null,
        };
      }
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;

  return { db, rpcs, leituras };
}

function contexto(actor: Actor, organizationId = ORG): HandlerCtx {
  return { organization_id: organizationId, actor, requestId: "req-3479" } as HandlerCtx;
}

const entrada = {
  name: "Cliente Novo",
  phone_number: "32999990000",
  source: "manual",
} as Parameters<typeof createContactHandler>[2];

const atendente: Actor = { type: "user", id: ATENDENTE, role: "agent" };
const gerente: Actor = { type: "user", id: GERENTE, role: "manager" };

function claimDoBanco(rpcs: Rpc[]): Rpc | undefined {
  return rpcs.find((r) => r.nome === "fn_conversation_assign");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cadastro de contato no modo 'Só os seus' — a conversa nasce do Atendente", () => {
  it("⭐ Atendente cadastra contato com telefone: a conversa fica com ele, com CAS de 'só se estiver livre'", async () => {
    const banco = bancoDeMentira({ modo: "own" });
    mantido.db = banco.db;

    const saida = await createContactHandler(banco.db, contexto(atendente), entrada);

    expect(saida.action).toBe("created");
    const claim = claimDoBanco(banco.rpcs);
    expect(claim).toBeDefined();
    expect(claim!.args).toMatchObject({
      p_organization_id: ORG,
      p_conversation_id: CONVERSA,
      p_to_user_id: ATENDENTE,
      p_reason: "claim",
      p_enforce_expected: true,
    });
    // AUSENTE é o contrato de "assuma se estiver livre": com dono, o CAS devolve
    // zero linhas e ninguém perde atendimento.
    expect(claim!.args.p_expected_assignee).toBeUndefined();
  });

  it("o dono é SEMPRE quem cadastrou — nunca um colega, mesmo quando outro id aparece no cenário", async () => {
    const banco = bancoDeMentira({ modo: "own" });
    mantido.db = banco.db;

    await createContactHandler(banco.db, contexto(atendente), entrada);

    const ids = banco.rpcs
      .filter((r) => r.nome === "fn_conversation_assign")
      .map((r) => r.args.p_to_user_id);
    expect(ids).toEqual([ATENDENTE]);
    expect(ids).not.toContain(COLEGA);
  });

  it("lado oposto (b): gerente/admin criam como sempre — nenhum claim, nenhuma leitura de modo", async () => {
    const banco = bancoDeMentira({ modo: "own" });
    mantido.db = banco.db;

    await createContactHandler(banco.db, contexto(gerente), entrada);

    expect(claimDoBanco(banco.rpcs)).toBeUndefined();
    expect(banco.leituras.some((l) => l.tabela === "organizations")).toBe(false);
  });

  it("lado oposto (e): modo desligado (todos veem tudo) não ganha comportamento novo", async () => {
    for (const modo of ["all", "own_and_unassigned", "own_and_sector"]) {
      const banco = bancoDeMentira({ modo });
      mantido.db = banco.db;

      await createContactHandler(banco.db, contexto(atendente), entrada);

      expect(claimDoBanco(banco.rpcs), `modo ${modo}`).toBeUndefined();
    }
  });

  it("lado oposto (c): conversa que já tinha dono não muda de dono — zero linhas é no-op", async () => {
    const banco = bancoDeMentira({ modo: "own", conversaJaTinhaDono: true });
    mantido.db = banco.db;

    const saida = await createContactHandler(banco.db, contexto(atendente), entrada);

    expect(saida.action).toBe("created");
    // Tentou assumir (é o caminho normal), mas não seguiu com efeitos de dono:
    // sem evento de "claimed" e sem atividade na linha do tempo.
    expect(
      banco.rpcs.filter(
        (r) => r.nome === "emit_event" && r.args.p_event_type === "conversation.claimed",
      ),
    ).toEqual([]);
  });

  it("lado oposto (d): contato que já existe recusa com 409 antes de criar conversa ou dono", async () => {
    const banco = bancoDeMentira({
      modo: "own",
      erroDoInsert: { code: "23505", message: "duplicate key value violates unique constraint" },
    });
    mantido.db = banco.db;

    await expect(createContactHandler(banco.db, contexto(atendente), entrada)).rejects.toMatchObject({
      status: 409,
    });

    expect(banco.rpcs.some((r) => r.nome === "fn_service_begin")).toBe(false);
    expect(claimDoBanco(banco.rpcs)).toBeUndefined();
  });

  it("falha do claim não derruba o cadastro: o contato já está gravado", async () => {
    const banco = bancoDeMentira({
      modo: "own",
      erroDoClaim: { message: "could not serialize access" },
    });
    mantido.db = banco.db;

    const saida = await createContactHandler(banco.db, contexto(atendente), entrada);

    expect(saida.action).toBe("created");
  });

  it("token de servidor / agente de IA não é 'quem atendeu': nenhuma leitura, nenhum claim", async () => {
    for (const actor of [
      { type: "api_token", id: "tok-1" } as Actor,
      { type: "ai_agent", id: "run-1", role: "agent" } as Actor,
    ]) {
      const banco = bancoDeMentira({ modo: "own" });
      mantido.db = banco.db;

      await createContactHandler(banco.db, contexto(actor), entrada);

      expect(claimDoBanco(banco.rpcs)).toBeUndefined();
      expect(banco.leituras.some((l) => l.tabela === "organizations")).toBe(false);
    }
  });

  it("lado oposto (f): o modo é lido da organização do CONTEXTO, nunca de outra", async () => {
    const banco = bancoDeMentira({ modo: "own" });
    mantido.db = banco.db;

    await createContactHandler(banco.db, contexto(atendente, OUTRA_ORG), entrada);

    const leitura = banco.leituras.find((l) => l.tabela === "organizations");
    expect(leitura?.filtros).toContainEqual(["id", OUTRA_ORG]);
    expect(banco.rpcs.find((r) => r.nome === "fn_conversation_assign")?.args).toMatchObject({
      p_organization_id: OUTRA_ORG,
    });
  });
});
