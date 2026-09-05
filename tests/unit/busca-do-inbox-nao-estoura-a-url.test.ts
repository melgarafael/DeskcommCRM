import fs from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

/**
 * A BUSCA DO INBOX NÃO PODE ESTOURAR A URL DO POSTGREST.
 *
 * ─── O defeito que este arquivo existe para impedir ──────────────────────────
 * O PR #507 fez a busca casar contatos por nome e telefone, e os ids casados
 * viajam DENTRO da querystring do GET seguinte:
 *
 *     or=(last_message_preview.ilike.*ana*,contact_id.in.(<uuid>,<uuid>,…))
 *
 * O teto escolhido foi 200 ids. Medido com o `postgrest-js` real e as
 * `SELECT_COLS` do próprio handler, 200 ids produzem **8.653 bytes** de URL — e
 * o muro do gateway é **8.192**. Kong 2.8.1, que a Supabase põe na frente do
 * PostgREST e que o stack local deste repo sobe, devolve `414 URI too long` a
 * partir de ~187 ids.
 *
 * O `error` daquela consulta é checado e vira `500 internal_error`. Ou seja:
 * buscar "ana" ou "silva" numa base de milhares de contatos — exatamente a base
 * que justifica o recurso — **derrubava o Inbox**, a tela onde o operador passa
 * o dia. Não era degradação; era a tela parando. E o mesmo handler serve a tool
 * MCP `lib/mcp/tools/conversations.ts`, então o agente recebia o mesmo 500.
 *
 * ─── Por que este teste mede BYTES e não lê a constante ──────────────────────
 * Ler `TETO_DE_CONTATOS_NA_BUSCA` e comparar com um número seria presença de
 * símbolo lida como comportamento: uma coluna nova em `SELECT_COLS`, um id em
 * formato diferente, ou um filtro a mais empurram a URL para cima sem ninguém
 * tocar na constante. Aqui a URL é **construída pelo `postgrest-js` de verdade**,
 * com as colunas lidas do fonte, e medida.
 */

const RAIZ = process.cwd();
const HANDLER = path.join(RAIZ, "app", "api", "v1", "conversations", "_handler.ts");

/** O muro real: Kong e nginx, ambos no default, cortam a linha de requisição aqui. */
const MURO_DO_GATEWAY = 8_192;

function fonteDoHandler(): string {
  return fs.readFileSync(HANDLER, "utf8");
}

function lerNumero(nome: string): number {
  const m = new RegExp(`${nome} = ([\\d_]+)`).exec(fonteDoHandler());
  if (!m) throw new Error(`não achei ${nome} no handler — o gate ficou cego`);
  return Number(m[1]!.replace(/_/g, ""));
}

/** As colunas REAIS, lidas do fonte: inventá-las mediria outra requisição. */
function selectCols(): string {
  const m = /const SELECT_COLS = `([\s\S]*?)`/.exec(fonteDoHandler());
  if (!m) throw new Error("não achei SELECT_COLS no handler — o gate ficou cego");
  return m[1]!;
}

const uuid = (i: number) => `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`;

/** Constrói a URL que o handler produziria para `n` ids, com o postgrest-js real. */
async function urlDaBusca(n: number): Promise<string> {
  let capturada = "";
  const sb = createClient("http://127.0.0.1:54321", "x".repeat(200), {
    global: {
      fetch: async (u: RequestInfo | URL) => {
        capturada = String(u);
        throw new Error("interrompido de propósito — só queremos a URL");
      },
    },
  });
  const ids = Array.from({ length: n }, (_, i) => uuid(i));
  try {
    await sb
      .from("conversations")
      .select(selectCols())
      .eq("organization_id", uuid(999))
      .or(`last_message_preview.ilike.*ana*,contact_id.in.(${ids.join(",")})`)
      .order("last_message_at", { ascending: false })
      .limit(31);
  } catch {
    /* esperado: o fetch dublê sempre lança depois de capturar */
  }
  return capturada;
}

describe("a busca do Inbox não estoura a URL do PostgREST", () => {
  it("a sonda constrói a URL de verdade — controle positivo", async () => {
    // Sem isto, um postgrest-js que mudasse de forma devolveria string vazia e
    // todo o resto passaria por medir zero.
    const u = await urlDaBusca(3);
    expect(u, "a URL não foi capturada — a sonda está cega").toContain("/rest/v1/conversations");
    expect(u).toContain("contact_id.in.");
    expect(u.length).toBeGreaterThan(500);
  });

  it("a sonda ENXERGA o estouro quando ele existe — controle positivo", async () => {
    // O caso que o #507 tinha: 200 ids. Se este caso deixar de estourar, o muro
    // mudou ou a URL encolheu, e o teste abaixo passou a medir folga demais.
    const u = await urlDaBusca(200);
    expect(
      u.length,
      "200 ids deixaram de estourar o muro — reveja o número, não apague o teste",
    ).toBeGreaterThan(MURO_DO_GATEWAY);
  });

  it("no teto configurado, a URL fica ABAIXO do muro do gateway", async () => {
    const teto = lerNumero("TETO_DE_CONTATOS_NA_BUSCA");
    const u = await urlDaBusca(teto);
    expect(
      u.length,
      `com ${teto} ids a URL tem ${u.length} B e o gateway corta em ${MURO_DO_GATEWAY} B. ` +
        "Kong devolve 414, o handler transforma em 500, e o Inbox para de abrir " +
        "numa busca por nome comum. Baixe TETO_DE_CONTATOS_NA_BUSCA.",
    ).toBeLessThan(MURO_DO_GATEWAY);
  });

  it("mesmo gastando o ORÇAMENTO inteiro de ids, a URL fica abaixo do muro", async () => {
    // O corte efetivo é o MENOR entre o teto de linhas e o orçamento de bytes.
    // Este caso cobre o dia em que alguém subir o teto sem mexer no orçamento.
    const orcamento = lerNumero("ORCAMENTO_DE_IDS_NA_URL");
    const cabem = Math.floor(orcamento / (uuid(0).length + 1));
    const u = await urlDaBusca(cabem);
    expect(
      u.length,
      `o orçamento de ${orcamento} B para ids permite ${cabem} deles, e a URL fica com ` +
        `${u.length} B — acima do muro de ${MURO_DO_GATEWAY} B`,
    ).toBeLessThan(MURO_DO_GATEWAY);
  });

  it("a busca continua funcionando quando há POUCOS contatos — o par do 'não faça X'", async () => {
    // Sem este caso, "nunca mande ids" satisfaria o teste e mataria o recurso:
    // a busca por nome e telefone que o #507 entregou deixaria de existir.
    // ⚠️ A URL vem PERCENT-ENCODED (`(` vira `%28`), então casar o parêntese
    // literal reprova por engano — foi o que aconteceu na primeira versão deste
    // caso. Decodificar antes é o que faz a sonda medir o conteúdo, não a
    // codificação.
    const u = decodeURIComponent(await urlDaBusca(3));
    expect(u, "os ids sumiram da URL — a busca por contato deixou de acontecer").toMatch(
      /contact_id\.in\.\(.*00000000-1111/,
    );
    expect(u, "a busca por conteúdo saiu junto").toContain("last_message_preview.ilike");
  });
});
