/**
 * A FILA DE CASOS ABRE COM MAIS DE 400 CONVERSAS COM CASO (#5255).
 *
 * ## O defeito que esta cerca fecha
 *
 * A tela Casos resolve primeiro quais conversas a sessão enxerga
 * (`conversasVisiveisDosCasos`) e manda esse conjunto de volta ao PostgREST três
 * vezes: no `.in("id", …)` de `conversations`, na lista e no contador
 * (`listarChamados`). O PostgREST devolve a query inteira no header
 * `Content-Location`, e o Node recusa header acima de 16 KB
 * (`UND_ERR_HEADERS_OVERFLOW`, que chega como "fetch failed"). Cada uuid pesa
 * 39 bytes na URL: medido em produção na 1.124.0, 405 conversas passam e 420
 * derrubam a rota num 500 — e a tela fica no esqueleto para sempre.
 *
 * A segunda parede vinha logo atrás: a leitura do universo (`agent_cases` sem
 * `.range()`) é cortada CALADA no `max_rows` do PostgREST (1.000). Passados mil
 * casos, casos visíveis sumiam da fila sem erro nenhum.
 *
 * O caminho do token (`contatoSeparado`) tinha o mesmo `.in()` sem lotes ao
 * juntar os contatos de todos os casos devolvidos.
 *
 * ## Onde a sonda olha
 *
 * O dublê imita os três limites do servidor de verdade: o teto do header (a
 * consulta falha com "fetch failed" quando os valores do `.in()` passam de
 * 16 KB), o `max_rows` (nenhuma resposta passa de 1.000 linhas) e a ordem
 * (`order` ordena, `range`/`limit` cortam). Um dublê sem esses limites ficaria
 * verde com o defeito inteiro no lugar.
 *
 * ## Comando
 *
 *     pnpm exec vitest run tests/unit/chamados-em-lotes.test.ts
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { conversasVisiveisDosCasos, listarChamados } from "@/lib/escalacao/chamados";
import { IDS_POR_LOTE } from "@/lib/supabase/em-lotes";

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";

/** O teto de header do Node (`--max-http-header-size`, padrão 16 KB). */
const TETO_DO_HEADER = 16 * 1024;
/** O resto da URL e dos headers da resposta, além dos valores do `.in()`. */
const RESTO_DA_RESPOSTA = 400;
/** `max_rows` do PostgREST (`supabase/config.toml`). */
const MAX_ROWS = 1000;

type Linha = Record<string, unknown>;

interface Consulta {
  tabela: string;
  ins: Array<[string, unknown[]]>;
}

/**
 * Dublê de PostgREST com os limites do servidor: filtra (`eq`/`in`), ordena,
 * corta (`range`/`limit`/`max_rows`) e falha quando a query não cabe no header.
 */
function bancoComTetos(tabelas: Record<string, Linha[]>) {
  const consultas: Consulta[] = [];

  function from(tabela: string) {
    const consulta: Consulta = { tabela, ins: [] };
    consultas.push(consulta);
    const eqs: Array<[string, unknown]> = [];
    const ordens: Array<[string, boolean]> = [];
    let contar = false;
    let soCabeca = false;
    let faixa: [number, number] | null = null;
    let limite: number | null = null;

    function resposta() {
      // O tamanho que a query ocupa no `Content-Location`: cada `.in()` vira
      // `col=in.(a,b,…)` codificado na URL.
      const bytes =
        RESTO_DA_RESPOSTA +
        consulta.ins.reduce(
          (soma, [coluna, valores]) =>
            soma + encodeURIComponent(`${coluna}=in.(${valores.join(",")})`).length,
          0,
        );
      if (bytes > TETO_DO_HEADER) {
        return { data: null, count: null, error: { message: "TypeError: fetch failed" } };
      }

      let linhas = (tabelas[tabela] ?? []).filter(
        (linha) =>
          eqs.every(([coluna, valor]) => linha[coluna] === valor) &&
          consulta.ins.every(([coluna, valores]) => valores.includes(linha[coluna])),
      );
      const total = linhas.length;
      if (ordens.length > 0) {
        linhas = [...linhas].sort((a, b) => {
          for (const [coluna, ascendente] of ordens) {
            const x = String(a[coluna]);
            const y = String(b[coluna]);
            if (x !== y) return (x < y ? -1 : 1) * (ascendente ? 1 : -1);
          }
          return 0;
        });
      }
      if (faixa) linhas = linhas.slice(faixa[0], faixa[1] + 1);
      if (limite !== null) linhas = linhas.slice(0, limite);
      linhas = linhas.slice(0, MAX_ROWS);
      return {
        data: soCabeca ? null : linhas,
        count: contar ? total : null,
        error: null,
      };
    }

    const cadeia = {
      select(_colunas: string, opts?: { count?: string; head?: boolean }) {
        contar = opts?.count === "exact";
        soCabeca = opts?.head === true;
        return cadeia;
      },
      eq(coluna: string, valor: unknown) {
        eqs.push([coluna, valor]);
        return cadeia;
      },
      in(coluna: string, valores: unknown[]) {
        consulta.ins.push([coluna, valores]);
        return cadeia;
      },
      order(coluna: string, opts?: { ascending?: boolean }) {
        ordens.push([coluna, opts?.ascending !== false]);
        return cadeia;
      },
      range(inicio: number, fim: number) {
        faixa = [inicio, fim];
        return cadeia;
      },
      limit(n: number) {
        limite = n;
        return cadeia;
      },
      then: (aceita: (valor: unknown) => unknown, rejeita?: (motivo: unknown) => unknown) =>
        Promise.resolve(resposta()).then(aceita, rejeita),
    };
    return cadeia;
  }

  return { cliente: { from } as unknown as SupabaseClient, consultas };
}

/** uuid v4 válido e determinístico a partir de um número. */
function uuid(prefixo: string, n: number): string {
  return `${prefixo}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const N_CONVERSAS = 1200;

/**
 * Uma organização como a do cliente que quebrou, com folga: 1.200 conversas,
 * cada uma com um caso; um terço deles aberto. A data de abertura NÃO segue a
 * ordem das conversas (passo 7919, primo com 1.200), para que a ordem global só
 * saia certa se a junção dos lotes reordenar.
 */
function organizacaoGrande() {
  const conversas: Linha[] = [];
  const contatos: Linha[] = [];
  const casos: Linha[] = [];
  for (let i = 0; i < N_CONVERSAS; i++) {
    const conversa = uuid("c0000000", i);
    const contato = uuid("e0000000", i);
    const minuto = (i * 7919) % N_CONVERSAS;
    conversas.push({ id: conversa, organization_id: ORG, contact_id: contato });
    contatos.push({ id: contato, organization_id: ORG, name: `Contato ${i}`, phone_number: `+55119${i}` });
    casos.push({
      id: uuid("ca000000", i),
      organization_id: ORG,
      title: `Caso ${i}`,
      summary: "s",
      blocker: "b",
      status: i % 3 === 0 ? "awaiting_human" : "resolved",
      kind: "outro",
      opened_at: new Date(Date.UTC(2026, 10, 1) + minuto * 60_000).toISOString(),
      conversation_id: conversa,
      conversations: { contacts: { name: `Contato ${i}`, phone_number: `+55119${i}` } },
    });
  }
  // A sessão de um atendente que não enxerga uma em cada dez conversas: é o
  // que `fn_can_view_conversation` faz numa organização em `visibility_mode = 'own'`.
  const visiveis = new Set<string>(
    conversas.filter((_, i) => i % 10 !== 0).map((c) => c.id as string),
  );
  const sessao = bancoComTetos({
    agent_cases: casos,
    conversations: conversas.filter((c) => visiveis.has(c.id as string)),
  });
  const admin = bancoComTetos({ agent_cases: casos, conversations: conversas, contacts: contatos });
  return { casos, visiveis, sessao, admin };
}

function esperado(
  casos: Linha[],
  visiveis: Set<string>,
  status: (s: string) => boolean,
): string[] {
  return casos
    .filter((c) => visiveis.has(c.conversation_id as string) && status(c.status as string))
    .sort((a, b) => (String(a.opened_at) < String(b.opened_at) ? 1 : -1))
    .map((c) => c.id as string);
}

const aberto = (s: string) => s === "awaiting_human" || s === "awaiting_lead";

describe("a fila de casos com 1.200 conversas com caso (#5255)", () => {
  it("a aba de abertos lista e conta, pelo caminho da tela", async () => {
    const { casos, visiveis, sessao, admin } = organizacaoGrande();

    const visiveisPara = await conversasVisiveisDosCasos(sessao.cliente, ORG, { estado: "abertos" });
    const { chamados, abertos } = await listarChamados(admin.cliente, ORG, {
      estado: "abertos",
      visiveisPara,
    });

    const ids = esperado(casos, visiveis, aberto);
    expect(chamados.map((c) => c.id)).toEqual(ids);
    expect(abertos).toBe(ids.length);
  });

  it("a aba de resolvidos lista todos os visíveis, mesmo com mais de 1.000 casos na organização", async () => {
    const { casos, visiveis, sessao, admin } = organizacaoGrande();

    const visiveisPara = await conversasVisiveisDosCasos(sessao.cliente, ORG, { estado: "fechados" });
    const { chamados, abertos } = await listarChamados(admin.cliente, ORG, {
      estado: "fechados",
      visiveisPara,
    });

    // 1.200 casos: a leitura do universo sem página parava nos 1.000 primeiros,
    // e os casos das conversas restantes sumiam da fila sem erro.
    expect(chamados.map((c) => c.id)).toEqual(esperado(casos, visiveis, (s) => !aberto(s)));
    expect(abertos).toBe(esperado(casos, visiveis, aberto).length);
  });

  it("nenhuma consulta leva mais ids do que um lote", async () => {
    const { sessao, admin } = organizacaoGrande();

    const visiveisPara = await conversasVisiveisDosCasos(sessao.cliente, ORG, { estado: "fechados" });
    await listarChamados(admin.cliente, ORG, { estado: "fechados", visiveisPara });

    const maiores = [...sessao.consultas, ...admin.consultas].flatMap((c) =>
      c.ins.filter(([coluna]) => coluna !== "status").map(([, valores]) => valores.length),
    );
    expect(maiores.length).toBeGreaterThan(0);
    expect(Math.max(...maiores)).toBeLessThanOrEqual(IDS_POR_LOTE);
  });

  it("a ordem e o limite valem para a fila inteira, não para cada lote", async () => {
    const { casos, visiveis, admin } = organizacaoGrande();

    const { chamados } = await listarChamados(admin.cliente, ORG, {
      estado: "abertos",
      limite: 20,
      visiveisPara: [...visiveis],
    });

    expect(chamados.map((c) => c.id)).toEqual(esperado(casos, visiveis, aberto).slice(0, 20));
  });

  it("pelo token, o contato de cada caso chega mesmo com centenas de conversas", async () => {
    const { casos, admin } = organizacaoGrande();

    const { chamados } = await listarChamados(admin.cliente, ORG, {
      estado: "fechados",
      visiveisPara: "todas",
      contatoSeparado: true,
    });

    const fechados = casos.filter((c) => !aberto(c.status as string));
    expect(chamados).toHaveLength(fechados.length);
    for (const chamado of chamados) {
      const i = Number.parseInt(chamado.conversation_id.slice(-12), 16);
      expect(chamado.contact_name).toBe(`Contato ${i}`);
    }
  });
});
