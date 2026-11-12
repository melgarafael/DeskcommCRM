import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  getConversationHandler,
  idsDeContatosPessoaisVisiveis,
  listConversationsHandler,
} from "@/app/api/v1/conversations/_handler";
import { ApiError } from "@/lib/api/types";
import { podeVerPessoal } from "@/lib/inbox/pessoal";

/**
 * A ABA PESSOAL GANHA DONO (issue #4434).
 *
 * Hoje o contato marcado como pessoal é invisível para TODO MUNDO, inclusive
 * para quem marcou: a lista exclui, a busca fixa `is_personal = false`, a
 * contagem herda, o link direto dá 404 e o envio dá 403. O recorte aprovado faz
 * quem marcou ler e responder o SEU — e mais ninguém. `admin` e `manager` NÃO
 * são exceção: aqui a porta esquecida não expõe "um registro", expõe conversa
 * de família.
 *
 * Contato marcado antes desta feature (dono nulo) segue invisível para todos,
 * inclusive `admin`, até alguém marcar de novo e adotar.
 *
 * ─── AS TRÊS SABOTAGENS (medidas, uma por porta) ───────────────────────────
 * 1. ADMIN ENTRANDO. `if (actor.role === "admin") return true` em
 *    `lib/inbox/pessoal.ts` → caem os 4 casos de régua/link direto ("admin não
 *    lê", "legado fechado", "admin recebe 404", "legado não abre"). A LISTA
 *    continua vazia para o admin mesmo assim, e isso é de propósito: ela não
 *    passa por `podeVerPessoal`, passa pela primitiva escopada no banco — para
 *    furar a lista seria preciso acrescentar `verTodos` lá, e é justamente por
 *    isso que a primitiva não recebe papel. No ENVIO a sabotagem equivalente é
 *    `autorizado = humano` (largar a comparação com o dono): caem "admin não
 *    envia" e "gerente não envia".
 * 2. BUSCA SEM DONO. Apagar o `.eq("personal_owner_user_id", …)` da subconsulta
 *    de contatos → cai "o dono procura Mãe e a busca não nomeia o do colega"
 *    (o `contact_id.in.` passa a listar `ct-colega`).
 * 3. CONTAGEM ESQUECIDA. Trocar `countExact(auxiliares, pessoaisVisiveis)` por
 *    `countExact()` → caem "a contagem pessoal usa a mesma primitiva" e "o
 *    conjunto vazio responde zero sem consultar".
 *
 * Linha para reverter: `lib/inbox/pessoal.ts`,
 * `app/api/v1/conversations/_handler.ts`, `.../counts/route.ts`,
 * `app/api/v1/messages/_handler.ts`.
 *
 * ⚠️ Nenhum dado de conversa real aqui: nomes e números são fictícios, de
 * propósito — teste não é lugar de conteúdo pessoal.
 */

const RAIZ = process.cwd();
const fonte = (...partes: string[]) => fs.readFileSync(path.join(RAIZ, ...partes), "utf8");
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ORG = "11111111-1111-4111-8111-111111111111";
const DONO = "22222222-2222-4222-8222-222222222222";
const COLEGA = "33333333-3333-4333-8333-333333333333";
const ADMIN = "44444444-4444-4444-8444-444444444444";

type Linha = Record<string, unknown>;

interface Resposta {
  data: Linha[] | Linha | null;
  error: null;
  count?: number;
}

interface Registro {
  tabela: string;
  eq: Array<[string, unknown]>;
  em: Array<[string, unknown[]]>;
  nao: Array<[string, string, string]>;
  ou: string[];
}

/**
 * Um banco de mentira que AVALIA os `eq`/`in`/`is` contra as linhas.
 *
 * Não é um espião de chamadas: é um filtro de verdade, com igualdade — o que
 * basta para a pergunta desta feature ("de quem é este pessoal?"). Os operadores
 * que a régua não usa para decidir dono (`or`, `ilike`) só são registrados, e é
 * o registro que prova qual consulta a busca montaria.
 */
function bancoDeMentira(tabelas: Record<string, Linha[]>) {
  const registros: Registro[] = [];

  function daTabela(tabela: string) {
    const registro: Registro = { tabela, eq: [], em: [], nao: [], ou: [] };
    registros.push(registro);
    let linhas = [...(tabelas[tabela] ?? [])];

    const api = {} as {
      select: (cols?: unknown, opts?: unknown) => typeof api;
      eq: (col: string, val: unknown) => typeof api;
      in: (col: string, vals: unknown[]) => typeof api;
      is: (col: string, val: unknown) => typeof api;
      not: (col: string, op: string, val: string) => typeof api;
      or: (expr: string) => typeof api;
      ilike: (col: string, val: string) => typeof api;
      like: (col: string, val: string) => typeof api;
      gte: (col: string, val: unknown) => typeof api;
      gt: (col: string, val: unknown) => typeof api;
      lt: (col: string, val: unknown) => typeof api;
      order: (col: string, opts?: unknown) => typeof api;
      limit: (n: number) => typeof api;
      maybeSingle: () => Promise<Resposta>;
      then: (ok: (v: Resposta) => unknown, no?: (e: unknown) => unknown) => Promise<unknown>;
    };

    const proprio = () => api;

    api.select = () => proprio();
    api.eq = (col, val) => {
      registro.eq.push([col, val]);
      linhas = linhas.filter((l) => l[col] === val);
      return proprio();
    };
    api.in = (col, vals) => {
      registro.em.push([col, vals]);
      linhas = linhas.filter((l) => vals.includes(l[col]));
      return proprio();
    };
    api.is = (col, val) => {
      linhas = linhas.filter((l) => (l[col] ?? null) === val);
      return proprio();
    };
    api.not = (col, op, val) => {
      registro.nao.push([col, op, val]);
      return proprio();
    };
    api.or = (expr) => {
      registro.ou.push(expr);
      return proprio();
    };
    // A busca por nome/telefone não é o que decide dono; ela é registrada (o
    // `or` acima) e as linhas voltam como o PostgREST devolveria depois dos
    // `eq` — é o suficiente para saber QUAIS ids a busca pediria.
    api.ilike = () => proprio();
    api.like = () => proprio();
    api.gte = () => proprio();
    api.gt = () => proprio();
    api.lt = () => proprio();
    api.order = () => proprio();
    api.limit = (n) => {
      linhas = linhas.slice(0, n);
      return proprio();
    };
    api.maybeSingle = async () => ({ data: linhas[0] ?? null, error: null });
    api.then = (ok, no) =>
      Promise.resolve({ data: linhas, error: null, count: linhas.length }).then(ok, no);

    return api;
  }

  return {
    // O handler usa o client admin/service role: `from` é a única superfície.
    client: { from: daTabela } as never,
    registros,
  };
}

const CONTATOS: Linha[] = [
  {
    id: "ct-mae",
    organization_id: ORG,
    is_personal: true,
    personal_owner_user_id: DONO,
    is_anonymized: false,
    is_merged_into: null,
    display_name: "Mãe (fictícia)",
    busca_sem_acento: "mae (ficticia)",
    phone_number: "+5511900000001",
  },
  {
    id: "ct-colega",
    organization_id: ORG,
    is_personal: true,
    personal_owner_user_id: COLEGA,
    is_anonymized: false,
    is_merged_into: null,
    display_name: "Mãe do colega (fictícia)",
    busca_sem_acento: "mae do colega (ficticia)",
    phone_number: "+5511900000002",
  },
  {
    // Legado: marcado antes da coluna existir. Invisível para TODOS.
    id: "ct-legado",
    organization_id: ORG,
    is_personal: true,
    personal_owner_user_id: null,
    is_anonymized: false,
    is_merged_into: null,
    display_name: "Mãe antiga (fictícia)",
    busca_sem_acento: "mae antiga (ficticia)",
    phone_number: "+5511900000003",
  },
  {
    id: "ct-cliente",
    organization_id: ORG,
    is_personal: false,
    personal_owner_user_id: null,
    is_anonymized: false,
    is_merged_into: null,
    display_name: "Cliente (fictício)",
    busca_sem_acento: "cliente (ficticio)",
    phone_number: "+5511900000004",
  },
];

const CONVERSAS: Linha[] = [
  {
    id: "cv-mae",
    organization_id: ORG,
    contact_id: "ct-mae",
    status: "closed",
    channel_session_id: "cs-1",
    last_message_at: "2026-11-12T10:00:00.000Z",
    last_message_preview: "mensagem fictícia 1",
    contacts: CONTATOS[0],
  },
  {
    id: "cv-colega",
    organization_id: ORG,
    contact_id: "ct-colega",
    status: "closed",
    channel_session_id: "cs-1",
    last_message_at: "2026-11-12T11:00:00.000Z",
    last_message_preview: "mensagem fictícia 2",
    contacts: CONTATOS[1],
  },
  {
    id: "cv-legado",
    organization_id: ORG,
    contact_id: "ct-legado",
    status: "closed",
    channel_session_id: "cs-1",
    last_message_at: "2026-11-12T12:00:00.000Z",
    last_message_preview: "mensagem fictícia 3",
    contacts: CONTATOS[2],
  },
  {
    id: "cv-cliente",
    organization_id: ORG,
    contact_id: "ct-cliente",
    status: "open",
    channel_session_id: "cs-1",
    last_message_at: "2026-11-12T13:00:00.000Z",
    last_message_preview: "mensagem fictícia 4",
    contacts: CONTATOS[3],
  },
];

function ctxDe(actor: { type: string; id: string; role?: string }): never {
  return {
    organization_id: ORG,
    requestId: "req-1",
    idioma: "pt-BR",
    actor,
  } as never;
}

const TABELAS = () => ({
  contacts: CONTATOS.map((c) => ({ ...c })),
  conversations: CONVERSAS.map((c) => ({ ...c })),
});

function banco() {
  return bancoDeMentira(TABELAS());
}

const idsDas = (lista: { conversations: Array<{ id: string }> }) =>
  lista.conversations.map((c) => c.id).sort();

// ---------------------------------------------------------------------------
// A régua
// ---------------------------------------------------------------------------

describe("podeVerPessoal — a única entrada é ser o dono da marca", () => {
  const pessoalDoDono = { is_personal: true, personal_owner_user_id: DONO };

  it("o dono lê o seu, em qualquer papel", () => {
    expect(podeVerPessoal({ type: "user", id: DONO }, pessoalDoDono)).toBe(true);
    expect(podeVerPessoal({ type: "user", id: DONO, role: "manager" }, pessoalDoDono)).toBe(true);
  });

  it("o ADMIN não lê o pessoal do colega — papel não é titularidade", () => {
    // A sabotagem 1 mora aqui: no desenho do PR #4187 o `admin` via todos.
    expect(podeVerPessoal({ type: "user", id: ADMIN, role: "admin" }, pessoalDoDono)).toBe(false);
    expect(podeVerPessoal({ type: "user", id: COLEGA, role: "manager" }, pessoalDoDono)).toBe(
      false,
    );
    expect(podeVerPessoal({ type: "user", id: COLEGA, role: "agent" }, pessoalDoDono)).toBe(false);
  });

  it("contato legado (sem dono) fica fechado para todos, inclusive admin", () => {
    const legado = { is_personal: true, personal_owner_user_id: null };
    expect(podeVerPessoal({ type: "user", id: DONO }, legado)).toBe(false);
    expect(podeVerPessoal({ type: "user", id: ADMIN, role: "admin" }, legado)).toBe(false);
  });

  it("token e agente de IA nunca alcançam, nem com o id do dono", () => {
    expect(podeVerPessoal({ type: "api_token", id: DONO }, pessoalDoDono)).toBe(false);
    expect(podeVerPessoal({ type: "ai_agent", id: DONO, role: "agent" }, pessoalDoDono)).toBe(
      false,
    );
  });

  it("contato comum é de todo mundo (a régua só existe para pessoal)", () => {
    const comum = { is_personal: false, personal_owner_user_id: null };
    expect(podeVerPessoal({ type: "user", id: COLEGA }, comum)).toBe(true);
    expect(podeVerPessoal({ type: "api_token", id: "tok" }, comum)).toBe(true);
  });
});

describe("idsDeContatosPessoaisVisiveis — o conjunto é escopado no banco", () => {
  it("devolve SÓ o pessoal do dono: nada do colega, nada do legado", async () => {
    const { client } = banco();
    const ids = await idsDeContatosPessoaisVisiveis(client, ORG, DONO);
    expect(ids).toEqual(["ct-mae"]);
  });

  it("o admin não tem conjunto próprio: vê o que é dele, e só", async () => {
    const { client } = banco();
    expect(await idsDeContatosPessoaisVisiveis(client, ORG, ADMIN)).toEqual([]);
  });

  it("sem pessoa não há dono — falha fechada, não filtro ausente", async () => {
    const { client, registros } = banco();
    expect(await idsDeContatosPessoaisVisiveis(client, ORG, null)).toEqual([]);
    // Nem chegou a consultar: `undefined` no `.eq` viraria "todo o pessoal da org".
    expect(registros).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Porta 1 — a lista
// ---------------------------------------------------------------------------

describe("porta 1: a lista da aba Pessoal tem dono", () => {
  it("o dono vê o seu; não vê o do colega nem o legado", async () => {
    const { client } = banco();
    const r = await listConversationsHandler(client, ctxDe({ type: "user", id: DONO }), {
      limit: 50,
      pessoais: true,
    } as never);
    expect(idsDas(r)).toEqual(["cv-mae"]);
  });

  it("o colega vê o DELE, não o do dono", async () => {
    const { client } = banco();
    const r = await listConversationsHandler(client, ctxDe({ type: "user", id: COLEGA }), {
      limit: 50,
      pessoais: true,
    } as never);
    expect(idsDas(r)).toEqual(["cv-colega"]);
  });

  it("o admin NÃO vê o pessoal de ninguém: a aba dele vem vazia", async () => {
    const { client } = banco();
    const r = await listConversationsHandler(
      client,
      ctxDe({ type: "user", id: ADMIN, role: "admin" }),
      { limit: 50, pessoais: true } as never,
    );
    expect(r.conversations).toEqual([]);
    expect(r.has_more).toBe(false);
  });

  it("token de API não lista pessoal nem pedindo a aba", async () => {
    const { client } = banco();
    const r = await listConversationsHandler(client, ctxDe({ type: "api_token", id: "tok-1" }), {
      limit: 50,
      pessoais: true,
    } as never);
    expect(r.conversations).toEqual([]);
  });

  it("as abas de TRABALHO continuam sem pessoal (spec 21 preservada)", async () => {
    const { client, registros } = banco();
    await listConversationsHandler(client, ctxDe({ type: "user", id: DONO }), {
      limit: 50,
    } as never);
    const principal = registros.find((r) => r.tabela === "conversations");
    const exclusao = principal?.nao.find(([col]) => col === "contact_id");
    expect(exclusao?.[1]).toBe("in");
    // Os TRÊS pessoais da organização — o do dono inclusive — ficam fora da
    // lista de trabalho. É a catraca da spec 21, e ela não afrouxou.
    expect(exclusao?.[2]).toContain("ct-mae");
    expect(exclusao?.[2]).toContain("ct-colega");
    expect(exclusao?.[2]).toContain("ct-legado");
  });
});

// ---------------------------------------------------------------------------
// Porta 2 — a busca
// ---------------------------------------------------------------------------

describe("porta 2: a busca funciona DENTRO da aba, e só no próprio", () => {
  it("o dono procura \"Mãe\" e a busca não nomeia o contato do colega", async () => {
    const { client, registros } = banco();
    const r = await listConversationsHandler(client, ctxDe({ type: "user", id: DONO }), {
      limit: 50,
      pessoais: true,
      search: "Mãe",
    } as never);

    // O termo casa os três "Mãe" fictícios da organização; a régua de dono é
    // quem separa. Se o filtro de dono sair da busca (SABOTAGEM 2), o id do
    // contato do colega aparece aqui — e é isso que este caso acusa.
    const busca = registros.filter((reg) => reg.tabela === "conversations").flatMap((reg) => reg.ou);
    expect(busca.join(" | ")).toContain("contact_id.in.(ct-mae)");
    expect(busca.join(" | ")).not.toContain("ct-colega");
    expect(busca.join(" | ")).not.toContain("ct-legado");
    expect(idsDas(r)).toEqual(["cv-mae"]);
  });

  it("a subconsulta de contatos pede o dono junto com is_personal", () => {
    const LISTA = semComentarios(fonte("app", "api", "v1", "conversations", "_handler.ts"));
    // As DUAS pontas (ficha principal e telefone extra) filtram pelo mesmo
    // booleano da lista e, dentro da aba, pelo dono.
    expect(LISTA.match(/\.eq\("(?:contacts\.)?is_personal",\s*querPessoal\)/g) ?? []).toHaveLength(
      2,
    );
    expect(LISTA.match(/personal_owner_user_id",\s*atorHumanoId/g) ?? []).toHaveLength(2);
    // Ninguém pode voltar a FIXAR `false` numa ponta e deixar a outra invertida.
    expect(LISTA).not.toMatch(/\.eq\("(?:contacts\.)?is_personal",\s*false\)/);
  });
});

// ---------------------------------------------------------------------------
// Porta 3 — a contagem
// ---------------------------------------------------------------------------

describe("porta 3: a contagem nasce do MESMO conjunto da lista", () => {
  const CONTAS = semComentarios(
    fonte("app", "api", "v1", "conversations", "counts", "route.ts"),
  );

  it("a contagem pessoal usa a mesma primitiva e o mesmo usuário da sessão", () => {
    expect(CONTAS).toMatch(/idsDeContatosPessoaisVisiveis\(supabase, org, user\.id\)/);
    expect(CONTAS).toMatch(/countExact\(auxiliares, pessoaisVisiveis\)/);
    expect(CONTAS).toMatch(/pessoal: pessoal\.count \?\? 0/);
  });

  it("o conjunto vazio responde zero SEM consultar (não vira `in ()`)", () => {
    expect(CONTAS).toMatch(/pessoaisVisiveis\.length === 0/);
    expect(CONTAS).toMatch(/Promise\.resolve\(\{ count: 0, error: null \}\)/);
  });

  it("as outras contagens continuam excluindo pessoal — a régua não vazou", () => {
    // `if (pessoalVisivel) …in… else if (pessoais.length) …not…`: o `not` da
    // spec 21 tem de sobreviver no ramo padrão, e o `in` só entra quando o
    // conjunto pessoal é passado de propósito.
    expect(CONTAS).toMatch(/if \(pessoalVisivel\) q = q\.in\("contact_id"/);
    expect(CONTAS).toMatch(/else if \(pessoais\.length > 0\) q = q\.not\("contact_id", "in"/);
    expect(CONTAS).toMatch(/pessoal\.error/);
  });
});

// ---------------------------------------------------------------------------
// Porta 4 — o link direto
// ---------------------------------------------------------------------------

describe("porta 4: link direto abre para o dono e 404 para o resto", () => {
  async function abrir(actor: { type: string; id: string; role?: string }, id: string) {
    const { client } = banco();
    return getConversationHandler(client, ctxDe(actor), id).catch((e: unknown) => e);
  }

  it("o dono abre a própria conversa pessoal", async () => {
    const conv = await abrir({ type: "user", id: DONO }, "cv-mae");
    expect((conv as { id?: string }).id).toBe("cv-mae");
  });

  it("o admin recebe o MESMO 404 do inexistente (sem revelar que existe)", async () => {
    const err = await abrir({ type: "user", id: ADMIN, role: "admin" }, "cv-mae");
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).code).toBe("not_found");
    expect((err as ApiError).message).toBe("Conversa não encontrada.");
  });

  it("o colega também recebe 404", async () => {
    const err = await abrir({ type: "user", id: COLEGA }, "cv-mae");
    expect((err as ApiError).status).toBe(404);
  });

  it("o legado sem dono não abre nem para o admin", async () => {
    const err = await abrir({ type: "user", id: ADMIN, role: "admin" }, "cv-legado");
    expect((err as ApiError).status).toBe(404);
  });

  it("conversa comum segue abrindo para qualquer pessoa", async () => {
    const conv = await abrir({ type: "user", id: COLEGA }, "cv-cliente");
    expect((conv as { id?: string }).id).toBe("cv-cliente");
  });
});

// ---------------------------------------------------------------------------
// O histórico e a migração
// ---------------------------------------------------------------------------

describe("o histórico da conversa acompanha o link direto", () => {
  const HISTORICO = semComentarios(fonte("app", "api", "v1", "messages", "_handler.ts"));

  it("o corte do histórico usa a MESMA régua de dono, não `is_personal` cru", () => {
    // Sem isto a conversa abriria no cabeçalho e a thread viria vazia — pior que
    // o 404, porque parece que as mensagens sumiram.
    expect(HISTORICO).toMatch(/import \{ podeVerPessoal \} from "@\/lib\/inbox\/pessoal"/);
    expect(HISTORICO).toMatch(/select\("is_personal, personal_owner_user_id"\)/);
    expect(HISTORICO).toMatch(/if \(!podeVerPessoal\(ctx\.actor, contatoDaConversa\)\)/);
  });
});

describe("a migration existe e o baseline a espelha", () => {
  it("a coluna nasce com dono e sem backfill, e o baseline tem o mesmo bloco", () => {
    const dir = path.join(RAIZ, "supabase", "migrations");
    const arquivo = fs.readdirSync(dir).find((n) => n.endsWith("_pessoal_com_dono.sql"));
    expect(arquivo).toBeTruthy();
    const migracao = fs.readFileSync(path.join(dir, arquivo as string), "utf8");
    expect(migracao).toContain("add column if not exists personal_owner_user_id uuid");
    expect(migracao).toContain("on delete set null");
    expect(migracao).toContain("where (is_personal = true)");
    // Sem UPDATE de preenchimento: o pessoal antigo continua invisível.
    expect(migracao).not.toMatch(/update\s+public\.contacts\s+set\s+personal_owner_user_id/i);

    const baseline = fs.readFileSync(path.join(RAIZ, "supabase", "baseline.sql"), "utf8");
    expect(baseline).toContain("add column if not exists personal_owner_user_id uuid");
    expect(baseline).toContain("idx_contacts_org_personal_dono");
  });
});
