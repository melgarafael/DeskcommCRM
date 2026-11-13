import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * EDIÇÃO DIRETA DO CONTATO POR TOKEN (#4517, entrega 1).
 *
 * ─── O que estava quebrado ────────────────────────────────────────────────
 *
 * `PATCH /api/v1/contacts/{id}` só conhecia cookie (`requireRole`), e não havia
 * porta nenhuma de edição por token: a única forma de corrigir um nome por
 * integração era `crm_propose_contact_field`, que cria uma PROPOSTA e espera
 * alguém abrir o CRM. Correção simples (nome, e-mail, cidade) ficava parada.
 *
 * ─── O que esta entrega NÃO pode fazer ───────────────────────────────────
 *
 * Promover a proposta a escrita para todo mundo. O comportamento de hoje —
 * token sem o escopo próprio continua PROPOSTA — é critério de aceite, e é o
 * alvo da sabotagem nº 1 (anular `contacts:write` e ver este arquivo reprovar).
 *
 * Pelo MESMO handler da tela (`patchContactHandler`): se a regra de negócio
 * morasse num segundo lugar, a integração e a tela divergiriam na primeira
 * mudança de schema.
 */
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

vi.mock("@/app/api/v1/contacts/_handler", async () => {
  const real = await vi.importActual<typeof import("@/app/api/v1/contacts/_handler")>(
    "@/app/api/v1/contacts/_handler",
  );
  return { ...real, patchContactHandler: vi.fn() };
});

const { crmUpdateContact } = await import("@/lib/mcp/tools/contacts");
const { patchContactHandler: patchContactHandlerMock } = await import(
  "@/app/api/v1/contacts/_handler"
);
const { proporDadoDoContato } = await import("@/lib/contacts/proposta-de-dado");
const { ApiError } = await import("@/lib/api/types");
const { audit } = await import("@/lib/audit");

const ORG = "aaaaaaaa-4517-4000-8000-00000000000a";
const OUTRA_ORG = "bbbbbbbb-4517-4000-8000-00000000000b";
const TOKEN = "cccccccc-4517-4000-8000-00000000000c";
const CONTATO = "dddddddd-4517-4000-8000-00000000000d";

type Linha = Record<string, unknown>;

/**
 * As tabelas que este dublê tem de verdade — lista FECHADA de propósito.
 *
 * `Record<string, Linha[]>` fazia `tabelas.contacts` valer `Linha[] |
 * undefined` sob `noUncheckedIndexedAccess`, e o `pnpm typecheck` do CI
 * reprovava com TS18048 nas asserções. Declarar as chaves aqui é a asserção de
 * existência no ponto em que a fixture MONTA as tabelas: quem lê
 * `tabelas.contacts` recebe o array, e um nome fora da lista vira erro de tipo.
 */
type NomeDeTabela = "contacts" | "contact_field_proposals";

/**
 * Banco de duas tabelas em memória — o mínimo que a PROPOSTA real lê e grava.
 *
 * `proporDadoDoContato` é a função DE VERDADE (não um dublê): o desfecho que
 * este arquivo mede é "o token sem escopo continua produzindo uma proposta", e
 * trocar a função por um mock provaria só que a tool a chama — não que o
 * cadastro ficou intacto e a fila ganhou a linha.
 */
function banco(contatos: Linha[]) {
  const tabelas: Record<NomeDeTabela, Linha[]> = { contacts: contatos, contact_field_proposals: [] };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function consulta(tabela: NomeDeTabela, op: "select" | "insert", payload?: Linha): any {
    const filtros: [string, unknown][] = [];
    const linhas = tabelas[tabela] ?? [];
    const casam = () => linhas.filter((l) => filtros.every(([c, v]) => l[c] === v));

    const cadeia: Record<string, unknown> = {};
    for (const m of ["eq", "limit", "order"]) {
      cadeia[m] = (coluna: string, valor: unknown) => {
        if (m === "eq") filtros.push([coluna, valor]);
        return cadeia;
      };
    }
    cadeia.select = () => cadeia;
    cadeia.maybeSingle = async () => ({ data: casam()[0] ?? null, error: null });
    cadeia.single = async () => ({ data: casam()[0] ?? null, error: null });
    if (op === "insert") {
      cadeia.insert = (linha: Linha) => {
        linhas.push({ id: `proposta-${linhas.length + 1}`, ...linha });
        return cadeia;
      };
    }
    return cadeia;
  }

  const cliente = {
    from: (tabela: NomeDeTabela) => ({
      select: (colunas?: string) => consulta(tabela, "select").select(colunas),
      insert: (linha: Linha) => consulta(tabela, "insert").insert(linha),
    }),
  };

  return { cliente: cliente as never, tabelas };
}

const ctxDoToken = (tokenScopes: string[] | undefined) =>
  ({
    supabase: banco([]).cliente,
    organizationId: ORG,
    actor: { type: "api_token", id: TOKEN, role: "agent" },
    requestId: "req-4517",
    apiTokenId: TOKEN,
    ...(tokenScopes === undefined ? {} : { tokenScopes }),
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#4517 entrega 1 — com `contacts:write` a edição grava na hora", () => {
  it("token COM o escopo chama o MESMO handler da tela, com a organização do token", async () => {
    vi.mocked(patchContactHandlerMock).mockResolvedValue({ id: CONTATO, name: "Ana Silva" } as never);
    const ctx = ctxDoToken(["mcp:write", "contacts:write"]);

    const saida = await crmUpdateContact.handler(
      { contact_id: CONTATO, name: "Ana Silva", email: "ana@exemplo.com" },
      ctx,
    );

    expect(patchContactHandlerMock).toHaveBeenCalledTimes(1);
    const [, ctxDoHandler, idDoContato, campos] = vi.mocked(patchContactHandlerMock).mock.calls[0]!;
    expect(idDoContato).toBe(CONTATO);
    expect(ctxDoHandler).toMatchObject({ organization_id: ORG, apiTokenId: TOKEN });
    expect(campos).toMatchObject({ name: "Ana Silva", email: "ana@exemplo.com" });
    expect(saida).toMatchObject({ atualizado: true });
  });
});

describe("#4517 entrega 1 — SEM o escopo continua virando proposta", () => {
  it("token sem `contacts:write` NÃO grava: cria proposta e a ficha fica intacta", async () => {
    const { cliente, tabelas } = banco([
      { id: CONTATO, organization_id: ORG, name: "Ana", email: null, phone_number: null, birthdate: null, is_anonymized: false },
    ]);
    const ctx = { ...(ctxDoToken(["mcp:write"]) as object), supabase: cliente } as never;

    const saida = (await crmUpdateContact.handler({ contact_id: CONTATO, name: "Ana Silva" }, ctx)) as {
      atualizado?: boolean;
      propostas?: Array<{ campo: string; criada: boolean }>;
    };

    // O CADASTRO não mudou — é o comportamento de hoje, e o critério de aceite.
    expect(tabelas.contacts[0]?.name).toBe("Ana");
    expect(patchContactHandlerMock).not.toHaveBeenCalled();
    // E a informação não se perdeu: virou linha na fila de confirmação.
    expect(tabelas.contact_field_proposals).toHaveLength(1);
    expect(tabelas.contact_field_proposals[0]).toMatchObject({
      contact_id: CONTATO,
      campo: "name",
      valor_proposto: "Ana Silva",
    });
    expect(saida.atualizado).toBe(false);
    expect(saida.propostas?.[0]).toMatchObject({ campo: "name", criada: true });
  });

  it("o AGENTE DA CASA (`tokenScopes` ausente) também propõe — ele não ganha a escrita direta", async () => {
    const { cliente, tabelas } = banco([
      { id: CONTATO, organization_id: ORG, name: "Ana", email: null, phone_number: null, birthdate: null, is_anonymized: false },
    ]);
    const ctx = { ...(ctxDoToken(undefined) as object), supabase: cliente } as never;

    await crmUpdateContact.handler({ contact_id: CONTATO, name: "Ana Silva" }, ctx);

    expect(patchContactHandlerMock).not.toHaveBeenCalled();
    expect(tabelas.contacts[0]?.name).toBe("Ana");
    expect(tabelas.contact_field_proposals).toHaveLength(1);
  });
});

describe("#4517 entrega 1 — isolamento por organização", () => {
  it("contato de OUTRA organização não é encontrado: 404 antes de qualquer escrita", async () => {
    // Handler REAL, com um banco que só tem a linha da outra casa. O filtro
    // `organization_id` é a única barreira: pelo MCP o client é service-role.
    const { patchContactHandler } = await vi.importActual<
      typeof import("@/app/api/v1/contacts/_handler")
    >("@/app/api/v1/contacts/_handler");
    const { cliente, tabelas } = banco([
      { id: CONTATO, organization_id: OUTRA_ORG, name: "De outra casa", is_anonymized: false },
    ]);

    const erro = await patchContactHandler(
      cliente as never,
      { organization_id: ORG, actor: { type: "api_token", id: TOKEN }, requestId: "req-4517", apiTokenId: TOKEN } as never,
      CONTATO,
      { name: "sequestrado" },
    ).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as InstanceType<typeof ApiError>).status).toBe(404);
    expect(tabelas.contacts[0]?.name).toBe("De outra casa");
  });

  it("o audit da edição por token leva a LINHA DO TOKEN (qual token agiu)", async () => {
    const { patchContactHandler } = await vi.importActual<
      typeof import("@/app/api/v1/contacts/_handler")
    >("@/app/api/v1/contacts/_handler");
    const contato = {
      id: CONTATO,
      organization_id: ORG,
      name: "Ana",
      email: null,
      phone_number: null,
      display_name: null,
      consent: {},
      custom_fields: {},
      tags: [],
      is_anonymized: false,
    };
    const linhas: Linha[] = [contato];
    const consultas: Array<[string, unknown]> = [];
    const cliente = {
      from: (tabela: string) => ({
        select: () => {
          const cadeia = {
            eq: (c: string, v: unknown) => {
              consultas.push([c, v]);
              return cadeia;
            },
            maybeSingle: async () => ({ data: tabela === "contacts" ? contato : null, error: null }),
          };
          return cadeia;
        },
        update: (payload: Linha) => {
          Object.assign(linhas[0]!, payload);
          const cadeia = {
            eq: () => cadeia,
            select: () => cadeia,
            maybeSingle: async () => ({ data: { ...contato, ...payload }, error: null }),
          };
          return cadeia;
        },
      }),
      rpc: async () => ({ data: null, error: null }),
    };

    await patchContactHandler(
      cliente as never,
      { organization_id: ORG, actor: { type: "api_token", id: TOKEN }, requestId: "req-4517", apiTokenId: TOKEN } as never,
      CONTATO,
      { name: "Ana Silva" },
    );

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "contact.updated", actorApiTokenId: TOKEN }),
    );
    expect(consultas).toContainEqual(["organization_id", ORG]);
  });
});

describe("#4517 — a proposta continua sendo a régua da IA", () => {
  it("a função de proposta segue recusando valor igual ao atual (nada a decidir)", async () => {
    const { cliente } = banco([
      { id: CONTATO, organization_id: ORG, name: "Ana", email: null, phone_number: null, birthdate: null, is_anonymized: false },
    ]);

    const r = await proporDadoDoContato(cliente, {
      organizationId: ORG,
      contactId: CONTATO,
      campo: "name",
      valor: "Ana",
    });

    expect(r).toMatchObject({ criada: false, motivo: "valor_igual_ao_atual" });
  });
});
