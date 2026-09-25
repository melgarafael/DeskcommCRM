import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * UMA RECUSA DE SEGURANÇA TEM DE DEIXAR RASTRO DE SI MESMA.
 *
 * ## O defeito
 *
 * Na rota do webhook de canal, a recusa por assinatura saía com `return` ANTES
 * de o arquivo do webhook ser aberto:
 *
 *   1. `verifyInboundWebhookSignature(...)` falha → `return fail(401)`
 *   2. ...e só DEPOIS vinha `abrirArquivoDoWebhook(...)`
 *
 * Duas consequências, e a segunda é pior que a primeira:
 *
 *   - o payload recusado não era arquivado em lugar nenhum, e nada era logado;
 *   - o ramo que grava `valid_signature: false` (lá embaixo, no desfecho do
 *     `handleInboundWebhook`) ficava **inalcançável**, porque a única recusa por
 *     assinatura já tinha saído antes dele. A coluna existia, a tela de entradas
 *     automáticas a lia (`lib/operacao/entradas-automaticas.ts`), e ela nunca
 *     podia ser `false`.
 *
 * Uma recusa que não deixa rastro é pior que não ter a recusa: ninguém descobre
 * que está sendo tentada. E quem chega a esse ponto já apresentou o TOKEN certo
 * da instalação e errou só o SEGREDO — não é ruído de internet, é alguém com
 * metade das credenciais.
 *
 * ## Por que teste de estrutura, e não de execução
 *
 * O defeito é de ORDEM — quem vem antes de quem. A rota depende de Supabase,
 * cifra e verificação de assinatura; montar tudo isso num unitário mediria os
 * duplos, não a ordem. O que fixa o defeito é a posição relativa das chamadas,
 * e é isso que este arquivo trava.
 */

const ROTA = path.resolve(__dirname, "../../app/api/v1/webhooks/channel/[token]/route.ts");

function fonte(): string {
  return fs.readFileSync(ROTA, "utf8");
}

/** Posição da primeira ocorrência, ou -1. */
function onde(texto: string, agulha: string | RegExp): number {
  if (typeof agulha === "string") return texto.indexOf(agulha);
  return texto.search(agulha);
}

describe("a recusa por assinatura é arquivada e logada", () => {
  it("o arquivo é aberto ANTES da conferência de assinatura", () => {
    // Este é o defeito, na sua forma mais crua: uma linha depois da outra.
    const s = fonte();
    const abertura = onde(s, "await abrirArquivoDoWebhook(");
    const conferencia = onde(s, "if (!verifyInboundWebhookSignature(");
    expect(abertura).toBeGreaterThan(-1);
    expect(conferencia).toBeGreaterThan(-1);
    expect(
      abertura,
      "a conferência de assinatura voltou a acontecer antes do arquivo: a recusa sai sem rastro",
    ).toBeLessThan(conferencia);
  });

  it("o ramo de assinatura inválida grava `valid_signature: false`", () => {
    // Sem isto, a coluna nunca poderia ser `false` — a tela de entradas
    // automáticas mostraria "sem informação" para todo webhook recusado.
    const s = fonte();
    const bloco = s.slice(
      onde(s, "if (!verifyInboundWebhookSignature("),
      onde(s, 'return fail("unauthorized", "bad_signature"'),
    );
    expect(bloco).toMatch(/fecharArquivoDoWebhook\(/);
    expect(bloco).toMatch(/validSignature:\s*false/);
    expect(bloco).toMatch(/erro:\s*"bad_signature"/);
  });

  it("e deixa uma linha de log, que é onde quem opera olha primeiro", () => {
    const s = fonte();
    const inicio = onde(s, 'logger.warn("[webhook-canal] assinatura recusada"');
    expect(inicio, "a recusa por assinatura não loga nada").toBeGreaterThan(-1);
    // SÓ o objeto do log. A primeira versão recortava a partir do `if`, e o
    // `if` passa `rawBody` para a verificação — a asserção "não loga o corpo"
    // reprovava por causa do ARGUMENTO da conferência, não do log.
    const objeto = s.slice(inicio, s.indexOf("});", inicio) + 3);
    // Ponteiros que permitem achar a conexão...
    expect(objeto).toMatch(/channel_session_id:/);
    expect(objeto).toMatch(/organization_id:/);
    // ...e NÃO o corpo: ele já está no arquivo, e duplicá-lo no log espalharia
    // payload de terceiro por um destino que costuma ir para fora da máquina.
    expect(objeto).not.toMatch(/rawBody/);
  });
});

describe("o outro lado: assinatura BOA não pode ser marcada como inválida", () => {
  it("evento de outra conta fecha com `validSignature: true`", () => {
    // O segredo está certo; o evento é que é de outra conta. Marcar `false`
    // aqui mandaria quem investiga procurar um problema de segredo que não
    // existe — e é o erro que o comentário do arquivador já avisava.
    const s = fonte();
    const bloco = s.slice(
      onde(s, "if (!await inboundPayloadBelongsToSession("),
      onde(s, 'reason: "evento_de_outra_conta" }, { requestId })'),
    );
    expect(bloco).toMatch(/validSignature:\s*true/);
    expect(bloco).toMatch(/erro:\s*"evento_de_outra_conta"/);
  });

  it("todo caminho de saída depois do arquivo o fecha", () => {
    // Uma linha aberta e nunca fechada fica `received` para sempre, e some da
    // contagem de quem for auditar o que aconteceu com aquele webhook.
    const s = fonte();
    const depoisDoArquivo = s.slice(onde(s, "await abrirArquivoDoWebhook("));
    const saidas = (depoisDoArquivo.match(/return (fail|ok)\(/g) ?? []).length;
    const fechamentos = (depoisDoArquivo.match(/await fecharArquivoDoWebhook\(/g) ?? []).length;
    expect(saidas).toBeGreaterThan(0);
    expect(
      fechamentos,
      `${saidas} saídas depois do arquivo e só ${fechamentos} fechamentos: alguma linha fica 'received' para sempre`,
    ).toBe(saidas);
  });
});
