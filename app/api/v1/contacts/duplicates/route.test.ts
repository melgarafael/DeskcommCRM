/**
 * GET /api/v1/contacts/duplicates — a varredura NÃO corta em 1.000 calada (#2561).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * `supabase/config.toml` tem `max_rows = 1000`: o PostgREST corta toda resposta
 * nesse teto SEM erro. O `.limit(TETO_DE_VARREDURA + 1)` (2001) devolvia 1.000
 * linhas, `1000 <= 2000` dava `varreu_tudo: true`, e o aviso "Mostrando os
 * duplicados entre os contatos mais antigos…" (`components/contacts/MergeDialog.tsx`)
 * nunca aparecia — a tela dizia que tinha varrido tudo com a base pela metade.
 *
 * ⚠️ O DUBLÊ IMPÕE O TETO EM TODA RESPOSTA (`MAX_ROWS`), como o servidor faz.
 * Um dublê que devolvesse `.limit(2001)` inteiro passaria nos dois mundos e não
 * mediria nada. Ele também registra as PÁGINAS pedidas (`range`) e a ordem:
 * é por elas que se prova que a leitura foi paginada de verdade.
 *
 * A detecção em si é a REAL (`encontrarContatosDuplicados`) — o par do telefone
 * com e sem o nono dígito é o caso que a tela existe para achar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadAuthUser } from "@/lib/auth/server";
import { orgAtivaDaApi } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ orgAtivaDaApi: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

/** `max_rows = 1000` do PostgREST: o corte é do SERVIDOR, não do `.limit()`. */
const MAX_ROWS = 1000;
const TETO = 2000;

type Linha = Record<string, unknown>;

interface Consulta {
  tabela: string;
  filtros: Array<[string, unknown]>;
  ordens: string[];
  faixas: Array<[number, number]>;
  contou: boolean;
}

/**
 * Dublê com o teto do servidor aplicado na resposta: `range` e `limit` são
 * recortados em `maxRows`. Filtros `eq`/`is` são APLICADOS de verdade.
 */
function fakeSupabase(dados: Record<string, Linha[]>, maxRows = MAX_ROWS) {
  const consultas: Consulta[] = [];

  const client = {
    from(tabela: string) {
      const registro: Consulta = { tabela, filtros: [], ordens: [], faixas: [], contou: false };
      consultas.push(registro);

      const filtros: Array<(linha: Linha) => boolean> = [];
      let pediuCount = false;

      const executar = (faixa: [number, number] | null) => {
        const base = (dados[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
        const fatia = faixa ? base.slice(faixa[0], faixa[1] + 1) : base;
        return {
          data: fatia.slice(0, maxRows),
          count: pediuCount ? base.length : null,
          error: null,
        } as const;
      };

      const builder: Record<string, unknown> = {};
      builder.select = (_colunas: string, opcoes?: { count?: string }) => {
        pediuCount = opcoes?.count === "exact";
        registro.contou = pediuCount;
        return builder;
      };
      builder.eq = (coluna: string, valor: unknown) => {
        registro.filtros.push([coluna, valor]);
        filtros.push((l) => !(coluna in l) || l[coluna] === valor);
        return builder;
      };
      builder.is = (coluna: string, valor: unknown) => {
        registro.filtros.push([`${coluna} is`, valor]);
        filtros.push((l) => (l[coluna] ?? null) === valor);
        return builder;
      };
      builder.order = (coluna: string) => {
        registro.ordens.push(coluna);
        return builder;
      };
      builder.range = (inicio: number, fim: number) => {
        registro.faixas.push([inicio, fim]);
        return Promise.resolve(executar([inicio, fim]));
      };
      // O caminho de quem NÃO paginou (e o da sabotagem): também cortado.
      builder.limit = (n: number) => {
        const resposta = executar(null);
        return Promise.resolve({ ...resposta, data: (resposta.data ?? []).slice(0, Math.min(n, maxRows)) });
      };
      return builder;
    },
  };
  return { consultas, client };
}

/** Um contato vivo, com telefone único por padrão e `created_at` crescente. */
function contato(i: number, parcial: Linha = {}): Linha {
  const n = String(i).padStart(4, "0");
  return {
    id: `contato-${n}`,
    name: `Contato ${n}`,
    display_name: null,
    email: null,
    email_normalized: null,
    phone_number: `+553198${String(1000000 + i)}`, // 8 dígitos iniciando em 1: sem nono dígito
    is_merged_into: null,
    is_anonymized: false,
    source_metadata: null,
    created_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    last_activity_at: null,
    ...parcial,
  };
}

function base(quantos: number): Linha[] {
  return Array.from({ length: quantos }, (_, k) => contato(k + 1));
}

async function chamar(): Promise<Response> {
  const { GET } = await import("./route");
  return GET();
}

function corpo(res: Response): Promise<{ data: unknown; meta: Record<string, unknown> }> {
  return res.json() as never;
}

beforeEach(() => {
  vi.mocked(loadAuthUser).mockResolvedValue({
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "manager" }],
  } as never);
  vi.mocked(orgAtivaDaApi).mockResolvedValue({ ok: true, org: { orgId: ORG_ID, name: "Org" } } as never);
});

describe("a varredura de duplicados responde ao que foi LIDO", () => {
  it("⭐ base com 2.500 contatos: `varreu_tudo: false` (não `true`), e o par além do teto não entra", async () => {
    const linhas = base(2500);
    // Par DENTRO da janela varrida (contatos 5 e 1500): mesma pessoa, grafias do
    // nono dígito — é o caso que a tela existe para achar.
    linhas[4] = contato(5, { phone_number: "+553198966398" });
    linhas[1499] = contato(1500, { phone_number: "+5531998966398" });
    // Par FORA da janela (2100 e 2200): não pode aparecer no resultado.
    linhas[2099] = contato(2100, { phone_number: "+553191234567" });
    linhas[2199] = contato(2200, { phone_number: "+5531991234567" });
    const { consultas, client } = fakeSupabase({ contacts: linhas });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar();
    const json = await corpo(res);

    expect(res.status).toBe(200);
    expect(json.meta.varreu_tudo, "com a base cortada em 1.000, a tela dizia que varreu tudo").toBe(false);
    expect(json.meta.contatos_varridos).toBe(TETO);

    const grupos = json.data as Array<{ contatos: Array<{ id: string }> }>;
    expect(grupos, "o par dentro da janela tem de aparecer").toHaveLength(1);
    expect(grupos[0]!.contatos.map((c) => c.id).sort()).toEqual(["contato-0005", "contato-1500"]);

    // A leitura foi PAGINADA, em ordem estável: é o que prova que a correção
    // não voltou a ser um único `.limit`.
    const contatos = consultas.filter((c) => c.tabela === "contacts");
    expect(contatos[0]!.ordens).toEqual(["created_at", "id"]);
    expect(contatos.flatMap((c) => c.faixas)).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2000],
    ]);
    expect(contatos[0]!.contou, "o fim tem de ser provado pelo count exato").toBe(true);
  });

  it("controle: base pequena continua varrida por inteiro, com o par achado", async () => {
    const linhas = base(500);
    linhas[4] = contato(5, { phone_number: "+553198966398" });
    linhas[399] = contato(400, { phone_number: "+5531998966398" });
    const { client } = fakeSupabase({ contacts: linhas });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const json = await corpo(await chamar());

    expect(json.meta.varreu_tudo).toBe(true);
    expect(json.meta.contatos_varridos).toBe(500);
    const grupos = json.data as Array<{ contatos: Array<{ id: string }> }>;
    expect(grupos).toHaveLength(1);
    expect(grupos[0]!.contatos.map((c) => c.id).sort()).toEqual(["contato-0005", "contato-0400"]);
  });

  it("borda: exatamente 2.000 contatos ainda é `varreu_tudo: true`", async () => {
    const { client } = fakeSupabase({ contacts: base(2000) });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const json = await corpo(await chamar());

    expect(json.meta.varreu_tudo).toBe(true);
    expect(json.meta.contatos_varridos).toBe(2000);
  });

  it("instalação com `max_rows` MENOR que a página: página curta não vira fim", async () => {
    // O `max_rows` é configuração de instalação; a página curta não pode ser
    // lida como "acabou" (a doutrina de `lib/agenda/protecao-followup.ts`). O
    // fim continua sendo o `count` exato — e o total de 2.500 segue truncado.
    const linhas = base(2500);
    linhas[4] = contato(5, { phone_number: "+553198966398" });
    linhas[1499] = contato(1500, { phone_number: "+5531998966398" });
    const { client } = fakeSupabase({ contacts: linhas }, 300);
    vi.mocked(createClient).mockResolvedValue(client as never);

    const json = await corpo(await chamar());

    expect(json.meta.varreu_tudo).toBe(false);
    expect(json.meta.contatos_varridos).toBe(TETO);
    const grupos = json.data as Array<{ contatos: Array<{ id: string }> }>;
    expect(grupos[0]!.contatos.map((c) => c.id).sort()).toEqual(["contato-0005", "contato-1500"]);
  });
});
