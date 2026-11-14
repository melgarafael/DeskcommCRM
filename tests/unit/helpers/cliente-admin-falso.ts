/**
 * CLIENTE ADMIN FALSO, POR ORGANIZAÇÃO (Spec 33, fatias R).
 *
 * No ramo do token, `resolveAuthDual` entrega `createAdminClient()`: a service
 * role, que contorna a RLS por desenho. O que protege a organização ali é o
 * filtro de `organization_id` que a rota escreve à mão, vindo da linha do token
 * — e um teste de handler com um dublê que devolve a mesma linha para qualquer
 * consulta não vê a falta dele.
 *
 * Este dublê vê. Ele guarda linhas de mais de uma organização, aplica os
 * filtros que a rota escreveu e registra cada cadeia (tabela, operação,
 * filtros, payload), cada RPC e cada arquivo. Uma cadeia de tabela com
 * `organization_id` que não filtra a organização não alcança linha nenhuma:
 * a rota responde como se o recurso não existisse, e o teste "token de A
 * alcança o recurso de A" fica vermelho. `cadeiasForaDaOrganizacao` aponta
 * qual foi.
 *
 * Método que o dublê não conhece LANÇA ao ser chamado, com o nome dele: quem
 * precisar estende o dublê no mesmo PR, em vez de o teste passar por um
 * caminho que não mediu nada.
 */
import { randomUUID } from "node:crypto";

export type OperacaoDaCadeia = "select" | "insert" | "update" | "upsert" | "delete";

export type CadeiaRegistrada = {
  tabela: string;
  operacao: OperacaoDaCadeia;
  filtros: Array<[coluna: string, valor: unknown]>;
  payload?: unknown;
};

export type RpcRegistrada = { nome: string; args: Record<string, unknown> };

export type ArquivoRegistrado = { bucket: string; caminho: string; operacao: string };

export type OpcoesDoFalso = {
  orgDona: string;
  linhas?: Record<string, Record<string, unknown>[]>;
  /** valor = o `data` devolvido; se for função, ela recebe os args e devolve `{ data, error }`. */
  rpc?: Record<string, unknown>;
  /** tabelas SEM a coluna organization_id (conferidas no supabase/baseline.sql). */
  tabelasSemOrganizacao?: readonly string[];
};

type Linha = Record<string, unknown>;
type Condicao = (linha: Linha) => boolean;
type Resultado = { data: unknown; error: unknown; count: number | null; status: number };

type Contexto = {
  linhas: Record<string, Linha[]>;
  semOrganizacao: ReadonlySet<string>;
  cadeias: CadeiaRegistrada[];
  rpcs: RpcRegistrada[];
  uploads: ArquivoRegistrado[];
  rpc: Record<string, unknown>;
};

const ERRO_DE_UMA_LINHA = {
  code: "PGRST116",
  message: "a consulta não devolveu exatamente uma linha (cliente falso)",
};

/**
 * Chaves que bibliotecas de teste e o próprio `await` consultam por inspeção.
 * Devolvem `undefined` em vez de lançar: `then` num objeto que não é thenable
 * faria o `await` chamar a função que lança.
 */
const CHAVES_DE_INSPECAO = new Set([
  "then",
  "toJSON",
  "asymmetricMatch",
  "$$typeof",
  "nodeType",
  "tagName",
  "constructor",
  "inspect",
  "@@__IMMUTABLE_ITERABLE__@@",
  "@@__IMMUTABLE_RECORD__@@",
  "_isMockFunction",
]);

/** O que o objeto não implementa lança ao ser CHAMADO, com o nome do método. */
function blindar<T extends object>(alvo: T, onde: string): T {
  return new Proxy(alvo, {
    get(obj, prop, receptor) {
      if (typeof prop === "symbol" || prop in obj) return Reflect.get(obj, prop, receptor);
      if (CHAVES_DE_INSPECAO.has(prop)) return undefined;
      return () => {
        throw new Error(`método ${prop} não suportado pelo cliente falso (${onde})`);
      };
    },
  });
}

function igual(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

function comparar(a: unknown, b: unknown): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

class Cadeia {
  private readonly condicoes: Condicao[] = [];
  private operacao: OperacaoDaCadeia | null = null;
  private payload: unknown = undefined;
  private devolveLinhas = false;
  private contagem: { head: boolean } | null = null;
  private modo: "lista" | "single" | "maybeSingle" = "lista";
  private limite: number | null = null;
  private intervalo: [number, number] | null = null;
  private filtraOrganizacao = false;
  private resultado: Promise<Resultado> | null = null;

  constructor(
    private readonly ctx: Contexto,
    private readonly tabela: string,
    private readonly registro: CadeiaRegistrada,
  ) {}

  private definir(operacao: OperacaoDaCadeia, payload?: unknown): this {
    if (this.operacao === null) {
      this.operacao = operacao;
      this.registro.operacao = operacao;
      if (payload !== undefined) {
        this.payload = payload;
        this.registro.payload = payload;
      }
    } else {
      this.devolveLinhas = true;
    }
    return this;
  }

  select(_colunas?: string, opcoes?: { count?: string; head?: boolean }): this {
    if (opcoes?.count) this.contagem = { head: opcoes.head === true };
    return this.definir("select");
  }
  insert(payload: unknown, _opcoes?: unknown): this {
    return this.definir("insert", payload);
  }
  upsert(payload: unknown, _opcoes?: unknown): this {
    return this.definir("upsert", payload);
  }
  update(payload: unknown, _opcoes?: unknown): this {
    return this.definir("update", payload);
  }
  delete(_opcoes?: unknown): this {
    return this.definir("delete");
  }

  private filtrar(coluna: string, valor: unknown, condicao: Condicao | null): this {
    this.registro.filtros.push([coluna, valor]);
    if (condicao) this.condicoes.push(condicao);
    return this;
  }

  eq(coluna: string, valor: unknown): this {
    if (coluna === "organization_id" || (this.tabela === "organizations" && coluna === "id")) {
      this.filtraOrganizacao = true;
    }
    return this.filtrar(coluna, valor, (l) => igual(l[coluna], valor));
  }
  neq(coluna: string, valor: unknown): this {
    return this.filtrar(coluna, valor, (l) => !igual(l[coluna], valor));
  }
  in(coluna: string, valores: readonly unknown[]): this {
    return this.filtrar(coluna, valores, (l) => valores.some((v) => igual(l[coluna], v)));
  }
  is(coluna: string, valor: unknown): this {
    return this.filtrar(coluna, valor, (l) =>
      valor === null ? l[coluna] === null || l[coluna] === undefined : l[coluna] === valor,
    );
  }
  match(valores: Record<string, unknown>): this {
    for (const [coluna, valor] of Object.entries(valores)) this.eq(coluna, valor);
    return this;
  }
  gt(coluna: string, valor: unknown): this {
    return this.filtrar(coluna, valor, (l) => (comparar(l[coluna], valor) ?? 0) > 0 && l[coluna] != null);
  }
  gte(coluna: string, valor: unknown): this {
    return this.filtrar(coluna, valor, (l) => l[coluna] != null && (comparar(l[coluna], valor) ?? -1) >= 0);
  }
  lt(coluna: string, valor: unknown): this {
    return this.filtrar(coluna, valor, (l) => l[coluna] != null && (comparar(l[coluna], valor) ?? 0) < 0);
  }
  lte(coluna: string, valor: unknown): this {
    return this.filtrar(coluna, valor, (l) => l[coluna] != null && (comparar(l[coluna], valor) ?? 1) <= 0);
  }

  // Registrados, não aplicados: a semântica deles não muda a pergunta do dublê
  // (a cadeia filtra a organização?), e imitá-los mal daria falso verde.
  like(coluna: string, valor: unknown): this {
    return this.filtrar(coluna, valor, null);
  }
  ilike(coluna: string, valor: unknown): this {
    return this.filtrar(coluna, valor, null);
  }
  contains(coluna: string, valor: unknown): this {
    return this.filtrar(coluna, valor, null);
  }
  containedBy(coluna: string, valor: unknown): this {
    return this.filtrar(coluna, valor, null);
  }
  overlaps(coluna: string, valor: unknown): this {
    return this.filtrar(coluna, valor, null);
  }
  textSearch(coluna: string, valor: unknown, _opcoes?: unknown): this {
    return this.filtrar(coluna, valor, null);
  }
  filter(coluna: string, operador: string, valor: unknown): this {
    return this.filtrar(coluna, `${operador}.${String(valor)}`, null);
  }
  not(coluna: string, operador: string, valor: unknown): this {
    return this.filtrar(coluna, { not: [operador, valor] }, null);
  }
  or(expressao: string, _opcoes?: unknown): this {
    return this.filtrar("or", expressao, null);
  }

  order(_coluna?: string, _opcoes?: unknown): this {
    return this;
  }
  returns(): this {
    return this;
  }
  overrideTypes(): this {
    return this;
  }
  abortSignal(_sinal?: unknown): this {
    return this;
  }
  throwOnError(): this {
    return this;
  }
  limit(n: number, _opcoes?: unknown): this {
    this.limite = n;
    return this;
  }
  range(de: number, ate: number, _opcoes?: unknown): this {
    this.intervalo = [de, ate];
    return this;
  }
  single(): this {
    this.modo = "single";
    return this;
  }
  maybeSingle(): this {
    this.modo = "maybeSingle";
    return this;
  }

  then<A = Resultado, B = never>(
    aoCumprir?: ((valor: Resultado) => A | PromiseLike<A>) | null,
    aoFalhar?: ((motivo: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    this.resultado ??= Promise.resolve().then(() => this.executar());
    return this.resultado.then(aoCumprir, aoFalhar);
  }

  private tabelaViva(): Linha[] {
    return (this.ctx.linhas[this.tabela] ??= []);
  }

  /** Regra 4: sem `eq("organization_id", …)`, tabela com a coluna não alcança linha. */
  private alcancadas(): Linha[] {
    if (!this.ctx.semOrganizacao.has(this.tabela) && !this.filtraOrganizacao) return [];
    return this.tabelaViva().filter((l) => this.condicoes.every((c) => c(l)));
  }

  private gravar(substituir: boolean): Linha[] {
    const payloads = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Linha[];
    const viva = this.tabelaViva();
    return payloads.map((p) => {
      const existente = substituir && p.id != null ? viva.find((l) => igual(l.id, p.id)) : undefined;
      if (existente) return Object.assign(existente, p);
      const linha: Linha = { ...p, id: p.id ?? randomUUID(), created_at: p.created_at ?? new Date().toISOString() };
      viva.push(linha);
      return linha;
    });
  }

  private executar(): Resultado {
    let linhas: Linha[] = [];
    let total = 0;
    switch (this.operacao ?? "select") {
      case "select": {
        linhas = this.alcancadas();
        total = linhas.length;
        if (this.intervalo) linhas = linhas.slice(this.intervalo[0], this.intervalo[1] + 1);
        if (this.limite !== null) linhas = linhas.slice(0, this.limite);
        if (this.contagem?.head) return { data: null, error: null, count: total, status: 200 };
        this.devolveLinhas = true;
        break;
      }
      case "insert":
        linhas = this.gravar(false);
        break;
      case "upsert":
        linhas = this.gravar(true);
        break;
      case "update":
        linhas = this.alcancadas().map((l) => Object.assign(l, this.payload as Linha));
        break;
      case "delete": {
        linhas = this.alcancadas();
        const viva = this.tabelaViva();
        for (const l of linhas) viva.splice(viva.indexOf(l), 1);
        break;
      }
    }
    if (this.operacao !== "select" && this.operacao !== null) total = linhas.length;
    const copias = linhas.map((l) => ({ ...l }));
    const count = this.contagem ? total : null;
    if (this.modo === "lista") {
      return { data: this.devolveLinhas ? copias : null, error: null, count, status: 200 };
    }
    if (copias.length === 1) return { data: copias[0], error: null, count, status: 200 };
    if (copias.length === 0 && this.modo === "maybeSingle") return { data: null, error: null, count, status: 200 };
    return { data: null, error: ERRO_DE_UMA_LINHA, count, status: 406 };
  }
}

class ChamadaRpc {
  private resultado: Promise<Resultado> | null = null;
  constructor(
    private readonly ctx: Contexto,
    private readonly nome: string,
    private readonly args: Record<string, unknown>,
  ) {}

  select(): this {
    return this;
  }
  eq(): this {
    return this;
  }
  order(): this {
    return this;
  }
  limit(): this {
    return this;
  }
  returns(): this {
    return this;
  }
  overrideTypes(): this {
    return this;
  }
  abortSignal(): this {
    return this;
  }
  throwOnError(): this {
    return this;
  }
  single(): this {
    return this;
  }
  maybeSingle(): this {
    return this;
  }

  then<A = Resultado, B = never>(
    aoCumprir?: ((valor: Resultado) => A | PromiseLike<A>) | null,
    aoFalhar?: ((motivo: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    this.resultado ??= Promise.resolve().then(() => {
      const valor = this.ctx.rpc[this.nome];
      if (typeof valor === "function") {
        const r = (valor as (args: Record<string, unknown>) => { data?: unknown; error?: unknown })(this.args);
        return { data: r?.data ?? null, error: r?.error ?? null, count: null, status: r?.error ? 400 : 200 };
      }
      return { data: valor ?? null, error: null, count: null, status: 200 };
    });
    return this.resultado.then(aoCumprir, aoFalhar);
  }
}

function balde(ctx: Contexto, bucket: string) {
  const registrar = (caminho: string, operacao: string) =>
    ctx.uploads.push({ bucket, caminho, operacao });
  const url = (caminho: string) => `https://falso.local/${bucket}/${caminho}`;
  return blindar(
    {
      async upload(caminho: string, _corpo?: unknown, _opcoes?: unknown) {
        registrar(caminho, "upload");
        return { data: { path: caminho, id: randomUUID(), fullPath: `${bucket}/${caminho}` }, error: null };
      },
      async download(caminho: string, _opcoes?: unknown) {
        registrar(caminho, "download");
        return { data: new Blob([new Uint8Array([1, 2, 3])]), error: null };
      },
      async remove(caminhos: string[]) {
        for (const c of caminhos) registrar(c, "remove");
        return { data: caminhos.map((name) => ({ name })), error: null };
      },
      async createSignedUrl(caminho: string, _segundos?: number, _opcoes?: unknown) {
        registrar(caminho, "createSignedUrl");
        return { data: { signedUrl: url(caminho) }, error: null };
      },
      async createSignedUrls(caminhos: string[], _segundos?: number, _opcoes?: unknown) {
        for (const c of caminhos) registrar(c, "createSignedUrls");
        return { data: caminhos.map((path) => ({ path, signedUrl: url(path), error: null })), error: null };
      },
      async createSignedUploadUrl(caminho: string, _opcoes?: unknown) {
        registrar(caminho, "createSignedUploadUrl");
        return { data: { signedUrl: url(caminho), token: "falso", path: caminho }, error: null };
      },
      getPublicUrl(caminho: string, _opcoes?: unknown) {
        registrar(caminho, "getPublicUrl");
        return { data: { publicUrl: url(caminho) } };
      },
      async list(prefixo?: string, _opcoes?: unknown) {
        registrar(prefixo ?? "", "list");
        return { data: [], error: null };
      },
      async move(origem: string, destino: string) {
        registrar(origem, "move");
        registrar(destino, "move");
        return { data: { message: "ok" }, error: null };
      },
      async copy(origem: string, destino: string) {
        registrar(origem, "copy");
        registrar(destino, "copy");
        return { data: { path: destino }, error: null };
      },
    },
    `storage.from("${bucket}")`,
  );
}

export function criarClienteAdminFalso(opts: OpcoesDoFalso): {
  cliente: unknown;
  cadeias: CadeiaRegistrada[];
  rpcs: RpcRegistrada[];
  uploads: ArquivoRegistrado[];
  /** As linhas vivas, por tabela: o que a rota gravou aparece aqui. */
  linhas: Record<string, Record<string, unknown>[]>;
} {
  const linhas: Record<string, Linha[]> = {};
  for (const [tabela, lista] of Object.entries(opts.linhas ?? {})) linhas[tabela] = lista.map((l) => ({ ...l }));
  const ctx: Contexto = {
    linhas,
    semOrganizacao: new Set(opts.tabelasSemOrganizacao ?? []),
    cadeias: [],
    rpcs: [],
    uploads: [],
    rpc: opts.rpc ?? {},
  };
  const cliente = blindar(
    {
      from(tabela: string) {
        const registro: CadeiaRegistrada = { tabela, operacao: "select", filtros: [] };
        ctx.cadeias.push(registro);
        return blindar(new Cadeia(ctx, tabela, registro), `from("${tabela}")`);
      },
      rpc(nome: string, args: Record<string, unknown> = {}, _opcoes?: unknown) {
        ctx.rpcs.push({ nome, args: { ...args } });
        return blindar(new ChamadaRpc(ctx, nome, args), `rpc("${nome}")`);
      },
      storage: blindar({ from: (bucket: string) => balde(ctx, bucket) }, "storage"),
      auth: blindar({ admin: blindar({}, "auth.admin") }, "auth"),
    },
    "cliente",
  );
  return { cliente, cadeias: ctx.cadeias, rpcs: ctx.rpcs, uploads: ctx.uploads, linhas };
}

/**
 * Cadeias que não ficaram dentro de `org`:
 * - `select`/`update`/`delete` de tabela com a coluna sem `["organization_id", org]` nos filtros
 *   (`organizations`: `["id", org]`);
 * - `insert`/`upsert` com alguma linha cujo `organization_id` não é `org`;
 * - `update` cujo payload troca `organization_id` para outro valor.
 */
export function cadeiasForaDaOrganizacao(
  cadeias: CadeiaRegistrada[],
  org: string,
  opcoes?: { tabelasSemOrganizacao?: readonly string[] },
): CadeiaRegistrada[] {
  const semOrganizacao = new Set(opcoes?.tabelasSemOrganizacao ?? []);
  const filtra = (c: CadeiaRegistrada, coluna: string) =>
    c.filtros.some(([col, valor]) => col === coluna && igual(valor, org));
  return cadeias.filter((c) => {
    if (semOrganizacao.has(c.tabela)) return false;
    if (c.operacao === "insert" || c.operacao === "upsert") {
      const payloads = (Array.isArray(c.payload) ? c.payload : [c.payload]) as Linha[];
      return payloads.some((p) => !p || !igual(p.organization_id, org));
    }
    if (c.operacao === "update") {
      const p = c.payload as Linha | undefined;
      if (p && "organization_id" in p && !igual(p.organization_id, org)) return true;
    }
    return !filtra(c, c.tabela === "organizations" ? "id" : "organization_id");
  });
}

export function cadeiasDeEscrita(cadeias: CadeiaRegistrada[]): CadeiaRegistrada[] {
  return cadeias.filter((c) => c.operacao !== "select");
}

const CHAVES_DE_ORGANIZACAO = ["p_org", "p_org_id", "p_organization_id", "organization_id"];

/** Nome de toda RPC que recebeu uma organização diferente de `org`. */
export function rpcsForaDaOrganizacao(rpcs: RpcRegistrada[], org: string): string[] {
  return rpcs
    .filter((r) =>
      CHAVES_DE_ORGANIZACAO.some((k) => r.args[k] !== undefined && r.args[k] !== null && !igual(r.args[k], org)),
    )
    .map((r) => r.nome);
}

/** Todo arquivo cujo caminho não tem `org` como um dos segmentos. */
export function arquivosForaDaOrganizacao(uploads: ArquivoRegistrado[], org: string): ArquivoRegistrado[] {
  return uploads.filter((u) => !u.caminho.split("/").includes(org));
}
