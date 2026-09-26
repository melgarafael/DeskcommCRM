import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  consumirRascunho,
  criarRascunho,
  ehUuid,
  JANELA_PADRAO_HORAS,
  lerRascunho,
  TEXTO_MAXIMO,
  urlDoRascunho,
} from "@/lib/inbox/rascunho-sugerido";

/**
 * O RASCUNHO SUGERIDO POR INTEGRAÇÃO (issue #1611) — as regras, com um banco
 * de mentira que MODELA O PREDICADO.
 *
 * O dublê devolve a linha SE (e só se) os filtros casarem com ela. É o que
 * torna contável a sabotagem: se `criarRascunho` deixar de filtrar por
 * `organization_id`, a conversa do vizinho casa e o caso cross-tenant fica
 * vermelho — não é um mock que devolve o que o teste quer ouvir.
 *
 * Medido: 16 casos. Sabotagem prevista (2 vermelhos): tirar o `.eq(
 * "organization_id")` da conferência da conversa derruba "não cria rascunho em
 * conversa de outra organização"; tirar o `.is("consumed_at", null)` do consumo
 * derruba "segundo clique não conta dois usos".
 */

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";
const CONV_A = "aaaaaaaa-1111-4000-8000-000000000001";
const CONV_B = "bbbbbbbb-1111-4000-8000-000000000002";
const DRAFT = "aaaaaaaa-2222-4000-8000-000000000001";
const USER = "aaaaaaaa-3333-4000-8000-000000000003";

type Linha = Record<string, unknown>;

interface Filtro {
  coluna: string;
  /** `valor` direto, ou `{ is }` / `{ gt }` para os guardas do UPDATE. */
  valor: unknown;
}

function casa(linha: Linha, filtros: Filtro[]): boolean {
  return filtros.every((f) => {
    const atual = linha[f.coluna];
    if (f.valor && typeof f.valor === "object" && "is" in (f.valor as object)) {
      return atual === (f.valor as { is: unknown }).is;
    }
    if (f.valor && typeof f.valor === "object" && "gt" in (f.valor as object)) {
      const limite = new Date((f.valor as { gt: string }).gt).getTime();
      return new Date(String(atual)).getTime() > limite;
    }
    return atual === f.valor;
  });
}

/** Dublê: mesma cadeia, mesmo predicado, nenhuma resposta inventada. */
function bancoFake(drafts: Linha[], conversas: Linha[]) {
  const consultas: Array<{ tabela: string; filtros: Filtro[] }> = [];

  function builder(tabela: string) {
    const filtros: Filtro[] = [];
    let inserts: Linha | null = null;
    let updates: Linha | null = null;
    const linhas = () => (tabela === "conversation_drafts" ? drafts : conversas);

    const q = {
      select: () => q,
      insert: (v: Linha) => {
        inserts = v;
        return q;
      },
      update: (v: Linha) => {
        updates = v;
        return q;
      },
      eq: (coluna: string, valor: unknown) => {
        filtros.push({ coluna, valor });
        return q;
      },
      is: (coluna: string, valor: unknown) => {
        filtros.push({ coluna, valor: { is: valor } });
        return q;
      },
      gt: (coluna: string, valor: unknown) => {
        filtros.push({ coluna, valor: { gt: valor } });
        return q;
      },
      maybeSingle: async () => {
        consultas.push({ tabela, filtros: [...filtros] });
        if (inserts) {
          const nova = { id: `00000000-0000-4000-8000-0000000000${drafts.length + 10}`, ...inserts };
          drafts.push(nova);
          return { data: { id: nova.id }, error: null };
        }
        const alvo = linhas().find((l) => casa(l, filtros)) ?? null;
        if (updates) {
          if (!alvo) return { data: null, error: null };
          Object.assign(alvo, updates);
          return { data: { id: alvo.id }, error: null };
        }
        return { data: alvo, error: null };
      },
    };
    return q;
  }

  return { cliente: { from: builder } as unknown as SupabaseClient, consultas };
}

const conversaA: Linha = { id: CONV_A, organization_id: ORG_A };
const conversaB: Linha = { id: CONV_B, organization_id: ORG_B };

function rascunho(overrides: Partial<Linha> = {}): Linha {
  return {
    id: DRAFT,
    organization_id: ORG_A,
    conversation_id: CONV_A,
    body: "Sua cobrança venceu hoje.",
    source: "erp",
    consumed_at: null,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

describe("criarRascunho — a porta da integração", () => {
  it("cria o rascunho e devolve a URL com os DOIS parâmetros", async () => {
    const drafts: Linha[] = [];
    const { cliente } = bancoFake(drafts, [conversaA]);

    const r = await criarRascunho(cliente, {
      organizationId: ORG_A,
      conversationId: CONV_A,
      texto: "  Sua cobrança venceu hoje.  ",
      origem: "erp",
      apiTokenId: "token-1",
    });

    expect(r).toEqual({ ok: true, draftId: "00000000-0000-4000-8000-000000000010", url: urlDoRascunho(CONV_A, "00000000-0000-4000-8000-000000000010") });
    expect(urlDoRascunho(CONV_A, DRAFT)).toBe(`/app/inbox?id=${CONV_A}&rascunho=${DRAFT}`);
    // O texto vai SEM espaço de sobra (trim) e com a origem do ERP.
    expect(drafts[0]).toMatchObject({
      organization_id: ORG_A,
      conversation_id: CONV_A,
      body: "Sua cobrança venceu hoje.",
      source: "erp",
      created_by_api_token_id: "token-1",
    });
    // A criação NUNCA toca em consumo: a coluna nasce vazia no banco (default),
    // e o payload do INSERT não a nomeia — é o que impede "criado" virar
    // "já usado" por acidente.
    expect(drafts[0]).not.toHaveProperty("consumed_at");
    expect(drafts[0]).not.toHaveProperty("consumed_by_user_id");
  });

  it("janela padrão de 24h, contando da criação", async () => {
    const drafts: Linha[] = [];
    const { cliente } = bancoFake(drafts, [conversaA]);
    const antes = Date.now();

    await criarRascunho(cliente, {
      organizationId: ORG_A,
      conversationId: CONV_A,
      texto: "oi",
      origem: "erp",
    });

    const expira = new Date(String(drafts[0]!.expires_at)).getTime();
    expect(JANELA_PADRAO_HORAS).toBe(24);
    expect(expira).toBeGreaterThanOrEqual(antes + 24 * 3_600_000 - 5_000);
    expect(expira).toBeLessThanOrEqual(antes + 24 * 3_600_000 + 5_000);
  });

  it("NÃO cria rascunho em conversa de outra organização (critério da issue)", async () => {
    const drafts: Linha[] = [];
    // A conversa existe, mas é do VIZINHO: o filtro de organização é o que
    // impede o token de A escrever na casa de B.
    const { cliente } = bancoFake(drafts, [conversaB]);

    const r = await criarRascunho(cliente, {
      organizationId: ORG_A,
      conversationId: CONV_B,
      texto: "texto da integração",
      origem: "erp",
    });

    expect(r).toEqual({ ok: false, motivo: "conversa_nao_encontrada" });
    expect(drafts).toHaveLength(0);
  });

  it("recusa texto vazio, acima do teto e origem vazia SEM tocar o banco", async () => {
    const drafts: Linha[] = [];
    const { cliente, consultas } = bancoFake(drafts, [conversaA]);
    const base = { organizationId: ORG_A, conversationId: CONV_A, origem: "erp" };

    expect(await criarRascunho(cliente, { ...base, texto: "   " })).toEqual({
      ok: false,
      motivo: "texto_invalido",
    });
    expect(await criarRascunho(cliente, { ...base, texto: "x".repeat(TEXTO_MAXIMO + 1) })).toEqual({
      ok: false,
      motivo: "texto_invalido",
    });
    expect(
      await criarRascunho(cliente, {
        organizationId: ORG_A,
        conversationId: CONV_A,
        texto: "oi",
        origem: "   ",
      }),
    ).toEqual({ ok: false, motivo: "origem_invalida" });

    expect(consultas).toHaveLength(0);
    expect(drafts).toHaveLength(0);
    expect(TEXTO_MAXIMO).toBe(4096);
  });
});

describe("lerRascunho — o que a caixa de entrada mostra", () => {
  const ler = (drafts: Linha[], conversationId = CONV_A, draftId = DRAFT) =>
    lerRascunho(bancoFake(drafts, [conversaA]).cliente, {
      organizationId: ORG_A,
      conversationId,
      draftId,
    });

  it("rascunho válido vira sugestão com texto e origem", async () => {
    const leitura = await ler([rascunho()]);
    expect(leitura).toEqual({
      estado: "sugerido",
      draftId: DRAFT,
      conversationId: CONV_A,
      texto: "Sua cobrança venceu hoje.",
      origem: "erp",
    });
  });

  it("de OUTRA conversa: recusa, mesmo pertencendo à mesma organização", async () => {
    expect(await ler([rascunho()], CONV_B)).toEqual({
      estado: "indisponivel",
      motivo: "outra_conversa",
    });
  });

  it("já usado: recusa", async () => {
    expect(await ler([rascunho({ consumed_at: new Date().toISOString() })])).toEqual({
      estado: "indisponivel",
      motivo: "usado",
    });
  });

  it("vencido: recusa", async () => {
    expect(
      await ler([rascunho({ expires_at: new Date(Date.now() - 1_000).toISOString() })]),
    ).toEqual({ estado: "indisponivel", motivo: "expirado" });
  });

  it("id inexistente na organização: não encontrado", async () => {
    expect(await ler([])).toEqual({ estado: "indisponivel", motivo: "nao_encontrado" });
  });

  it("rascunho de OUTRA organização também vira não encontrado (RLS + filtro)", async () => {
    // A linha existe, mas o `organization_id` não casa com o de quem lê.
    const deOutraOrg = [rascunho({ organization_id: ORG_B })];
    const { cliente } = bancoFake(deOutraOrg, [conversaA]);
    const leitura = await lerRascunho(cliente, {
      organizationId: ORG_A,
      conversationId: CONV_A,
      draftId: DRAFT,
    });
    expect(leitura).toEqual({ estado: "indisponivel", motivo: "nao_encontrado" });
  });

  it("UUID malformado nem chega ao banco", async () => {
    const { cliente, consultas } = bancoFake([rascunho()], [conversaA]);
    const leitura = await lerRascunho(cliente, {
      organizationId: ORG_A,
      conversationId: "conv-nao-uuid",
      draftId: "'; drop table conversation_drafts; --",
    });
    expect(leitura).toEqual({ estado: "indisponivel", motivo: "nao_encontrado" });
    expect(consultas).toHaveLength(0);
    expect(ehUuid(DRAFT)).toBe(true);
    expect(ehUuid("abc")).toBe(false);
  });
});

describe("consumirRascunho — o clique de quem atende", () => {
  it("marca como usado, com quem usou, e só na conversa certa", async () => {
    const drafts = [rascunho()];
    const { cliente } = bancoFake(drafts, [conversaA]);

    const consumido = await consumirRascunho(cliente, {
      organizationId: ORG_A,
      conversationId: CONV_A,
      draftId: DRAFT,
      userId: USER,
    });

    expect(consumido).toBe(true);
    expect(drafts[0]).toMatchObject({ consumed_by_user_id: USER });
    expect(drafts[0]!.consumed_at).not.toBeNull();
  });

  it("segundo clique não conta dois usos (guarda no próprio UPDATE)", async () => {
    const drafts = [rascunho({ consumed_at: new Date().toISOString() })];
    const antes = drafts[0]!.consumed_at;
    const { cliente } = bancoFake(drafts, [conversaA]);

    const consumido = await consumirRascunho(cliente, {
      organizationId: ORG_A,
      conversationId: CONV_A,
      draftId: DRAFT,
      userId: USER,
    });

    expect(consumido).toBe(false);
    expect(drafts[0]!.consumed_at).toBe(antes);
  });

  it("rascunho vencido não é consumido agora", async () => {
    const drafts = [rascunho({ expires_at: new Date(Date.now() - 1_000).toISOString() })];
    const { cliente } = bancoFake(drafts, [conversaA]);

    const consumido = await consumirRascunho(cliente, {
      organizationId: ORG_A,
      conversationId: CONV_A,
      draftId: DRAFT,
      userId: USER,
    });

    expect(consumido).toBe(false);
    expect(drafts[0]!.consumed_at).toBeNull();
  });

  it("não alcança rascunho de outra conversa nem de outra organização", async () => {
    const drafts = [rascunho()];
    const { cliente } = bancoFake(drafts, [conversaA]);

    expect(
      await consumirRascunho(cliente, {
        organizationId: ORG_A,
        conversationId: CONV_B,
        draftId: DRAFT,
        userId: USER,
      }),
    ).toBe(false);
    expect(
      await consumirRascunho(cliente, {
        organizationId: ORG_B,
        conversationId: CONV_A,
        draftId: DRAFT,
        userId: USER,
      }),
    ).toBe(false);
    expect(drafts[0]!.consumed_at).toBeNull();
  });
});
