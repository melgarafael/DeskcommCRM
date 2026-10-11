/**
 * A BUSCA DENTRO DO SELETOR DE ETIQUETAS (#2498).
 *
 * ─── O defeito ─────────────────────────────────────────────────────────────
 *
 * O seletor lista o vocabulário INTEIRO da organização — união de conversa e
 * contato, ordenada — e não tem campo nenhum. Quem tem 40 marcadores rola
 * (ou não acha). A busca proposta filtra o vocabulário que JÁ ESTÁ no
 * navegador: nada de consulta por tecla, porque o custo de uma tecla seria uma
 * volta ao servidor por caractere digitado, num controle que só decide o que
 * está visível na lista.
 *
 * ─── O que este arquivo trava ──────────────────────────────────────────────
 *
 * 1. o campo EXISTE dentro do menu aberto;
 * 2. digitar FILTRA as opções (só o que casa fica na lista);
 * 3. filtrar NÃO MEXE na seleção nem no modo E/OU — as duas escolhidas
 *    continuam escolhidas, o rádio continua marcado, e `onChange` não é
 *    chamado um vez só durante a digitação (é o valor do filtro que vira
 *    chave de query: se a busca mexesse nele, cada tecla viraria uma consulta);
 * 4. limpar o campo devolve a lista inteira, com tudo marcado como estava.
 *
 * O vocabulário é dublado nas DUAS caixas de propósito: a união é o que o
 * seletor mostra, e uma busca que filtrasse só uma delas esconderia marcador
 * legítimo.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InboxFilters, type InboxFiltersValue } from "@/components/inbox/InboxFilters";
import type * as CanaisModule from "@/hooks/channels/useChannelSessions";
import type { ChannelSession } from "@/hooks/channels/useChannelSessions";
import type { ActiveOrg } from "@/lib/auth/types";

const h = vi.hoisted(() => ({
  /**
   * As chaves de query que a tela pediu — uma por render, para comparar.
   * Tipada com os DOIS argumentos reais (`orgId`, filtros): é o segundo que é
   * a chave da query, e `(...args: unknown[])` esconderia esse índice.
   */
  contagens: vi.fn((_orgId: string | null, _filtros: Record<string, unknown>) => ({
    data: { fila: 3, mine: 2, all: 5 },
  })),
}));

const activeOrgRef: { current: ActiveOrg | null } = { current: null };
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: activeOrgRef.current }),
}));
vi.mock("@/hooks/channels/useChannelSessions", async (original) => {
  const real = await original<typeof CanaisModule>();
  return { ...real, useChannelSessions: () => ({ data: [] as ChannelSession[] }) };
});
/** `undefined` = vocabulário em voo — não é "zero etiquetas". */
const tagsRef: { current: string[] | undefined } = { current: undefined };
const tagsDoContatoRef: { current: string[] | undefined } = { current: undefined };
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: () => ({ data: tagsRef.current }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: tagsDoContatoRef.current }),
}));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: h.contagens,
}));

const GATILHO = "Filtrar por tag";
const BUSCA = "Buscar etiqueta";

const VALUE: InboxFiltersValue = { tab: "unassigned", search: "", onlyUnread: false };

function abrirMenu(value: InboxFiltersValue = VALUE) {
  const onChange = vi.fn();
  const user = userEvent.setup({ delay: null });
  render(<InboxFilters value={value} onChange={onChange} />);
  return { user, onChange };
}

beforeEach(() => {
  h.contagens.mockClear();
  activeOrgRef.current = { orgId: "org-1", name: "Org", role: "manager", visibility_mode: "all" };
  tagsRef.current = ["vip", "retorno"];
  tagsDoContatoRef.current = ["quente"];
  // jsdom não implementa captura de ponteiro (mesmo remédio dos testes do editor).
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});
afterEach(cleanup);

/** Abre o menu de etiqueta e devolve o campo de busca dentro dele. */
async function campoDeBuscaAberto(value: InboxFiltersValue = VALUE) {
  const ctx = abrirMenu(value);
  await ctx.user.click(screen.getByRole("button", { name: GATILHO }));
  const campo = screen.getByPlaceholderText(BUSCA) as HTMLInputElement;
  return { ...ctx, campo };
}

describe("o campo de busca mora DENTRO do seletor de etiquetas", () => {
  it("existe com o menu aberto, e o menu continua aberto com ele em foco", async () => {
    const { campo } = await campoDeBuscaAberto();
    expect(campo).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: /vip/ })).toBeInTheDocument();
  });

  it("o vocabulário continua listado inteiro ANTES de qualquer tecla", async () => {
    await campoDeBuscaAberto();
    for (const tag of ["quente", "retorno", "vip"]) {
      expect(screen.getByRole("menuitemcheckbox", { name: new RegExp(tag) })).toBeInTheDocument();
    }
  });
});

describe("digitar filtra — e só filtra", () => {
  it("só as etiquetas que casam com o texto ficam visíveis", async () => {
    const { user, campo } = await campoDeBuscaAberto();
    await user.type(campo, "qu");

    expect(screen.getByRole("menuitemcheckbox", { name: /quente/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox", { name: /vip/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox", { name: /retorno/ })).not.toBeInTheDocument();
  });

  it("a busca é por TEXTO do vocabulário já carregado — digitar não muda a query", async () => {
    const { user, campo } = await campoDeBuscaAberto();
    // A chave da query de contagens é o FILTRO (`tag`, `tagMode`, …). Se a busca
    // mexesse em `value`, cada tecla seria uma consulta ao servidor — é exatamente
    // o "sem consulta por tecla" da issue, medido pela chave e não por achado.
    expect(h.contagens).toHaveBeenCalled();
    const chaveAntes = JSON.stringify(h.contagens.mock.calls[0]?.[1]);

    await user.type(campo, "quente");

    const chaveDepois = JSON.stringify(h.contagens.mock.calls.at(-1)?.[1]);
    expect(chaveDepois).toBe(chaveAntes);
    // E a chave continua dizendo "nenhuma etiqueta escolhida": a busca só
    // decide o que está VISÍVEL na lista, nunca o que está FILTRADO na consulta.
    expect(h.contagens.mock.calls.at(-1)?.[1]).toMatchObject({ tag: [] });
  });
});

describe("filtrar preserva a seleção múltipla e o modo E/OU (#2498)", () => {
  const DUAS: InboxFiltersValue = {
    ...VALUE,
    tag: ["vip", "retorno"],
    tagMode: "ou",
  };

  it("escolher duas, buscar e limpar: as DUAS continuam marcadas e o OU marcado", async () => {
    const { user, campo, onChange } = await campoDeBuscaAberto(DUAS);

    // Busca que casa com NENHUMA das escolhidas — o pior caso: a lista mostra
    // só "quente" enquanto a seleção continua sendo vip+retorno.
    await user.type(campo, "qu");
    expect(screen.getByRole("menuitemcheckbox", { name: /quente/ })).toBeInTheDocument();
    // Durante a digitação a tela não pediu NADA: sem chamada de onChange, não há
    // como a seleção ou o modo terem sido reescritos.
    expect(onChange).not.toHaveBeenCalled();

    await user.clear(campo);

    // De volta à lista inteira, as duas escolhidas seguem marcadas…
    expect(screen.getByRole("menuitemcheckbox", { name: /vip/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemcheckbox", { name: /retorno/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // …e o modo OU continua o modo — o rádio só existe com DUAS escolhidas, e
    // ele é a prova de que a segunda escolha não se perdeu no caminho.
    expect(screen.getByRole("menuitemradio", { name: "Qualquer uma (OU)" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("com o campo filtrando, dá para acrescentar uma terceira etiqueta", async () => {
    const { user, campo, onChange } = await campoDeBuscaAberto(DUAS);

    await user.type(campo, "qu");
    await user.click(screen.getByRole("menuitemcheckbox", { name: /quente/ }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toMatchObject({
      tag: ["vip", "retorno", "quente"],
      tagMode: "ou",
    });
  });

  it("a busca não fecha o menu: o campo segue vivo depois de filtrar", async () => {
    const { user, campo } = await campoDeBuscaAberto();
    await user.type(campo, "v");
    expect(campo.value).toBe("v");
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});
