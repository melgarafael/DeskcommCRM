/**
 * A FICHA DO CONTATO: "MARCAR SEM INTERESSE" E O DESFAZER NA ABA LGPD (decisão D3).
 *
 * Renderiza a ficha de verdade (mesmo molde de `ficha-mostra-os-links`) e prova:
 *
 *  1. sem recusa, quem atende vê "Marcar sem interesse", e marcar CONFIRMA antes
 *     (só um administrador desfaz);
 *  2. com a recusa "sem interesse", o botão some, o selo aparece e a aba LGPD mostra
 *     a recusa com o desfazer (que também confirma);
 *  3. com uma recusa de OUTRA origem (captação), nem botão nem desfazer: gravar por
 *     cima apagaria a recusa que veio primeiro.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Tirar `!recusouOfertas` do gate do botão: o caso 3 acusa.
 * - Voltar a escrever "Recusa registrada em" fora do teste de `declinedAt`: os dois
 *   casos sem data acusam ("Recusa registrada em, pela equipe.").
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContactDetailClient } from "@/app/app/contacts/[id]/_client";
import { consentComSemInteresse } from "@/lib/lgpd/sem-interesse";
import type { Contact } from "@/lib/types/contacts";

const papel = vi.hoisted(() => ({ atual: "admin" }));
const sessao = vi.hoisted(() => ({ support: null as null | { access_mode: string } }));
const marcarMutate = vi.hoisted(() => vi.fn());
const desfazerMutate = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: "org-1", name: "Loja", role: papel.atual, cliente_pela_agenda: false }),
  useAuth: () => ({
    user: { id: "u-1", is_platform_admin: false, support: sessao.support },
    activeOrg: { orgId: "org-1", name: "Loja", role: papel.atual, cliente_pela_agenda: false },
  }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/hooks/contacts/useContact", () => ({
  useContact: () => ({ isLoading: false, isError: false, data: { data: contato }, refetch: vi.fn() }),
}));
vi.mock("@/hooks/contacts/useSemInteresse", () => ({
  useMarcarSemInteresse: () => ({ mutate: marcarMutate, isPending: false }),
  useDesfazerSemInteresse: () => ({ mutate: desfazerMutate, isPending: false }),
}));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({ useDefaultPipeline: () => ({ data: null }) }));
vi.mock("@/components/contacts/TimelineView", () => ({ TimelineView: () => null }));
vi.mock("@/components/contacts/EditContactDialog", () => ({ EditContactDialog: () => null }));
vi.mock("@/components/contacts/AnonymizeDialog", () => ({ AnonymizeDialog: () => null }));
vi.mock("@/components/contacts/PropostasDeDado", () => ({ PropostasDeDado: () => null }));
vi.mock("@/components/kanban/ConversaNoDossie", () => ({ ConversaNoDossie: () => null }));
vi.mock("@/components/voice/DialButton", () => ({ DialButton: () => null }));

const BASE = {
  id: "c-1",
  organization_id: "org-1",
  name: "Oficina do Zé",
  display_name: "Oficina do Zé",
  email: null,
  email_normalized: null,
  phone_number: "+5585999998888",
  cpf_available: false,
  birthdate: null,
  is_blocked: false,
  is_personal: false,
  blocked_reason: null,
  is_anonymized: false,
  anonymized_at: null,
  is_merged_into: null,
  merged_at: null,
  consent: {},
  tags: [],
  source: "prospecting",
  source_metadata: {},
  custom_fields: {},
  created_at: "2026-01-01T10:00:00.000Z",
  updated_at: "2026-01-01T10:00:00.000Z",
  last_activity_at: null,
  first_service_at: null,
  ai_opt_out: false,
} satisfies Contact;

let contato: Contact = BASE;

function abrirFicha(consent: Record<string, unknown>, extra: Partial<Contact> = {}) {
  contato = { ...BASE, consent, ...extra };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const comQuery = (ui: ReactNode) => <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
  render(comQuery(<ContactDetailClient contactId="c-1" />));
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Oficina do Zé");
}

const RECUSA = consentComSemInteresse({}, { agora: "2026-11-14T12:00:00.000Z", origem: "conversa_de_prospeccao" })!;

beforeEach(() => {
  papel.atual = "admin";
  sessao.support = null;
  marcarMutate.mockClear();
  desfazerMutate.mockClear();
});

describe("ficha · sem interesse", () => {
  it("contato anonimizado não vê o botão (a rota devolveria 403)", () => {
    papel.atual = "agent";
    abrirFicha({}, { is_anonymized: true, anonymized_at: "2026-11-01T00:00:00.000Z" });
    expect(screen.queryByTestId("marcar-sem-interesse")).toBeNull();
  });

  it("suporte só-leitura não vê o botão", () => {
    sessao.support = { access_mode: "support_readonly" };
    abrirFicha({});
    expect(screen.queryByTestId("marcar-sem-interesse")).toBeNull();
  });

  it("atendente vê o botão, e marcar confirma antes de gravar", async () => {
    papel.atual = "agent";
    abrirFicha({});
    await userEvent.click(screen.getByTestId("marcar-sem-interesse"));
    expect(marcarMutate).not.toHaveBeenCalled();
    const dialogo = await screen.findByRole("alertdialog");
    expect(within(dialogo).getByText(/Só um administrador desfaz, na aba LGPD/)).toBeInTheDocument();
    await userEvent.click(within(dialogo).getByRole("button", { name: "Marcar sem interesse" }));
    expect(marcarMutate).toHaveBeenCalledTimes(1);
  });

  it("com a recusa gravada: selo no cabeçalho, sem botão, e o desfazer na aba LGPD", async () => {
    abrirFicha(RECUSA);
    expect(screen.getByText("Sem interesse em ofertas")).toBeInTheDocument();
    expect(screen.queryByTestId("marcar-sem-interesse")).toBeNull();

    await userEvent.click(screen.getByRole("tab", { name: "LGPD" }));
    const cartao = await screen.findByTestId("recusa-de-ofertas");
    expect(cartao).toHaveTextContent("na conversa da prospecção");
    expect(cartao).toHaveTextContent("14/11/2026");

    await userEvent.click(within(cartao).getByTestId("desfazer-sem-interesse"));
    expect(desfazerMutate).not.toHaveBeenCalled();
    const dialogo = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialogo).getByRole("button", { name: "Desfazer recusa" }));
    expect(desfazerMutate).toHaveBeenCalledTimes(1);
  });

  it("recusa vinda da captação: nem botão por cima, nem desfazer por aqui", async () => {
    abrirFicha({ marketing: { declined_at: "2026-02-01T00:00:00Z" } });
    expect(screen.queryByTestId("marcar-sem-interesse")).toBeNull();
    expect(screen.queryByText("Sem interesse em ofertas")).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "LGPD" }));
    expect(screen.queryByTestId("recusa-de-ofertas")).toBeNull();
  });

  it("gerente não chega ao desfazer: a aba LGPD é só de administrador", () => {
    papel.atual = "manager";
    abrirFicha(RECUSA);
    expect(screen.getByText("Sem interesse em ofertas")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "LGPD" })).toBeNull();
    expect(screen.queryByTestId("desfazer-sem-interesse")).toBeNull();
  });

  it("recusa marcada pelo botão (ficha ou painel da conversa): o cartão diz que foi a equipe", async () => {
    // As duas telas gravam pela mesma rota, com `origem: "ficha"`: o cartão não pode
    // dizer "pela ficha" para quem marcou no Inbox.
    abrirFicha(consentComSemInteresse({}, { agora: "2026-11-14T12:00:00.000Z", origem: "ficha" })!);
    await userEvent.click(screen.getByRole("tab", { name: "LGPD" }));
    const cartao = await screen.findByTestId("recusa-de-ofertas");
    expect(cartao).toHaveTextContent("pela equipe");
    expect(cartao).not.toHaveTextContent("na conversa da prospecção");
  });

  it("com data, o cartão diz quando: \"Recusa registrada em 14/11/2026, pela equipe.\"", async () => {
    abrirFicha(consentComSemInteresse({}, { agora: "2026-11-14T12:00:00.000Z", origem: "ficha" })!);
    await userEvent.click(screen.getByRole("tab", { name: "LGPD" }));
    const cartao = await screen.findByTestId("recusa-de-ofertas");
    expect(cartao).toHaveTextContent("Recusa registrada em 14/11/2026, pela equipe.");
  });

  it("sem data legível, a frase não quebra: \"Recusa registrada pela equipe.\"", async () => {
    // `lerRecusaSemInteresse` devolve `declinedAt: null` quando a data gravada não se lê,
    // e `recusaRegistrada` aceita `granted: false` sem data (ex.: PATCH por token de API).
    abrirFicha({ marketing: { granted: false, motivo: "sem_interesse", origem: "ficha" } });
    await userEvent.click(screen.getByRole("tab", { name: "LGPD" }));
    const cartao = await screen.findByTestId("recusa-de-ofertas");
    expect(cartao).toHaveTextContent("Recusa registrada pela equipe.");
    expect(cartao).not.toHaveTextContent("Recusa registrada em");
    expect(cartao).not.toHaveTextContent(", pela equipe");
  });

  it("sem data e vinda da prospecção: \"Recusa registrada na conversa da prospecção.\"", async () => {
    abrirFicha({ marketing: { granted: false, declined_at: "data ruim", motivo: "sem_interesse", origem: "conversa_de_prospeccao" } });
    await userEvent.click(screen.getByRole("tab", { name: "LGPD" }));
    const cartao = await screen.findByTestId("recusa-de-ofertas");
    expect(cartao).toHaveTextContent("Recusa registrada na conversa da prospecção.");
    expect(cartao).not.toHaveTextContent("Recusa registrada em");
  });

  it("leitor (viewer) não vê o botão", () => {
    papel.atual = "viewer";
    abrirFicha({});
    expect(screen.queryByTestId("marcar-sem-interesse")).toBeNull();
  });
});
