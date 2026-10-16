/**
 * A PALETA AO LADO DA TAG QUE JÁ ESTÁ NO REGISTRO (issue #2771, fatia 2).
 *
 * ─── O que falta até aqui ───────────────────────────────────────────────────
 *
 * A paleta existe desde a #2718, mas só no momento da CRIAÇÃO: quem está no
 * editor de tags do contato vê o chip colorido e não tem como trocar a cor
 * dali — precisa sair, ir em Settings → Etiquetas, achar a etiqueta na lista e
 * só então mexer. Este arquivo cobre o gatilho AO LADO de cada tag presente,
 * reaproveitando os três artefatos que já existem:
 *
 *   - `SeletorDeCorDaEtiqueta` (o MESMO picker, com os oito tons e a prévia);
 *   - `useDefinirCorDaEtiqueta` (o MESMO POST `definir_cor`, com a invalidação);
 *   - `invalidarCoresDasEtiquetas` (que o hook já dispara).
 *
 * Sem rota nova e sem migration: quem decide a cor continua sendo quem chama a
 * rota que já existia.
 *
 * ─── Por que o papel importa ────────────────────────────────────────────────
 *
 * `POST /api/v1/tags/vocabulario` exige `manager` + MFA, e a régua da #2718 é
 * "a tela não oferece o que a escrita recusa": para `agent` o gatilho nem
 * aparece (o próprio seletor devolve `null`), em vez de aparecer e recusar.
 */
import { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Troca o papel da sessão entre os casos (manager vê o gatilho, agent não). */
const sessao = vi.hoisted(() => ({ papel: "manager" as string }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { orgId: "org-1", role: sessao.papel } }),
}));

const gets = vi.hoisted(() => vi.fn());
const posts = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...args: unknown[]) => gets(...args),
    post: (...args: unknown[]) => posts(...args),
    patch: vi.fn(),
  },
}));

/** A cor que o VOCABULÁRIO tem agora — muda quando o `definir_cor` grava, é o
 * que o mapa do chip devolve na releitura. */
const vocabulario = vi.hoisted(() => ({ cor: "#0091ff" as string | null }));

const mutate = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutate, isPending: false }),
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useUpdateConversationTags: () => ({ mutate, isPending: false }),
  useConversationTagVocabulary: () => ({ data: [] }),
}));

import { ContactTagsEditor } from "@/components/inbox/ContactTagsEditor";
import { ConversationTagsEditor } from "@/components/inbox/ConversationTagsEditor";
import { ProvedorDeCoresDasEtiquetas } from "@/components/tags/CoresDasEtiquetas";

const pintado = (el: HTMLElement) => (el.getAttribute("style") ?? "").replace(/\s/g, "");
const leiturasDeCores = () =>
  gets.mock.calls.filter(([url]) => url === "/api/v1/tags/cores").length;

function montar(elemento: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProvedorDeCoresDasEtiquetas>{elemento}</ProvedorDeCoresDasEtiquetas>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  sessao.papel = "manager";
  vocabulario.cor = "#0091ff";
  mutate.mockReset();
  posts.mockReset();
  gets.mockReset();
  // O SERVIDOR é quem muda: o `definir_cor` grava e a releitura do mapa devolve
  // o tom novo. Sem isto o teste provaria repintura sobre um dado que nunca
  // muda — e passaria mesmo sem invalidação nenhuma.
  posts.mockImplementation(async (_url: string, corpo?: { acao?: string; cor?: string | null }) => {
    if (corpo?.acao === "definir_cor") vocabulario.cor = corpo.cor ?? null;
    return { data: { alterou: true } };
  });
  gets.mockImplementation(async (url: string) =>
    url === "/api/v1/tags/cores"
      ? { data: vocabulario.cor ? [{ tag: "vip", cor: vocabulario.cor }] : [] }
      : { data: ["google"] },
  );
});

afterEach(() => cleanup());

describe("paleta ao lado da tag presente (#2771)", () => {
  it("⭐ no editor do CONTATO: escolher um tom grava `definir_cor` e repinta na hora", async () => {
    montar(<ContactTagsEditor contactId="c-1" orgId="org-1" tags={["vip"]} />);

    // RED: o gatilho ainda não existe fora de Settings.
    const gatilho = await screen.findByRole("button", { name: "Cor da etiqueta vip" }, { timeout: 5000 });
    fireEvent.click(gatilho);
    fireEvent.click(await screen.findByRole("button", { name: "Âmbar" }));

    await waitFor(() =>
      expect(posts).toHaveBeenCalledWith("/api/v1/tags/vocabulario", {
        acao: "definir_cor",
        tag: "vip",
        destino: null,
        cor: "#ffb224",
      }),
    );

    // O chip da mesma tela lê o mapa: sem invalidação ele continuaria azul até
    // o `staleTime` de 5 min — o "escolhi e não repintou".
    await waitFor(() => expect(leiturasDeCores()).toBeGreaterThan(1), { timeout: 4000 });
    await waitFor(
      () => expect(screen.getAllByText("vip").some((el) => pintado(el).match(/rgb\(255,\s*178,\s*36\)|#ffb224/i))).toBe(true),
      { timeout: 4000 },
    );
  });

  it("no editor da CONVERSA, o mesmo gatilho e a mesma rota", async () => {
    montar(<ConversationTagsEditor conversationId="cv-1" orgId="org-1" tags={["vip"]} />);

    const gatilho = await screen.findByRole("button", { name: "Cor da etiqueta vip" }, { timeout: 5000 });
    fireEvent.click(gatilho);
    fireEvent.click(await screen.findByRole("button", { name: "Índigo" }));

    await waitFor(() =>
      expect(posts).toHaveBeenCalledWith("/api/v1/tags/vocabulario", {
        acao: "definir_cor",
        tag: "vip",
        destino: null,
        cor: "#3e63dd",
      }),
    );
  });

  it("agent não vê o gatilho — a rota exigiria manager + MFA (#2718, decisão A)", async () => {
    sessao.papel = "agent";
    montar(<ContactTagsEditor contactId="c-1" orgId="org-1" tags={["vip"]} />);

    // Espera pela VOCABULÁRIO (que o editor busca) para não afirmar ausência
    // antes de a tela estar pronta.
    await waitFor(() => expect(gets).toHaveBeenCalledWith("/api/v1/contact-tags"), { timeout: 5000 });
    expect(screen.queryByRole("button", { name: /Cor da etiqueta/ })).toBeNull();
    expect(posts).not.toHaveBeenCalled();
  });
});
