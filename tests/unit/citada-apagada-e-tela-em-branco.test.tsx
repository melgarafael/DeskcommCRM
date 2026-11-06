import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { colunasDoCelular } from "@/components/inbox/InboxLayout";
import { MessageBubble } from "@/components/inbox/MessageBubble";
import type { Message } from "@/lib/types/messaging";

/**
 * DOIS DEFEITOS DA CITAÇÃO, achados medindo o PR #305 antes do merge.
 *
 * Este arquivo prova COMPORTAMENTO — renderiza e lê o que apareceu na tela.
 * O irmão `responder-citando-no-toque.test.ts` casa CLASSES no fonte, e é
 * honesto sobre o que isso não prova; aqui a pergunta é outra e tem resposta
 * observável, então a resposta é observada.
 */

function msg(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    organization_id: "o1",
    conversation_id: "c1",
    channel_session_id: "s1",
    contact_id: "ct1",
    external_id: null,
    type: "text",
    direction: "inbound",
    status: "delivered",
    ack: null,
    error_code: null,
    error_message: null,
    body: "o segredo que o cliente apagou",
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: null,
    sent_by_user_id: null,
    sent_at: "2026-08-21T12:00:00.000Z",
    delivered_at: null,
    read_at: null,
    metadata: null,
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: "2026-08-21T12:00:00.000Z",
    ...over,
  } as Message;
}

describe("a citação de uma mensagem APAGADA não devolve o texto", () => {
  /**
   * O "apagar para todos" some com o texto da bolha original — a própria
   * `MessageBubble` já fazia isso, com o motivo escrito ali: "mostrá-lo seria
   * expor justamente o que o cliente pediu para tirar do ar".
   *
   * A citação é o MESMO texto, num segundo lugar da tela. Sem tratar o caso, o
   * cliente apagava e o conteúdo continuava legível dentro de cada resposta que
   * o tivesse citado — a proteção valia num lugar e não no outro.
   */
  it("mostra o aviso no lugar do conteúdo", () => {
    render(
      <MessageBubble
        message={msg({ id: "m2", direction: "outbound", body: "claro, já resolvo" })}
        citada={msg({ revoked_at: "2026-08-21T12:05:00.000Z" })}
      />,
    );
    expect(screen.queryByText(/segredo que o cliente apagou/)).toBeNull();
    // Duas ocorrências seria a bolha principal também apagada; aqui só a citada.
    expect(screen.getAllByText("Esta mensagem foi apagada")).toHaveLength(1);
  });

  it("CONTROLE: a citada viva continua aparecendo", () => {
    // Sem este caso, apagar o texto de TODA citação passaria no teste acima e
    // mataria a feature inteira — o gate ficaria verde pelo motivo errado.
    render(
      <MessageBubble
        message={msg({ id: "m2", direction: "outbound", body: "claro, já resolvo" })}
        citada={msg()}
      />,
    );
    expect(screen.getByText("o segredo que o cliente apagou")).toBeInTheDocument();
    expect(screen.queryByText("Esta mensagem foi apagada")).toBeNull();
  });

  it("a resposta em si continua legível — o fio some, a resposta não", () => {
    render(
      <MessageBubble
        message={msg({ id: "m2", direction: "outbound", body: "claro, já resolvo" })}
        citada={msg({ revoked_at: "2026-08-21T12:05:00.000Z" })}
      />,
    );
    expect(screen.getByText("claro, já resolvo")).toBeInTheDocument();
  });
});

/**
 * A TELA EM BRANCO DO CELULAR.
 *
 * A regra é invariante, não gosto: abaixo do `md` cabe UMA coluna, e uma tem de
 * aparecer. "Nenhuma das duas" é o defeito, e ele existia porque as duas
 * decidiam por dados diferentes — a lista pelo id, a conversa pelo objeto já
 * carregado. Este bloco cobre os dois estados possíveis, não um caso feliz.
 */
/**
 * O que o navegador aplica abaixo do `md`: as classes sem prefixo e as com
 * `max-md:` (sem o prefixo); as demais variantes não valem. `invisible` conta
 * como escondida — é como a lista sai da frente sem perder a rolagem.
 */
function visivelNoCelular(classes: string): boolean {
  const abaixoDoMd = classes
    .split(/\s+/)
    .flatMap((c) => (c.startsWith("max-md:") ? [c.slice("max-md:".length)] : c.includes(":") ? [] : [c]));
  return abaixoDoMd.includes("flex") && !abaixoDoMd.includes("hidden") && !abaixoDoMd.includes("invisible");
}

describe("no celular sempre há exatamente UMA coluna na tela", () => {
  it.each([
    ["sem conversa escolhida", false],
    ["com conversa escolhida", true],
  ])("%s", (_nome, temSelecao) => {
    const { lista, conversa } = colunasDoCelular(temSelecao);
    const naTela = [visivelNoCelular(lista), visivelNoCelular(conversa)].filter(Boolean);
    expect(naTela, "as duas escondidas é a tela branca; as duas visíveis é o empilhado").toHaveLength(1);
  });

  it("escolhida a conversa, quem aparece é ELA", () => {
    // Sem este caso, inverter as duas passaria no invariante acima — o gate
    // ficaria verde com a lista aberta em cima de uma conversa aberta.
    const { lista, conversa } = colunasDoCelular(true);
    expect(visivelNoCelular(conversa)).toBe(true);
    expect(visivelNoCelular(lista)).toBe(false);
  });

  it("no desktop as duas convivem — a regra é só do celular", () => {
    for (const temSelecao of [false, true]) {
      const { lista, conversa } = colunasDoCelular(temSelecao);
      for (const c of [lista, conversa]) {
        expect(c.split(/\s+/).includes("hidden") ? c : `${c} md:flex`).toContain("md:flex");
        // Camada e invisibilidade valem SÓ abaixo do `md`: sem prefixo, o
        // computador ganharia uma conversa por cima da lista.
        const semPrefixo = c.split(/\s+/).filter((x) => !x.includes(":"));
        expect(semPrefixo).not.toContain("fixed");
        expect(semPrefixo).not.toContain("invisible");
      }
    }
  });

  it("escolhida a conversa, ela vira camada de tela cheia acima das barras e abaixo das faixas", () => {
    // z-45: acima da barra de abas (z-40) e do TopBar (z-20), abaixo das
    // faixas de cima e dos portais Radix (z-50). O topo desconta as faixas —
    // o aviso de canal caído é o único sinal de que nada entra nem sai.
    const { conversa } = colunasDoCelular(true);
    const classes = conversa.split(/\s+/);
    expect(classes).toContain("max-md:fixed");
    expect(classes).toContain("max-md:inset-x-0");
    expect(classes).toContain("max-md:z-[45]");
    expect(conversa).toContain("max-md:top-[max(var(--vv-topo,0px),var(--faixas-de-cima,0px))]");
    expect(conversa).toMatch(/max-md:h-\[calc\(var\(--vv-topo,0px\)\+var\(--vv-altura,100dvh\)-/);
    expect(classes).toContain("max-md:pb-[env(safe-area-inset-bottom)]");
    // Com o teclado aberto o indicador de home não está na tela.
    expect(classes).toContain("max-md:data-[teclado-aberto]:pb-0");
  });
});
