import { readFileSync } from "node:fs";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * POR ONDE a conversa entrou, na lista do inbox.
 *
 * O número mostrado é o DA EMPRESA, não o do cliente. Com um canal só a
 * distinção não existe; com dois — que é o caso desde que o canal intermediado
 * entrou — saber por qual linha a pessoa escreveu decide o tom da resposta e
 * qual número ela vai ver respondendo.
 *
 * Metade dos casos prova quando o rótulo NÃO aparece. Um badge repetido em toda
 * linha da lista é ruído, e ruído na mesma área dos avisos que importam
 * (bloqueado, tags) ensina o olho a ignorar aquela faixa inteira.
 */
import { ConversationListItem } from "@/components/inbox/ConversationListItem";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

const base = {
  id: "c1",
  organization_id: "org",
  contact_id: "ct1",
  channel_session_id: "s1",
  channel: "whatsapp",
  status: "open",
  last_message_at: new Date().toISOString(),
  last_message_preview: "olá",
  unread_count_for_assignee: 0,
  created_at: new Date().toISOString(),
  contacts: { id: "ct1", display_name: "Cliente", name: null, phone_number: "+595999", tags: [], is_blocked: false, is_anonymized: false },
} as unknown as ConversationWithContact;

const comCanal = (canal: { phone_number: string | null; display_name: string | null } | null) =>
  ({ ...base, channel_sessions: canal }) as ConversationWithContact;

const pintar = (conv: ConversationWithContact, mostrarCanal: boolean) =>
  render(
    <ConversationListItem
      conversation={conv}
      isSelected={false}
      onSelect={() => {}}
      mostrarCanal={mostrarCanal}
    />,
  );

describe("mostra o número da empresa quando há mais de um canal", () => {
  it("pinta o número por onde a conversa entrou", () => {
    pintar(comCanal({ phone_number: "+19392301037", display_name: "MP wp" }), true);
    expect(screen.getByText("+19392301037")).toBeInTheDocument();
  });

  it("cai no NOME do canal quando ainda não há número", () => {
    // Canal recém-conectado pode não ter número resolvido; mostrar nada seria
    // pior que mostrar como ele se chama.
    pintar(comCanal({ phone_number: null, display_name: "Canal novo" }), true);
    expect(screen.getByText("Canal novo")).toBeInTheDocument();
  });

  it("explica o rótulo no title — o número solto não diz o que é", () => {
    pintar(comCanal({ phone_number: "+19392301037", display_name: null }), true);
    expect(screen.getByTitle("Entrou por +19392301037")).toBeInTheDocument();
  });

  it("não confunde com o número do CLIENTE", () => {
    // O contato tem +595999; o canal tem +1939. O que aparece no badge é o da
    // EMPRESA — trocar os dois faria o atendente ligar para si mesmo.
    pintar(comCanal({ phone_number: "+19392301037", display_name: null }), true);
    expect(screen.getByTitle("Entrou por +19392301037")).toBeInTheDocument();
    expect(screen.queryByTitle("Entrou por +595999")).not.toBeInTheDocument();
  });
});

describe("NÃO mostra quando não ajuda", () => {
  it("com um canal só — seria a mesma palavra em toda linha", () => {
    pintar(comCanal({ phone_number: "+19392301037", display_name: "MP wp" }), false);
    expect(screen.queryByText("+19392301037")).not.toBeInTheDocument();
  });

  it("sem canal no payload não quebra a linha", () => {
    // Conversa em cache de antes do campo existir, ou sessão apagada.
    expect(() => pintar(comCanal(null), true)).not.toThrow();
    expect(screen.getByText("Cliente")).toBeInTheDocument();
  });

  it("canal sem número E sem nome não vira badge vazio", () => {
    pintar(comCanal({ phone_number: null, display_name: null }), true);
    expect(screen.getByText("Cliente")).toBeInTheDocument();
    expect(screen.queryByTitle(/Entrou por/)).not.toBeInTheDocument();
  });
});

describe("o elo que some sem barulho", () => {
  it.each([
    ["waha", null, "WhatsApp"],
    ["meta_cloud", null, "WhatsApp"],
    ["zernio", null, "WhatsApp"],
    ["zernio_social", "instagram", "Instagram"],
    ["zernio_social", "facebook", "Messenger"],
    ["zernio_social", null, "Canal"],
  ])("identifica %s/%s mesmo com uma conexão", (provider, social_platform, label) => {
    pintar({ ...base, channel_sessions: { provider, social_platform, phone_number: null, display_name: "Comercial" } }, false);
    expect(screen.getByRole("img", { name: label })).toBeInTheDocument();
    expect(screen.getByText("Cliente")).toBeInTheDocument();
  });

  it("o SELECT do listado traz a sessão — sem isso o badge nunca tem o que mostrar", () => {
    // O componente pode estar perfeito e o rótulo não aparecer nunca, porque o
    // dado não chega. É a mesma classe do filtro por `tag`, que o hook serializa
    // e a rota nunca lê: três arquivos, e o defeito mora no que ninguém testou.
    const fonte = readFileSync("app/api/v1/conversations/_handler.ts", "utf8");
    expect(fonte, "falta o embed da sessão no SELECT_COLS").toMatch(
      /channel_sessions:channel_session_id\s*\([^)]*phone_number/,
    );
  });

  it("a lista decide pelo NÚMERO de canais, não por um literal", () => {
    const fonte = readFileSync("components/inbox/ConversationList.tsx", "utf8");
    expect(fonte).toContain("useChannelSessions");
    expect(fonte).toMatch(/length > 1/);
  });
});
