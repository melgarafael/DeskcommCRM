import { describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";
import { CANAIS_DE_CONVERSA } from "@/lib/channels/canais-de-conversa";

/**
 * O QUE O BANCO ACEITA EM `conversations.channel` É O QUE O CATÁLOGO OFERECE.
 *
 * ## O defeito
 *
 * Duas listas precisavam concordar e nada as ligava: `SOCIAL_NETWORKS[].inbox`
 * (TypeScript) decide quem pode ter atendimento, e `conversations_channel_check`
 * (banco) decide o que a coluna aceita. A ingestão social grava a plataforma
 * **crua** na coluna.
 *
 * Marcar `inbox: true` numa rede nova é uma linha plausível: passa no
 * `typecheck`, passa no `lint`, passa no unitário — e morre no `update` com
 * `23514`. Como o provedor REENTREGA o webhook, vira 500 eterno, com a tela de
 * Conexões mostrando a conta ligada e a conversa nunca aparecendo.
 *
 * ## Por que este arquivo existe em vez de uma linha em
 * `vocabulario-banco-x-typescript`
 *
 * Aquele invariante extrai os literais do TEXTO do arquivo apontado. Aqui não
 * há literais: `CANAIS_DE_CONVERSA` é **derivado** do catálogo
 * (`SOCIAL_NETWORKS.filter(r => r.inbox)`), justamente para não existir uma
 * terceira lista para manter em sincronia — que é o defeito que o conserto mata.
 *
 * Tentei inscrever o par lá primeiro, e ele reprovou dizendo que o TypeScript
 * declarava só `whatsapp`: a sonda dele leu texto, e o valor real só existe em
 * tempo de execução. Seguir aquele formato exigiria recriar à mão a lista que o
 * conserto elimina.
 *
 * Então este arquivo **importa o módulo** e compara o VALOR com o CHECK real do
 * Postgres. É a mesma comparação, uma camada mais funda: mede o que o código
 * faz, não o que o arquivo diz.
 */

/** Os literais do CHECK de `conversations.channel`, lidos do catálogo do Postgres. */
function vocabularioNoBanco(): string[] {
  const saida = sql(`
    select pg_get_constraintdef(oid)
      from pg_constraint
     where conrelid = 'public.conversations'::regclass
       and conname = 'conversations_channel_check';
  `).trim();
  const literais = saida.match(/'([^']+)'::text/g) ?? [];
  return [...new Set(literais.map((l) => l.replace(/'|::text/g, "")))].sort();
}

describe("conversations.channel: banco × catálogo", () => {
  it("a sonda LÊ a constraint de verdade — sem isto, um vazio passaria por acordo", () => {
    // Controle da própria sonda. Se a constraint sumir ou mudar de nome, a
    // comparação abaixo viraria "[] === []" e ficaria verde sobre nada.
    expect(vocabularioNoBanco().length).toBeGreaterThan(0);
  });

  it("aceita exatamente os canais que o catálogo oferece", () => {
    const noBanco = vocabularioNoBanco();
    const noCodigo = [...CANAIS_DE_CONVERSA].sort();

    expect(
      noBanco,
      "divergência entre o CHECK e o catálogo.\n" +
        `  banco aceita: ${noBanco.join(", ")}\n` +
        `  catálogo oferece: ${noCodigo.join(", ")}\n` +
        "Rede com `inbox: true` que o banco não conhece = 23514 num webhook que o " +
        "provedor reentrega, ou seja 500 eterno. Rede no banco que o catálogo não " +
        "oferece = valor morto que ninguém consegue gravar.",
    ).toEqual(noCodigo);
  });
});
