/**
 * Um PostgREST de mentira, em memória, com o pedaço do query builder do
 * `@supabase/supabase-js` que o OAuth por contato usa — para os testes de
 * `oauth-por-contato.test.ts` exercitarem as gravações CONDICIONAIS de verdade
 * (`usado_em is null`, `versao = <lida>`), que é onde mora a segurança do
 * `state` de uso único e da renovação concorrente. Só para teste.
 */
import { randomUUID } from "node:crypto";

type Linha = Record<string, unknown>;
type Filtro = (l: Linha) => boolean;

export interface BancoEmMemoria {
  tabelas: Record<string, Linha[]>;
  cliente: unknown;
}

const EMBEDS: Record<string, { tabela: string; chave: string }> = {
  contacts: { tabela: "contacts", chave: "contact_id" },
  ai_agent_mcp_servers: { tabela: "ai_agent_mcp_servers", chave: "servidor_id" },
};

export function bancoEmMemoria(inicial: Record<string, Linha[]> = {}): BancoEmMemoria {
  const tabelas: Record<string, Linha[]> = {};
  for (const [t, linhas] of Object.entries(inicial)) tabelas[t] = linhas.map((l) => ({ ...l }));

  function from(tabela: string) {
    tabelas[tabela] ??= [];
    const filtros: Filtro[] = [];
    let operacao: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let colunas = "*";
    let devolver = false;
    let payload: Linha | Linha[] | null = null;
    let conflito: string[] = [];
    let limite: number | null = null;
    let contar = false;

    function embutir(l: Linha): Linha {
      const out = { ...l };
      for (const [nome, e] of Object.entries(EMBEDS)) {
        if (colunas.includes(`${nome}(`)) {
          out[nome] = (tabelas[e.tabela] ?? []).find((x) => x.id === l[e.chave]) ?? null;
        }
      }
      return out;
    }

    function executar(): { data: unknown; error: null; count?: number } {
      const linhas = tabelas[tabela]!;
      const alvo = () => linhas.filter((l) => filtros.every((f) => f(l)));
      switch (operacao) {
        case "select": {
          let r = alvo().map(embutir);
          if (limite !== null) r = r.slice(0, limite);
          return { data: r, error: null };
        }
        case "insert": {
          const novas = (Array.isArray(payload) ? payload : [payload!]).map((p) => ({
            id: randomUUID(),
            created_at: new Date().toISOString(),
            ...p,
          }));
          linhas.push(...novas);
          return { data: devolver ? novas : null, error: null };
        }
        case "upsert": {
          const p = payload as Linha;
          const existente = linhas.find((l) => conflito.every((c) => l[c] === p[c]));
          if (existente) Object.assign(existente, p);
          else linhas.push({ id: randomUUID(), ...p });
          return { data: null, error: null };
        }
        case "update": {
          const r = alvo();
          for (const l of r) Object.assign(l, payload);
          return { data: devolver ? r.map(embutir) : null, error: null };
        }
        case "delete": {
          const r = alvo();
          tabelas[tabela] = linhas.filter((l) => !r.includes(l));
          return { data: devolver ? r : null, error: null, ...(contar ? { count: r.length } : {}) };
        }
      }
    }

    const b: Record<string, unknown> = {
      select(c = "*", _o?: unknown) {
        if (operacao === "select") colunas = c;
        else {
          devolver = true;
          colunas = c;
        }
        return b;
      },
      insert(p: Linha | Linha[]) {
        operacao = "insert";
        payload = p;
        return b;
      },
      update(p: Linha) {
        operacao = "update";
        payload = p;
        return b;
      },
      upsert(p: Linha, o?: { onConflict?: string }) {
        operacao = "upsert";
        payload = p;
        conflito = (o?.onConflict ?? "id").split(",");
        return b;
      },
      delete(o?: { count?: string }) {
        operacao = "delete";
        contar = Boolean(o?.count);
        return b;
      },
      eq(c: string, v: unknown) {
        filtros.push((l) => l[c] === v);
        return b;
      },
      in(c: string, v: readonly unknown[]) {
        filtros.push((l) => v.includes(l[c]));
        return b;
      },
      is(c: string, v: unknown) {
        filtros.push((l) => (l[c] ?? null) === v);
        return b;
      },
      gt(c: string, v: string) {
        filtros.push((l) => typeof l[c] === "string" && (l[c] as string) > v);
        return b;
      },
      lt(c: string, v: string) {
        filtros.push((l) => typeof l[c] === "string" && (l[c] as string) < v);
        return b;
      },
      lte(c: string, v: string) {
        filtros.push((l) => typeof l[c] === "string" && (l[c] as string) <= v);
        return b;
      },
      order() {
        return b;
      },
      limit(n: number) {
        limite = n;
        return b;
      },
      async maybeSingle() {
        const r = executar();
        const d = r.data as Linha[] | null;
        return { data: Array.isArray(d) ? (d[0] ?? null) : d, error: null };
      },
      then(ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) {
        return Promise.resolve(executar()).then(ok, erro);
      },
    };
    return b;
  }

  return { tabelas, cliente: { from } };
}
