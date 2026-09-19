import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { CANAIS_DE_CONVERSA, ehCanalDeConversa } from "@/lib/channels/canais-de-conversa";
import { SOCIAL_NETWORKS } from "@/lib/channels/social/catalog";

/**
 * LIGAR UMA REDE NOVA NÃO PODE VIRAR 500 ETERNO.
 *
 * ## As duas listas que precisavam concordar, e nada as ligava
 *
 *   1. `SOCIAL_NETWORKS[].inbox` (TypeScript) — quem pode ter atendimento.
 *   2. `conversations_channel_check` (banco) — o que a coluna aceita.
 *
 * `lib/channels/zernio/ingest.ts` grava a plataforma **crua** na coluna. Marcar
 * `inbox: true` numa rede nova é UMA LINHA plausível, passa por todo o
 * TypeScript, e morre no banco com `23514`.
 *
 * O que torna isso grave não é o erro: é que o provedor **reentrega** o
 * webhook. Cada reentrega dá 500 outra vez, para sempre — com a tela de
 * Conexões mostrando a conta ligada e a conversa nunca aparecendo. Quem instalou
 * não tem como saber o que aconteceu.
 *
 * ## Onde a guarda de verdade mora
 *
 * No invariante `vocabulario-banco-x-typescript`, que compara o CHECK REAL do
 * Postgres com `CANAIS_DE_CONVERSA`. Este arquivo cobre o que aquele não pode
 * cobrir sem banco: que o símbolo é DERIVADO (e não uma terceira lista escrita à
 * mão) e que o caminho de ingestão recusa em vez de estourar.
 */

const RAIZ = path.resolve(__dirname, "../..");

/**
 * Tira comentários antes de casar.
 *
 * Isto não é zelo: a primeira versão deste arquivo reprovou porque o COMENTÁRIO
 * de `canais-de-conversa.ts` cita as redes por nome ao explicar o defeito. A
 * sonda leu prosa e chamou de código — a terceira vez que isso acontece hoje
 * neste PR, e a segunda em que a vítima é quem escreveu a sonda.
 *
 * O conserto certo é este, e não escrever prosa contorcida: quem mede o texto é
 * dono do cuidado de separar código de comentário. Quem escreve o comentário só
 * paga a conta.
 */
function semComentarios(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((linha) => !linha.trim().startsWith("//"))
    .join("\n");
}

describe("o vocabulário do canal é derivado, não copiado", () => {
  it("toda rede com `inbox: true` está em CANAIS_DE_CONVERSA", () => {
    for (const rede of SOCIAL_NETWORKS.filter((r) => r.inbox)) {
      expect(
        (CANAIS_DE_CONVERSA as readonly string[]).includes(rede.id),
        `${rede.id} tem inbox no catálogo e não é canal de conversa`,
      ).toBe(true);
    }
  });

  it("nenhuma rede SEM inbox entrou na lista", () => {
    for (const rede of SOCIAL_NETWORKS.filter((r) => !r.inbox)) {
      expect(
        (CANAIS_DE_CONVERSA as readonly string[]).includes(rede.id),
        `${rede.id} não tem inbox e mesmo assim é canal de conversa`,
      ).toBe(false);
    }
  });

  it("`whatsapp` está lá — é o membro que não vem do catálogo social", () => {
    expect(CANAIS_DE_CONVERSA).toContain("whatsapp");
  });

  it("a lista é DERIVADA do catálogo, não escrita à mão", () => {
    // Uma lista literal aqui seria a TERCEIRA a manter em sincronia, que é o
    // defeito que este módulo existe para matar — uma camada acima.
    const fonte = fs.readFileSync(path.join(RAIZ, "lib/channels/canais-de-conversa.ts"), "utf8");
    expect(semComentarios(fonte)).toMatch(/SOCIAL_NETWORKS\.filter\(/);
    expect(
      /"instagram"|"facebook"/.test(semComentarios(fonte)),
      "a lista voltou a transcrever os nomes das redes em vez de derivá-los",
    ).toBe(false);
  });
});

describe("a ingestão recusa rede que o banco não conhece", () => {
  const ingest = fs.readFileSync(path.join(RAIZ, "lib/channels/zernio/ingest.ts"), "utf8");

  it("os DOIS pontos que gravam o canal passam pela guarda", () => {
    // São dois ramos (conversa existente e conversa nova). Guardar só um deixa
    // o outro estourando — e o que estoura é justamente o caminho menos
    // exercitado, que é onde este tipo de defeito mora.
    const gravacoes = ingest.match(/\.update\(\{ channel: input\.socialMessage\.platform \}\)/g) ?? [];
    const guardas = ingest.match(/!ehCanalDeConversa\(input\.socialMessage\.platform\)/g) ?? [];
    expect(gravacoes.length).toBeGreaterThan(0);
    expect(guardas.length).toBe(gravacoes.length);
  });

  it("a recusa DEIXA RASTRO, com o nome da rede e o que falta", () => {
    // Recusar em silêncio trocaria o 500 eterno por uma conversa que nunca
    // aparece e ninguém sabe por quê — o mesmo desfecho, sem o sintoma.
    expect(ingest).toMatch(/logger\.error\("zernio: rede sem canal correspondente no banco/);
    expect(ingest).toMatch(/platform: input\.socialMessage\.platform/);
    expect(ingest).toMatch(/falta o valor no CHECK de conversations\.channel/);
  });
});

describe("a função de guarda", () => {
  it("aceita o que o banco aceita e recusa o resto", () => {
    expect(ehCanalDeConversa("whatsapp")).toBe(true);
    expect(ehCanalDeConversa("instagram")).toBe(true);
    // Uma rede que existe no catálogo mas NÃO tem inbox.
    expect(ehCanalDeConversa("linkedin")).toBe(false);
    expect(ehCanalDeConversa("rede-que-nao-existe")).toBe(false);
    expect(ehCanalDeConversa(null)).toBe(false);
    expect(ehCanalDeConversa(undefined)).toBe(false);
  });
});
