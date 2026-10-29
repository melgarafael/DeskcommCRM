import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const raiz = process.cwd();
const ler = (p: string) => readFileSync(join(raiz, p), "utf8");

/** Todo `.ts` sob um diretório, recursivo, em caminho relativo à raiz. */
function arquivosTs(dir: string): string[] {
  const achados: string[] = [];
  for (const entrada of readdirSync(join(raiz, dir), { withFileTypes: true })) {
    const caminho = `${dir}/${entrada.name}`;
    if (entrada.isDirectory()) achados.push(...arquivosTs(caminho));
    else if (entrada.name.endsWith(".ts") || entrada.name.endsWith(".tsx")) achados.push(caminho);
  }
  return achados;
}

/**
 * TRÊS DESENCONTROS EM SÉRIE, E CADA UM ZERAVA O RESULTADO SOZINHO.
 *
 * Medido numa instalação real: integração `healthy`, 8 webhooks assinados,
 * 879 produtos na loja, ZERO no acervo do agente. O modo de falha é mudo —
 * conexão saudável, auditoria limpa, nenhum erro em lugar nenhum.
 *
 * 1. o webhook de produto emitia um nome que ninguém escutava;
 * 2. o indexador procurava a loja por um status que o CHECK da tabela nem
 *    aceita, então nunca achava credencial;
 * 3. a carga inicial não existia: sem `product_id` a função devolvia `[]`.
 *
 * São cercas de FORMA (leem o fonte), e não de comportamento: o caminho real
 * atravessa webhook assinado, fila, worker e API externa. Uma cerca que lê o
 * código não prova que o catálogo chega, mas prova que nenhum dos três voltou —
 * e os três voltam calados, que é o que os torna perigosos.
 */
describe("o catálogo da loja chega ao acervo", () => {
  it("⭐ o webhook de produto emite o evento que o indexador escuta", () => {
    const webhook = ler("app/api/v1/webhooks/nuvemshop/[event]/route.ts");
    const handler = ler("workers/rag-indexer.handler.ts");

    expect(webhook).toContain('"nuvemshop.product_synced"');
    // E o ouvinte continua escutando esse mesmo nome.
    expect(handler).toContain("nuvemshop.product_synced");
  });

  it("⭐ o payload de produto leva `product_id`, que é o campo que o worker lê", () => {
    const webhook = ler("app/api/v1/webhooks/nuvemshop/[event]/route.ts");
    const worker = ler("workers/rag-indexer.ts");

    expect(webhook).toContain("product_id: String(");
    expect(worker).toContain('row.payload["product_id"]');
  });

  it("⭐ o indexador procura a loja por um status que a tabela aceita", () => {
    const worker = ler("workers/rag-indexer.ts");
    expect(worker).toContain('.eq("status", "healthy")');
    // `active` nunca esteve no CHECK de tenant_integrations: connecting,
    // healthy, token_expired, scope_missing, disconnected, rate_limited, error.
    expect(worker).not.toContain('.eq("status", "active")');
  });

  it("⭐ a conexão dispara a carga inicial, e o worker sabe recebê-la", () => {
    const callback = ler("app/api/v1/integrations/nuvemshop/callback/route.ts");
    const worker = ler("workers/rag-indexer.ts");

    expect(callback).toContain("catalogo_inteiro: true");
    expect(worker).toContain('row.payload["catalogo_inteiro"]');
    // E sem produto específico ela lista a loja, em vez de devolver vazio.
    expect(worker).toContain("listarCatalogoDaLoja");
  });

  it("CONTROLE — a listagem é paginada e tem teto", () => {
    // Sem teto, um catálogo grande vira laço no worker; sem paginação, só as
    // primeiras 200 peças entram e o resto some sem aviso.
    const worker = ler("workers/rag-indexer.ts");
    expect(worker).toMatch(/per_page=200&page=\$\{pagina\}/);
    expect(worker).toMatch(/pagina <= TETO_DE_PAGINAS/);
  });

  it("CONTROLE — evento sem produto e sem a marca de carga continua recusado", () => {
    // A porta nova não pode virar porta escancarada: evento vazio ainda é
    // evento vazio, e precisa continuar saindo com motivo.
    const worker = ler("workers/rag-indexer.ts");
    expect(worker).toContain('return { fonte: null, motivo: "evento_sem_product_id" }');
  });
  /**
   * As três cercas abaixo nasceram de uma revisão que achou DOIS P0 com os
   * testes anteriores no verde. É o motivo de elas existirem: cerca que lê
   * string no arquivo não alcança comportamento.
   */

  it("⭐ a credencial é decifrada com o argumento que a função tem", () => {
    const worker = ler("workers/rag-indexer.ts");
    // `fn_decrypt_oauth(ciphertext bytea)` — um argumento. Pedia-se
    // `p_organization_id`/`p_integration_id`, que não existem em assinatura
    // nenhuma: a credencial voltava nula e o catálogo ficava vazio em silêncio.
    expect(worker).toContain('rpc("fn_decrypt_oauth", {');
    expect(worker).toContain("ciphertext: cifrado");
    // `p_integration_id:` com dois-pontos é sintaxe de objeto: o comentário
    // que explica o bug pode citar o nome, a CHAMADA não pode usá-lo.
    expect(worker).not.toContain("p_integration_id:");
    // E o select precisa trazer o que vai ser decifrado.
    expect(worker).toContain("oauth_access_token_encrypted");
  });

  // Esta cerca já nasceu mentindo uma vez: dizia "em workers/" e lia UM
  // arquivo. Agora varre o diretório inteiro — e a varredura de verdade achou
  // 11 ocorrências onde um `grep` de uma linha mostrava 6, porque em metade
  // delas o `as never` cai na linha seguinte ao nome da RPC.
  //
  // O `rag-indexer` tem de ficar em ZERO. As outras 11 são dívida anterior a
  // esta PR (`ai-response`, `ai-sentiment`, `lgpd-export`, `lgpd-redact`,
  // `media-persist`); o teto existe para que não apareça a décima segunda, e
  // é `<=` para que consertar as antigas não reprove ninguém.
  it("⭐ nenhum `rpc(... as never)` NOVO em workers/ — foi ele que escondeu o bug do compilador", () => {
    const padrao = /rpc\(\s*"[^"]+"\s*as never/g;
    const contagem = arquivosTs("workers").map(
      (f) => [f, (ler(f).match(padrao) ?? []).length] as const,
    );

    expect(contagem.find(([f]) => f === "workers/rag-indexer.ts")?.[1]).toBe(0);

    const total = contagem.reduce((soma, [, n]) => soma + n, 0);
    const onde = contagem.filter(([, n]) => n > 0).map(([f, n]) => `${f}:${n}`);
    expect(total, `herdados: ${onde.join(", ")}`).toBeLessThanOrEqual(11);
  });

  // O `as never` escondeu o compilador, mas o erro em si era no NOME do
  // argumento: a função decifra por `ciphertext` e a chamada mandava
  // `p_organization_id`/`p_integration_id`. Isso vale no repo todo.
  it("⭐ `fn_decrypt_oauth` é sempre chamada com `ciphertext`", () => {
    // só CHAMADAS: `fn_decrypt_oauth` também aparece em comentário.
    const chamada = /rpc\(\s*"fn_decrypt_oauth"[\s\S]{0,200}/g;
    const trechos = [...arquivosTs("workers"), ...arquivosTs("lib")].flatMap((f) =>
      (ler(f).match(chamada) ?? []).map((t) => [f, t] as const),
    );

    expect(trechos.length).toBeGreaterThan(0);
    for (const [arquivo, trecho] of trechos) {
      expect(trecho, `${arquivo}: argumento errado em fn_decrypt_oauth`).toContain("ciphertext");
    }
  });

  // A versão criada é ATIVADA e desliga a anterior, e a busca só enxerga a
  // ativa: publicar uma versão com um produto apagaria a loja do acervo.
  //
  // A primeira versão desta cerca procurava a grafia do bug e passava verde
  // quando o mesmo bug voltava escrito de outro jeito. Agora mede a FORMA:
  // não existe caminho que leve um produto avulso à indexação.
  it("⭐ o catálogo indexado é SEMPRE a loja inteira — não há caminho para um produto só", () => {
    const worker = ler("workers/rag-indexer.ts");

    // 1. quem monta os pedaços do catálogo recebe só a fonte. Um segundo
    //    parâmetro é exatamente a porta pela qual o bug entrou.
    const assinatura = worker.match(/async function pedacosDeCatalogo\(([^)]*)\)/);
    expect(assinatura?.[1]?.trim()).toBe("fonte: FonteRow");

    // 2. e o que ela indexa vem inteiro da listagem da loja, sem filtro.
    const todas = worker.split(/\r?\n/);
    const abre = todas.findIndex((l) => l.startsWith("async function pedacosDeCatalogo"));
    const fecha = todas.findIndex((l, i) => i > abre && l === "}");
    const corpo = todas.slice(abre, fecha).join(" ");
    expect(corpo).toContain("const produtos = await listarCatalogoDaLoja(fonte.organization_id);");

    // 3. e ninguém no worker sabe buscar um produto avulso na loja.
    expect(worker).not.toContain("buscarProdutoNaLoja");
    expect(worker).not.toMatch(/`\/products\/\$\{/);
  });

  it("⭐ listagem incompleta FALHA em vez de publicar catálogo pela metade", () => {
    const worker = ler("workers/rag-indexer.ts");
    // Página que falha sobe erro (o drain reagenda); teto atingido com página
    // cheia também. O que não pode é truncado virar versão ativa: o
    // `content_hash` do truncado faz a carga seguinte ser pulada por
    // "sem_mudanca", e aí ninguém mais percebe.
    expect(worker).toContain("catálogo incompleto: página");
    expect(worker).toContain("catálogo maior que o teto desta carga");
    expect(worker).not.toMatch(/console\.warn\([^)]*página do catálogo falhou[\s\S]{0,200}break;/);
  });

  it("CONTROLE — o teto é baixo de propósito, por causa do reaper de 10 minutos", () => {
    const worker = ler("workers/rag-indexer.ts");
    expect(worker).toContain("const TETO_DE_PAGINAS = 10;");
    // 50 páginas (10 mil produtos) passariam da janela do drain e dariam dois
    // workers na mesma fonte, com embedding pago em dobro.
    expect(worker).not.toMatch(/pagina <= 50/);
  });
});
