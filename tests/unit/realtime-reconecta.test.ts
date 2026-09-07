import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * O CANAL QUE CAIU TEM DE VOLTAR SOZINHO.
 *
 * ─── O defeito, relatado olhando a tela ─────────────────────────────────────
 *
 * "Às vezes preciso atualizar para a mensagem aparecer." Aconteceu com uma
 * mensagem mandada do próprio celular: ela chegou ao banco pelo webhook e não
 * apareceu na conversa aberta até o F5.
 *
 * ─── Três coisas somadas, e nenhuma delas gritava ──────────────────────────
 *
 * 1. O callback do `subscribe` ANOTAVA o estado e não fazia mais nada. Em
 *    `CHANNEL_ERROR`, `TIMED_OUT` ou `CLOSED` o canal ficava morto — e o efeito
 *    só re-roda quando a topologia muda, então nada o ressuscitava.
 * 2. `refetchOnWindowFocus` é `false` no padrão do repo (certo para o resto do
 *    app), então voltar para a aba também não buscava nada.
 * 3. O Realtime NÃO guarda o que passou enquanto o canal esteve fora. Mesmo
 *    reassinando, o evento perdido não chega — só o PRÓXIMO.
 *
 * Somadas: a única recuperação era a pessoa recarregar. Que foi o sintoma.
 *
 * ─── Por que canal NOVO, e não `subscribe()` de novo ───────────────────────
 *
 * Um canal que entrou em erro não volta: o socket derrubou a topologia dele, e
 * reassinar o mesmo objeto responde SUBSCRIBED sem nunca mais entregar. Morte
 * silenciosa — a mesma classe de defeito que a memo de auth deste arquivo já
 * tinha, e pela qual o cabeçalho dele já pagou.
 */

const FONTE = readFileSync("hooks/realtime/useRealtimeChannel.ts", "utf8");

describe("o canal volta sozinho", () => {
  it("uma falha AGENDA nova tentativa — antes só anotava o estado", () => {
    expect(FONTE).toMatch(/CHANNEL_ERROR" \|\| s === "TIMED_OUT" \|\| s === "CLOSED"/);
    expect(FONTE, "a falha não agenda retomada").toMatch(/retomada = setTimeout\(/);
  });

  it("com recuo exponencial e TETO — rajada contra socket caído piora tudo", () => {
    expect(FONTE).toMatch(/Math\.min\(30_000, 1_000 \* 2 \*\* tentativas\)/);
  });

  it("monta canal NOVO a cada tentativa", () => {
    // Reassinar o mesmo objeto devolve SUBSCRIBED e não entrega nada.
    expect(FONTE).toMatch(/supabase\.removeChannel\(active\);\s*\n\s*montar\(\);/);
    expect(FONTE).toMatch(/supabase\.channel\(`\$\{channelName\}#\$\{tentativas\}`\)/);
  });

  it("ao voltar, FORÇA uma busca — o que passou não chega sozinho", () => {
    // Esta é a parte que fecha o buraco de verdade. Sem ela o canal volta a
    // funcionar para o PRÓXIMO evento e a tela segue sem o anterior.
    expect(FONTE).toMatch(/handler\(\{ tipo: "reassinado" \}\)/);
  });

  it("só força quando VEIO de uma queda — a primeira assinatura não busca à toa", () => {
    expect(FONTE).toMatch(/if \(tentativas > 0\) \{/);
  });

  it("descarta o canal velho que responde tarde", () => {
    // Duas tentativas em voo: sem a comparação, a que chega atrasada
    // sobrescreve o estado da que já está de pé.
    // Dentro do callback do subscribe, não em qualquer lugar: a guarda também
    // existe no `then` da auth, e a primeira versão deste caso passava verde com
    // a do subscribe removida.
    expect(FONTE).toMatch(/novo\.subscribe\(\(s\) => \{\s*\n\s*if \(cancelado \|\| active !== novo\) return;/);
  });

  it("o timer é cancelado na saída — senão remonta canal de tela fechada", () => {
    // No CLEANUP, não no agendamento: a mesma linha existe nos dois lugares, e
    // a primeira versão deste caso passava com a do cleanup removida — que é
    // justamente a que impede remontar canal de tela já fechada.
    expect(FONTE).toMatch(/cancelado = true;\s*\n\s*if \(retomada\) clearTimeout\(retomada\);/);
  });
});

describe("o primeiro join aguarda a autenticação compartilhada", () => {
  it("não inventa timeout de auth nem assina anon em falha", () => {
    expect(FONTE).not.toMatch(/AUTH_TIMEOUT_MS/);
    expect(FONTE).toMatch(/await prepareRealtimeAuthentication\(\)/);
    expect(FONTE).toMatch(/if \(cancelado\) return;/);
  });
});

describe("a rede de segurança do inbox", () => {
  /**
   * O board e a linha do tempo já tinham; o inbox não. Com o canal morto e a
   * aba EM FOCO, `refetchOnWindowFocus` nunca dispara — e o inbox é a tela em
   * que se fica parado olhando. Ficava congelada até o F5, que foi o sintoma.
   */
  it("a lista de conversas tem rede, e devolve o sinal de perda", () => {
    const fonte = readFileSync("hooks/inbox/useConversationsRealtime.ts", "utf8");
    expect(fonte, "a lista ficou sem rede de segurança").toMatch(/useRefetchDeSeguranca</);
    expect(fonte, "o sinal de perda não sai do hook").toMatch(/return \{[^}]*\bseguranca\b[^}]*\}/);
  });

  it("a conversa aberta também", () => {
    const fonte = readFileSync("hooks/inbox/useMessagesRealtime.ts", "utf8");
    expect(fonte, "a conversa aberta ficou sem rede de segurança").toMatch(/useRefetchDeSeguranca</);
    expect(fonte, "o sinal de perda não sai do hook").toMatch(/return \{[^}]*\bseguranca\b[^}]*\}/);
  });

  it("o estado do canal chega à TELA — senão a morte dele segue invisível", () => {
    // O dossiê do lead já publicava este par; o inbox não publicava nada.
    // ⚠️ `data-realtime-status` tem de vir do STATUS do canal, não de um objeto
    // que existe sempre: a primeira versão desta linha diria `ativo` inclusive
    // com o canal morto — controle decorativo, que mente com cara de instrumento.
    const tela = readFileSync("components/inbox/InboxLayout.tsx", "utf8");
    expect(tela, "o inbox não publica o estado do canal").toMatch(
      /data-realtime-status=\{listQ\.realtimeStatus\}/,
    );
    expect(tela, "o inbox não publica a contagem de perdas").toMatch(
      /data-refetch-divergencias=\{listQ\.seguranca/,
    );
  });

  it("a rede consome o carimbo de entrega do canal — senão só sabe reprovar", () => {
    // Sem `ultimaEntrega`, divergência é indistinguível de "nada aconteceu no
    // intervalo": a verificação perde a capacidade de APROVAR.
    for (const f of ["hooks/inbox/useConversationsRealtime.ts", "hooks/inbox/useMessagesRealtime.ts"]) {
      const fonte = readFileSync(f, "utf8");
      expect(fonte, `${f} não passa ultimaEntrega para a rede`).toMatch(
        /const \{[^}]*\bultimaEntrega\b[^}]*\} = useRealtimeChannel\(/,
      );
    }
  });
});

describe("a segunda rede: voltar para a aba", () => {
  it("o hilo de mensagens ressincroniza ao focar", () => {
    const fonte = readFileSync("hooks/inbox/useMessagesRealtime.ts", "utf8");
    expect(fonte).toMatch(/refetchOnWindowFocus: true/);
  });

  it("a lista de conversas também", () => {
    const fonte = readFileSync("hooks/inbox/useConversationsRealtime.ts", "utf8");
    expect(fonte).toMatch(/refetchOnWindowFocus: true/);
  });

  it("useConversationsRealtime monta UMA vez na árvore do inbox — duplicar dobra refetch", () => {
    const layout = readFileSync("components/inbox/InboxLayout.tsx", "utf8");
    const lista = readFileSync("components/inbox/ConversationList.tsx", "utf8");
    expect(layout.match(/useConversationsRealtime\(/g)?.length).toBe(1);
    expect(lista).not.toMatch(/useConversationsRealtime\(/);
    expect(lista).toMatch(/listQuery/);
  });

  it("e o padrão GLOBAL segue desligado — isto é exceção, não virada de chave", () => {
    // Recarregar tudo a cada troca de aba é gasto sem retorno numa tela que
    // muda devagar. O inbox é o oposto, e só ele.
    const fonte = readFileSync("lib/query/client.ts", "utf8");
    expect(fonte).toMatch(/refetchOnWindowFocus: false/);
  });
});
