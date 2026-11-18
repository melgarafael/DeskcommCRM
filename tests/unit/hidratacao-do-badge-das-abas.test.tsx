/**
 * O BADGE DE CONTAGEM DAS ABAS NÃO DIVERGE NA HIDRATAÇÃO (#3736).
 *
 * Medido na bancada de produção (543 cargas, 3 erros): `Minified React error
 * #418`, `isText=false` — divergência de NÓ, não de texto — e a cadeia de fibers
 * do instante do erro era `[span, button, Primitive.button, …]`: o `<span>` do
 * badge dentro do `TabsTrigger`. O SSR sai SEM o badge (não há contagem no
 * servidor); quando a resposta de `useConversationCounts` chegava DURANTE a
 * hidratação, o primeiro render do cliente já trazia o `<span>` e o React
 * comparava com um HTML que não tinha o nó.
 *
 * Aqui o componente e o hook são os de produção; só as consultas são dublês.
 * O HTML do servidor vem de `renderToString` de verdade e a hidratação é
 * `hydrateRoot` de verdade — o erro que este teste persegue só aparece nesse
 * caminho.
 */
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A contagem que "chega" do servidor de dados. `null` = ainda não chegou. */
let contagens: { fila: number } | null = null;

vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({ data: contagens }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    activeOrg: { orgId: "org-1", role: "manager", visibility_mode: "all" },
  }),
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
  channelLabel: () => "WhatsApp",
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/components/inbox/SeletorDeAtendente", () => ({
  SeletorDeAtendente: () => null,
}));

import { InboxFilters } from "@/components/inbox/InboxFilters";

type PropsDoInbox = Parameters<typeof InboxFilters>[0];
const FILTRO = {
  tab: "unassigned",
  search: "",
  assigned_to: null,
  onlyUnread: false,
  tags: [],
  tagMode: "any",
  channel_session_id: null,
} as unknown as PropsDoInbox["value"];

beforeEach(() => {
  contagens = null;
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("Inbox › o badge das abas hidrata sem divergir da contagem (#3736)", () => {
  it("controle: o HTML do servidor sai SEM o badge (não há contagem no servidor)", () => {
    contagens = { fila: 41 };
    const html = renderToString(<InboxFilters value={FILTRO} onChange={() => {}} />);
    expect(html).toContain("Fila");
    expect(html, "o servidor passou a imprimir a contagem: a divergência volta").not.toContain(
      "tabular-nums",
    );
  });

  it("a contagem chega DURANTE a hidratação: nenhum erro recuperável, e o badge aparece depois", async () => {
    const html = renderToString(<InboxFilters value={FILTRO} onChange={() => {}} />);
    // A resposta da consulta chega entre o HTML e a hidratação — a janela do #418.
    contagens = { fila: 41 };

    const erros: unknown[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);

    await act(async () => {
      hydrateRoot(container, <InboxFilters value={FILTRO} onChange={() => {}} />, {
        onRecoverableError: (erro) => erros.push(erro),
      });
    });

    expect(erros, "o React teve de recuperar a árvore: o badge divergiu do HTML").toEqual([]);
    expect(
      consoleError.mock.calls.filter((c) => /hydrat/i.test(String(c[0]))),
    ).toEqual([]);

    // E o badge NÃO foi escondido para sempre: depois de montar, a contagem está lá.
    expect(container.querySelectorAll(".tabular-nums").length).toBe(1);
    expect(container.textContent).toContain("41");
  });
});
