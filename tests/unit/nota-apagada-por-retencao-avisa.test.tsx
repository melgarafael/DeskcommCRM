/**
 * A NOTA QUE PERDEU O ANEXO POR PRAZO PRECISA AVISAR (issue #3756).
 *
 * ## O defeito, medido antes de codar
 *
 * A mensagem que perdeu a mídia pela política de retenção tem aviso desde a
 * 0557 (#1534): `fn_enfileirar_midia_vencida` grava `metadata.media_status =
 * 'expired'` (mais `media_expired_at` e `media_retention_days`) e a bolha
 * renderiza "Mídia apagada pela política de retenção" no lugar do arquivo
 * (`components/inbox/MessageBubble.tsx`).
 *
 * A nota interna ganhou retenção por idade na 0572 (#1887, passo 2c) e o mesmo
 * caminho apaga `media_storage_path`, `media_mime` e `media_size_bytes` — SEM
 * deixar marca nenhuma. Como `NoteMedia` devolve `null` quando não há caminho,
 * a nota que perdeu o anexo fica idêntica a uma nota que nunca teve: o operador
 * lê o texto e não sabe que ali havia um arquivo. Estava declarado no próprio
 * CHANGELOG ("A nota continua lá, com o texto, mas **sem aviso** de que teve um
 * anexo") e é o que esta issue fecha.
 *
 * ## O que este arquivo mede
 *
 * Comportamento observado (renderiza e lê o que apareceu) e o rastro no SQL que
 * a tela lê — porque `test:db` não roda nesta frente e um teste de componente
 * sozinho ficaria verde com um banco que nunca grava a marca.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageBubble } from "@/components/inbox/MessageBubble";
import { NoteCard } from "@/components/inbox/NoteCard";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Message, Note } from "@/lib/types/messaging";

const RAIZ = join(process.cwd(), "supabase");
const COM_DIAS = "Anexo da nota apagado pela política de retenção ({n} dias)";
const GENERICO = "Anexo da nota apagado pela política de retenção.";

function nota(over: Partial<Note> = {}): Note {
  return {
    id: "n1",
    conversation_id: "c1",
    body: "o cliente pediu o orçamento por telefone",
    created_by_user_id: "u1",
    created_by_name: "Ana",
    created_at: "2026-01-10T12:00:00.000Z",
    media_storage_path: null,
    media_mime: null,
    media_size_bytes: null,
    media_expired_at: null,
    media_retention_days: null,
    ...over,
  } as Note;
}

/** A bolha da mensagem, só com o que ela lê para o aviso de mídia expirada. */
function mensagem(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    organization_id: "o1",
    conversation_id: "c1",
    channel_session_id: "s1",
    contact_id: "ct1",
    external_id: null,
    type: "image",
    direction: "inbound",
    status: "delivered",
    ack: null,
    error_code: null,
    error_message: null,
    body: null,
    media_url: null,
    media_mime: "image/jpeg",
    media_size_bytes: 1024,
    media_storage_path: null,
    sent_via: null,
    sent_by_user_id: null,
    sent_at: "2026-01-10T12:00:00.000Z",
    delivered_at: null,
    read_at: null,
    metadata: null,
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: "2026-01-10T12:00:00.000Z",
    ...over,
  } as Message;
}

/**
 * O texto está na TELA, não só no leitor de tela. `getByText` acha nó dentro
 * de `.sr-only` em jsdom, e foi assim que a primeira versão deste arquivo ficou
 * verde com o aviso invisível: o cartão mostrava só "Mídia indisponível".
 */
function visivel(texto: string): HTMLElement {
  const no = screen.getByText(texto);
  expect(no.closest(".sr-only"), `"${texto}" só existe para leitor de tela`).toBeNull();
  return no;
}

/** O corpo da ÚLTIMA definição de `fn_enfileirar_midia_vencida` num texto SQL. */
function ultimaDefinicao(sql: string): string | null {
  const marca = "create or replace function public.fn_enfileirar_midia_vencida";
  const pos = sql.lastIndexOf(marca);
  return pos === -1 ? null : sql.slice(pos);
}

describe("nota interna com anexo apagado pela política de retenção", () => {
  it("mostra o aviso no lugar do anexo, com os dias da política", () => {
    render(
      <NoteCard
        note={nota({ media_expired_at: "2026-04-10T12:00:00.000Z", media_retention_days: 90 })}
      />,
    );
    visivel("Anexo da nota apagado pela política de retenção (90 dias)");
    // O motivo SUBSTITUI o genérico: "indisponível" sem o porquê era o defeito.
    expect(screen.queryByText("Mídia indisponível")).toBeNull();
  });

  it("sem os dias gravados, o aviso genérico — nunca texto de erro", () => {
    render(<NoteCard note={nota({ media_expired_at: "2026-04-10T12:00:00.000Z" })} />);
    visivel("Anexo da nota apagado pela política de retenção.");
  });

  it("nota que NUNCA teve anexo não ganha aviso nenhum", () => {
    render(<NoteCard note={nota()} />);
    expect(screen.queryByText(GENERICO)).toBeNull();
    expect(screen.queryByText(/política de retenção/)).toBeNull();
    // Nem o cartão genérico: sem a marca, não há o que avisar.
    expect(screen.queryByText("Mídia indisponível")).toBeNull();
  });

  it("o aviso da nota é o MESMO cartão da mensagem — um padrão, dois lugares", () => {
    render(
      <>
        <NoteCard
          note={nota({ media_expired_at: "2026-04-10T12:00:00.000Z", media_retention_days: 90 })}
        />
        <MessageBubble
          message={mensagem({ metadata: { media_status: "expired", media_retention_days: 365 } })}
        />
      </>,
    );
    // O texto que diz POR QUE é o único que muda: a nota fala do anexo dela, a
    // mensagem da mídia da conversa — e cada um cita os SEUS dias, à vista.
    const daNota = visivel("Anexo da nota apagado pela política de retenção (90 dias)");
    const daMensagem = visivel("Mídia apagada pela política de retenção (365 dias)");
    // Um só componente (`MediaUnavailable`): o cartão em volta dos dois avisos
    // é o mesmo. Reprova se alguém reintroduzir um cartão próprio na nota.
    expect(daNota.parentElement?.className).toBe(daMensagem.parentElement?.className);
  });

  it("a mensagem com mídia apagada mostra o motivo escrito, não só 'indisponível'", () => {
    render(
      <MessageBubble
        message={mensagem({ metadata: { media_status: "expired", media_retention_days: 365 } })}
      />,
    );
    visivel("Mídia apagada pela política de retenção (365 dias)");
    expect(screen.queryByText("Mídia indisponível")).toBeNull();
    // Mídia expirada não ganha imagem nem player: o cartão ocupa o lugar dela.
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("os três idiomas: pt-BR é a chave, es está no dicionário e en no catálogo", () => {
    // Não se cobra `traduzir(chave, "en")` aqui: `en` está `em_construcao` no
    // registro e `CATALOGOS` só importa idioma visível (lib/i18n/catalogos.ts)
    // — hoje a frase inglesa existe no arquivo e cai no português na tela, por
    // desenho. O que se mede é que ela EXISTE no catálogo, pronta para a
    // promoção, e que o espanhol (este sim `completo`) é servido de verdade.
    const en = JSON.parse(
      readFileSync(join(process.cwd(), "lib", "i18n", "traducoes", "en.json"), "utf8"),
    ) as Record<string, string>;
    for (const chave of [COM_DIAS, GENERICO]) {
      expect(traduzir(chave, "es"), `espanhol ausente para: ${chave}`).not.toBe(chave);
      expect(en[chave]?.trim().length ?? 0, `inglês ausente para: ${chave}`).toBeGreaterThan(0);
    }
  });

  it("o passo 2c da cadeia grava a marca que a tela lê e continua zerando os ponteiros", () => {
    const arquivos = readdirSync(join(RAIZ, "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const daCadeia = [...arquivos]
      .reverse()
      .map((f) => readFileSync(join(RAIZ, "migrations", f), "utf8"))
      .find((sql) => sql.includes("create or replace function public.fn_enfileirar_midia_vencida"));
    const corpo = daCadeia ? ultimaDefinicao(daCadeia) : null;
    expect(corpo, "nenhuma migration define fn_enfileirar_midia_vencida").not.toBeNull();

    const notaApagada = /update public\.conversation_notes[\s\S]{0,600}?returning 1/;
    const trecho = notaApagada.exec(corpo!)?.[0] ?? "";
    expect(trecho, "a cadeia não tem o UPDATE da nota do passo 2c").not.toBe("");
    expect(trecho).toContain("media_storage_path = null");
    expect(trecho).toContain("media_expired_at = now()");
    expect(trecho).toContain("media_retention_days = v.retencao_dias");
  });

  it("o apêndice do baseline aplica a coluna e o MESMO corpo da cadeia", () => {
    const baseline = readFileSync(join(RAIZ, "baseline.sql"), "utf8");
    expect(baseline).toContain("add column if not exists media_expired_at");
    expect(baseline).toContain("add column if not exists media_retention_days");

    const corpo = ultimaDefinicao(baseline);
    expect(corpo, "o baseline não define fn_enfileirar_midia_vencida").not.toBeNull();
    const trecho =
      /update public\.conversation_notes[\s\S]{0,600}?returning 1/.exec(corpo!)?.[0] ?? "";
    expect(trecho).toContain("media_expired_at = now()");
    expect(trecho).toContain("media_retention_days = v.retencao_dias");
  });
});
