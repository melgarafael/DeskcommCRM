/**
 * TELA QUE ASSINA REALTIME NUMA TABELA FORA DA PUBLICAÇÃO NUNCA RECEBE EVENTO —
 * E NÃO DÁ ERRO NENHUM.
 *
 * ## O modo de falha, e por que ele desperdiça o tempo de quem investiga
 *
 * `postgres_changes` só entrega evento de tabela que está na publicação
 * `supabase_realtime`. Se a tabela não estiver:
 *
 *   - o canal SOBE,
 *   - o `subscribe()` devolve **SUBSCRIBED**,
 *   - `data-realtime-status` fica **subscribed** na tela,
 *   - e nenhum evento chega. Nunca.
 *
 * A tela só muda quando alguém recarrega — indistinguível de "ninguém fez nada".
 *
 * O agravante é que esta base JÁ tem um caso conhecido de canal que morre calado
 * por OUTRO motivo (o cookie `httpOnly` que faz o socket virar anônimo). Quem
 * ligar realtime numa tabela nova e não receber evento vai direto para o
 * `setAuth` e o token do socket — o lugar certo para o defeito errado, e uma
 * tarde perdida. Este teste responde a pergunta em milissegundos.
 *
 * ## O que ele mede
 *
 * As tabelas assinadas no código (`table: "x"` nos filtros de `postgres_changes`)
 * contra a publicação **do `baseline.sql`** — e não das migrations. O baseline é
 * o que a instalação self-host aplica; uma tabela adicionada só em migration não
 * chega a quem instalou do zero, que é a maioria.
 *
 * ## A dívida que ele congela, medida ao nascer
 *
 * Seis assinaturas já estavam fora da publicação quando este arquivo foi escrito.
 * Elas entram como dívida CONHECIDA, com o nome de cada uma — e não como
 * exceção silenciosa. Gate que nasce vermelho não é adotado; gate que nasce
 * verde por ignorar o passado não protege. O meio-termo é este: congela o que
 * existe, barra o que chegar.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();

/**
 * As seis que já estavam assim. Cada uma é um realtime que não funciona hoje —
 * a lista é para elas NÃO crescerem, não para elas ficarem.
 */
const DIVIDA_CONHECIDA: Record<string, string> = {
  channel_sessions: "assinada por hooks de canal; entrou antes deste gate",
  contacts: "assinada pela ficha do contato; entrou antes deste gate",
  conversation_notes: "assinada por hooks/inbox/useConversationNotes.ts; entrou antes deste gate",
  crm_pipelines: "assinada pela tela de funis; entrou antes deste gate",
  system_update_runs: "assinada pela tela de atualização; entrou antes deste gate",
  system_version: "assinada pela tela de atualização; entrou antes deste gate",
};

function publicacaoDoBaseline(): Set<string> {
  const sql = readFileSync(path.join(RAIZ, "supabase/baseline.sql"), "utf8");
  const dentro = new Set<string>();

  // O baseline é aplicado INTEIRO e EM ORDEM. O dump traz o primeiro
  // `foreach t in array array[...]` e o apêndice traz mais cinco lotes, aplicados
  // um atrás do outro; os add/drop avulsos entram na posição em que aparecem no
  // arquivo. Ancorar no PRIMEIRO lote mede a publicação morta: media 12 tabelas
  // onde o arquivo instala 29 (medido em 20/09/2026 — ver CLAUDE.md, item 10).
  const eventos: { idx: number; lote?: string; op?: string; tabela?: string }[] = [];
  for (const m of sql.matchAll(/foreach\s+t\s+in\s+array\s+array\[(.*?)\]/gs))
    eventos.push({ idx: m.index ?? 0, lote: m[1]! });
  for (const m of sql.matchAll(
    /alter publication supabase_realtime (add|drop) table public\.(\w+)/g,
  ))
    eventos.push({ idx: m.index ?? 0, op: m[1]!, tabela: m[2]! });
  eventos.sort((a, b) => a.idx - b.idx);

  for (const e of eventos) {
    if (e.lote !== undefined) {
      // `alter publication ... add table` dentro do laço é montado por `format()`,
      // então o nome da tabela só existe no literal do array.
      for (const t of e.lote.matchAll(/'([a-z_]+)'/g)) dentro.add(t[1]!);
    } else if (e.op === "drop") {
      dentro.delete(e.tabela!);
    } else {
      dentro.add(e.tabela!);
    }
  }
  return dentro;
}

function assinadasNoCodigo(): Map<string, string[]> {
  const achadas = new Map<string, string[]>();
  const varrer = (dir: string) => {
    for (const entrada of readdirSync(dir)) {
      if (entrada === "node_modules" || entrada.startsWith(".")) continue;
      const completo = path.join(dir, entrada);
      if (statSync(completo).isDirectory()) varrer(completo);
      else if (/\.tsx?$/.test(entrada)) {
        const fonte = readFileSync(completo, "utf8");
        // só conta quando há `postgres_changes` no mesmo arquivo: `table:` sozinho
        // aparece em consulta comum e viraria falso positivo.
        if (!fonte.includes("postgres_changes")) continue;
        for (const m of fonte.matchAll(/table:\s*"([a-z_]+)"/g)) {
          const rel = path.relative(RAIZ, completo);
          achadas.set(m[1]!, [...(achadas.get(m[1]!) ?? []), rel]);
        }
      }
    }
  };
  for (const raiz of ["hooks", "components", "app", "lib"]) varrer(path.join(RAIZ, raiz));
  return achadas;
}

describe("realtime: assinatura sem publicação nunca recebe evento", () => {
  const publicacao = publicacaoDoBaseline();
  const assinadas = assinadasNoCodigo();

  it("a varredura enxerga as duas pontas (senão o verde não vale)", () => {
    // Controle de instrumento: se o baseline mudar de forma ou o padrão de
    // assinatura mudar, um dos dois vira zero e o gate passaria a aprovar tudo.
    expect(publicacao.size, "publicação vazia: o extrator do baseline quebrou").toBeGreaterThan(5);
    expect(assinadas.size, "nenhuma assinatura achada: o extrator do código quebrou").toBeGreaterThan(3);
  });

  it("nenhuma assinatura NOVA aponta para tabela fora da publicação", () => {
    const fora: string[] = [];
    for (const [tabela, arquivos] of assinadas) {
      if (publicacao.has(tabela)) continue;
      if (DIVIDA_CONHECIDA[tabela]) continue;
      fora.push(`${tabela} — assinada em ${arquivos.join(", ")}`);
    }
    expect(
      fora,
      "Esta tela assina uma tabela que NÃO está na publicação `supabase_realtime` do " +
        "baseline.sql. O canal vai subir, o subscribe vai devolver SUBSCRIBED, e " +
        "nenhum evento chega nunca — a tela só muda no reload. Acrescente a tabela " +
        "à publicação numa migration E no apêndice do baseline.",
    ).toEqual([]);
  });

  it("a dívida conhecida não guarda tabela que já foi consertada", () => {
    // Se alguém acrescentar uma delas à publicação, a entrada aqui vira mentira
    // — e uma lista de dívida com item quitado ensina a não confiar nela.
    const quitadas = Object.keys(DIVIDA_CONHECIDA).filter((t) => publicacao.has(t));
    expect(quitadas, "já estão na publicação: tire da lista de dívida").toEqual([]);
  });

  it("toda dívida explica onde está", () => {
    for (const [t, motivo] of Object.entries(DIVIDA_CONHECIDA)) {
      expect(motivo.length, `${t} sem motivo escrito`).toBeGreaterThan(20);
    }
  });
});
