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
import { parDeContatos } from "@/lib/contacts/duplicados";
import { createClient } from "@/lib/supabase/server";

/**
 * As dispensas ("não são a mesma empresa") são lidas pelo cliente administrador. O
 * teste da ROTA prova que a lista as respeita; a sabotagem de QUEM as lê (o cliente
 * do usuário, que a policy de `merge_queue` esvazia para quem não é gestor) fica na
 * suíte de invariantes, onde há banco de verdade.
 */
const dispensa = vi.hoisted(() => ({ pares: new Set<string>() }));

/** O cliente do servidor da vez: é por ele, e não pela sessão, que o CPF é lido. */
const servidor = vi.hoisted(() => ({ cliente: {} as unknown }));

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ orgAtivaDaApi: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => servidor.cliente }));
vi.mock("@/lib/contacts/dispensar-par", () => ({
  lerParesDispensados: async () => new Set(dispensa.pares),
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

/** `max_rows = 1000` do PostgREST: o corte é do SERVIDOR, não do `.limit()`. */
const MAX_ROWS = 1000;
const TETO = 2000;

type Linha = Record<string, unknown>;

interface Consulta {
  tabela: string;
  colunas: string;
  filtros: Array<[string, unknown]>;
  ordens: string[];
  faixas: Array<[number, number]>;
  contou: boolean;
}

/**
 * Dublê com o teto do servidor aplicado na resposta: `range` e `limit` são
 * recortados em `maxRows`. Filtros `eq`/`is` são APLICADOS de verdade.
 *
 * A lista de COLUNAS é registrada (não aplicada): é por ela que se prova que a
 * rota pediu `cpf_hash`, e a quem — e um dublê que devolve a linha inteira
 * esconde isso.
 */
function fakeSupabase(
  dados: Record<string, Linha[]>,
  maxRows = MAX_ROWS,
  falha?: { data: null; error: { message: string } },
) {
  const consultas: Consulta[] = [];

  const client = {
    from(tabela: string) {
      const registro: Consulta = { tabela, colunas: "", filtros: [], ordens: [], faixas: [], contou: false };
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
      builder.select = (colunas: string, opcoes?: { count?: string }) => {
        registro.colunas = colunas;
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
      builder.in = (coluna: string, valores: unknown[]) => {
        registro.filtros.push([`${coluna} in`, valores]);
        filtros.push((l) => valores.includes(l[coluna]));
        return builder;
      };
      builder.not = (coluna: string, _operador: "is", valor: unknown) => {
        registro.filtros.push([`${coluna} not is`, valor]);
        filtros.push((l) => (l[coluna] ?? null) !== valor);
        return builder;
      };
      // A leitura do servidor não pagina: `await` direto na cadeia.
      builder.then = (resolver: (v: unknown) => unknown) =>
        Promise.resolve(falha ?? executar(null)).then(resolver);
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
    cpf_hash: null,
    wa_identity: null,
    wa_lid: null,
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
  return GET(new Request("http://localhost/api/v1/contacts/duplicates") as never);
}

function corpo(res: Response): Promise<{ data: unknown; meta: Record<string, unknown> }> {
  return res.json() as never;
}

beforeEach(() => {
  dispensa.pares.clear();
  servidor.cliente = fakeSupabase({}).client;
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

describe("o repetido pelo nome: sugestão depois dos fortes, e dispensa que vale para a lista", () => {
  /** Um grupo forte (o mesmo celular, com e sem o nono dígito) e um par só pelo nome. */
  function cenario(): Linha[] {
    const linhas = base(60);
    linhas[4] = contato(5, { phone_number: "+553198966398" });
    linhas[5] = contato(6, { phone_number: "+5531998966398" });
    linhas[9] = contato(10, { name: "Clínica Santos Odontologia", phone_number: "+553191110010" });
    linhas[19] = contato(20, {
      name: "Santos Odontologia Clínica Avançada",
      phone_number: "+553191110020",
    });
    return linhas;
  }

  it("o par por nome vem com motivos nome_parecido, DEPOIS do grupo forte", async () => {
    // Sabotagem: concatenar os parecidos ANTES dos fortes deixa a ordem vermelha.
    const { client } = fakeSupabase({ contacts: cenario() });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const grupos = (await corpo(await chamar())).data as Array<{
      motivos: string[];
      contatos: Array<{ id: string; address_book_name: unknown }>;
    }>;

    expect(grupos.map((g) => g.motivos)).toEqual([["telefone"], ["nome_parecido"]]);
    expect(grupos[1]!.contatos.map((c) => c.id)).toEqual(["contato-0010", "contato-0020"]);
    // O campo novo chega à tela, mesmo quando é nulo.
    expect(grupos[1]!.contatos[0]!.address_book_name).toBeNull();
  });

  it("par dispensado (com a ordem invertida) não aparece, e o papel de quem olha não muda isso", async () => {
    // Sabotagem: ignorar `lerParesDispensados` deixa o par de nome na lista.
    dispensa.pares.add(parDeContatos("contato-0020", "contato-0010"));
    vi.mocked(loadAuthUser).mockResolvedValue({
      id: USER_ID,
      email: "a@example.com",
      full_name: null,
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR",
      organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "viewer" }],
    } as never);
    const { client } = fakeSupabase({ contacts: cenario() });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const grupos = (await corpo(await chamar())).data as Array<{ motivos: string[] }>;

    expect(grupos.map((g) => g.motivos)).toEqual([["telefone"]]);
  });
});

/**
 * ─── O CPF na varredura (#4081) ───────────────────────────────────────────────
 *
 * `cpf_hash` é comparado (é igualdade, e o índice único dele nasce com
 * `if not exists`) pelo SERVIDOR, só nas fichas que a rota listou. A resposta não
 * o devolve.
 */
describe("CPF na varredura", () => {
  const CPF_A = "1111111111111111111111111111111111111111111111111111111111111111";

  function comCpf(linhas: Linha[]): Linha[] {
    // Dois contatos com o MESMO CPF, nomes diferentes e telefones diferentes —
    // o caso real que a tela não achava.
    linhas[4] = contato(5, { name: "Maria Souza Lima", cpf_hash: CPF_A });
    linhas[149] = contato(150, { name: "M. S. Lima", cpf_hash: CPF_A });
    return linhas;
  }

  /** A sessão lê a base; o servidor conhece o CPF dela. */
  function montar(linhasDaSessao: Linha[] = base(300)) {
    const sessao = fakeSupabase({ contacts: linhasDaSessao });
    const doServidor = fakeSupabase({ contacts: comCpf(base(300)) });
    vi.mocked(createClient).mockResolvedValue(sessao.client as never);
    servidor.cliente = doServidor.client;
    return { sessao, doServidor };
  }

  it("⭐ CPF igual une o par com o motivo `cpf` — e quem lê o CPF é o servidor", async () => {
    const { sessao, doServidor } = montar();

    const json = await corpo(await chamar());
    const grupos = json.data as Array<{ motivos: string[]; contatos: Array<{ id: string }> }>;

    expect(grupos).toHaveLength(1);
    expect(grupos[0]!.motivos).toEqual(["cpf"]);
    expect(grupos[0]!.contatos.map((c) => c.id).sort()).toEqual(["contato-0005", "contato-0150"]);

    // Sabotagem: devolver `cpf_hash` a `COLUNAS_DO_CONTATO` deixa a primeira
    // asserção vermelha; tirar a leitura do servidor deixa o grupo acima vazio.
    for (const leitura of sessao.consultas) expect(leitura.colunas).not.toContain("cpf_hash");
    expect(doServidor.consultas.some((c) => c.colunas.includes("cpf_hash"))).toBe(true);
  });

  it("o servidor só olha as fichas que a sessão viu, na organização da sessão", async () => {
    // Ficha 150 fora do que a sessão enxerga: o par não pode se formar por ela.
    const { doServidor } = montar(base(100));

    const json = await corpo(await chamar());
    expect(json.data).toEqual([]);

    const pedidos = doServidor.consultas.filter((c) => c.tabela === "contacts");
    expect(pedidos.length).toBe(1);
    // Sabotagem: tirar o `.eq("organization_id", …)` deixa esta asserção vermelha.
    expect(pedidos[0]!.filtros).toContainEqual(["organization_id", ORG_ID]);
    const ids = pedidos[0]!.filtros.find(([c]) => c === "id in")![1] as string[];
    expect(ids).toHaveLength(100);
    expect(ids).not.toContain("contato-0150");
  });

  it("base maior que um lote de ids é lida em vários pedidos, sem perder o par", async () => {
    // Fichas 5 e 150 caem em lotes diferentes (o lote é de 100).
    const { doServidor } = montar();

    const json = await corpo(await chamar());
    expect((json.data as unknown[]).length).toBe(1);
    expect(doServidor.consultas.filter((c) => c.tabela === "contacts").length).toBe(3);
  });

  it("falha na leitura do CPF é erro da rota, não lista sem o par", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeSupabase({ contacts: base(10) }).client as never);
    servidor.cliente = fakeSupabase({}, MAX_ROWS, { data: null, error: { message: "fora" } }).client;

    const res = await chamar();
    expect(res.status).toBe(500);
  });

  it("o `cpf_hash` NÃO sai no JSON — nem no detalhe do grupo", async () => {
    montar();

    const res = await chamar();
    const texto = await res.clone().text();

    expect(texto).not.toContain("cpf_hash");
    expect(texto).not.toContain(CPF_A);
    // Controle positivo: o grupo está lá (um payload vazio também não teria o hash).
    const json = (await res.json()) as { data: unknown[] };
    expect(json.data).toHaveLength(1);
  });

  it("o `eq(organization_id)` continua preso na leitura — outra organização não entra", async () => {
    // Sabotagem: tirar o `.eq("organization_id", …)` deixa esta asserção vermelha.
    const { sessao } = montar();

    await chamar();

    const leitura = sessao.consultas.find((c) => c.tabela === "contacts")!;
    expect(leitura.filtros).toContainEqual(["organization_id", ORG_ID]);
  });
});

/**
 * ─── O WhatsApp na varredura (#4081) ─────────────────────────────────────────
 *
 * `contacts.phone_whatsapp` NÃO é número (é `sim`/`nao`/`nao_sei`), e é por isso
 * que a coluna não entra aqui. O que identifica a conta é `wa_identity` (0027) e
 * `wa_lid` (0122) — as duas geradas, as duas com índice único nascido de
 * `if not exists`. A rota passa a LER as duas e continua devolvendo só pessoa,
 * telefone e e-mail: identificador de conta de WhatsApp não é dado de tela.
 */
describe("WhatsApp na varredura", () => {
  const LID = "100000000000001";

  function comOLid(linhas: Linha[]): Linha[] {
    // Duas fichas nascidas do MESMO @lid — antes e depois da correção da 0027, ou
    // num clone em que o índice único não nasceu. Nomes e telefones diferentes: o
    // que prova que é a mesma pessoa é a conta do WhatsApp.
    linhas[4] = contato(5, {
      name: "Maria Souza",
      wa_identity: `lid:${LID}`,
      wa_lid: LID,
    });
    linhas[149] = contato(150, {
      name: "M. Souza Atendimento",
      wa_identity: `lid:${LID}`,
      wa_lid: LID,
    });
    return linhas;
  }

  it("⭐ a conta de WhatsApp igual une o par com o motivo `whatsapp` — e a rota PEDE as duas colunas", async () => {
    const { consultas, client } = fakeSupabase({ contacts: comOLid(base(300)) });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const json = await corpo(await chamar());
    const grupos = json.data as Array<{ motivos: string[]; contatos: Array<{ id: string }> }>;

    expect(grupos).toHaveLength(1);
    expect(grupos[0]!.motivos).toEqual(["whatsapp"]);
    expect(grupos[0]!.contatos.map((c) => c.id).sort()).toEqual(["contato-0005", "contato-0150"]);

    // Sabotagem: tirar `wa_identity`/`wa_lid` de `COLUNAS_DO_CONTATO` deixa esta
    // asserção vermelha — e, no banco, o par nunca mais é encontrado.
    const leitura = consultas.find((c) => c.tabela === "contacts")!;
    expect(leitura.colunas).toContain("wa_identity");
    expect(leitura.colunas).toContain("wa_lid");
  });

  it("`wa_identity` e `wa_lid` NÃO saem no JSON", async () => {
    const { client } = fakeSupabase({ contacts: comOLid(base(300)) });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar();
    const texto = await res.clone().text();

    expect(texto).not.toContain("wa_identity");
    expect(texto).not.toContain("wa_lid");
    expect(texto).not.toContain(LID);
    // Controle positivo: o grupo está lá (um payload vazio também não teria o lid).
    const json = (await res.json()) as { data: unknown[] };
    expect(json.data).toHaveLength(1);
  });
});
