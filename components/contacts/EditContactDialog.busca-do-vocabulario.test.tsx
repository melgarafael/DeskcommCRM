/**
 * A FICHA PERGUNTA AO MESMO VOCABULÁRIO QUE O INBOX (issue #3144).
 *
 * ─── O defeito que este arquivo tranca ──────────────────────────────────────
 *
 * O campo de etiquetas da ficha (`EtiquetasDoContato`, desde a #2732) recebe o
 * vocabulário por prop, e quem o monta lê `GET /api/v1/contact-tags` SEM o texto
 * digitado — a leitura antiga, que varre os 1000 contatos atualizados mais
 * recentemente e corta em 200 etiquetas (`app/api/v1/contact-tags/route.ts`,
 * `CONTATOS_LIDOS` e `TETO_DE_TAGS`). O Inbox, na #2855, passou a perguntar
 * TAMBÉM com o texto digitado (`ContactTagsEditor`, os dois
 * `useContactTagVocabulary`), e essa chamada cai na RPC do vocabulário curado
 * (`fn_vocabulario_de_tags_pagina`), que enxerga o que a leitura antiga não
 * enxerga:
 *
 *   • a etiqueta da tela Configurações → Tags que nenhum contato usa ainda;
 *   • a que só aparece em `crm_leads` ou em `conversations`;
 *   • a que só existe como `add_tag` de uma regra de agente;
 *   • e qualquer uma além do teto de 200 da lista "em uso".
 *
 * Efeito na tela que a issue descreve: quem digita "diam" na ficha não recebe
 * "cliente diamante" — digita o nome inteiro (ou uma variante dele), que é
 * exatamente o erro de digitação que a seleção de etiquetas existentes veio
 * evitar. No Inbox a mesma digitação sugere.
 *
 * O que cada caso prova:
 *   1. o texto digitado consulta o vocabulário curado, e a etiqueta que SÓ
 *      existe lá aparece como sugestão;
 *   2. escolhê-la grava a grafia do vocabulário no PATCH do contato (mesma
 *      fonte, mesma etiqueta que o Inbox mostra);
 *   3. a etiqueta que já está no contato não volta como sugestão (controle);
 *   4. contato sem etiqueta continua funcionando (controle);
 *   5. a falha da leitura do vocabulário aparece na ficha — a mesma frase que o
 *      Inbox mostra, em vez do silêncio de "não há etiquetas".
 *
 * ─── Por que a rota é dublada no FIO ────────────────────────────────────────
 *
 * A prova é sobre QUAL pergunta sai (com `?busca=` ou sem) e o que a resposta
 * faz na tela; dublar o hook provaria só que o dublê está ligado. Então o
 * `apiClient` é mockado com a FORMA de cada rota, como em
 * `EtiquetasDoContato.cor.test.tsx`.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";
import { ProvedorDeCoresDasEtiquetas } from "@/components/tags/CoresDasEtiquetas";
import { EditContactDialog } from "@/components/contacts/EditContactDialog";
import type { Contact } from "@/lib/types/contacts";

/** O que a ficha entrega ao `PATCH /api/v1/contacts/{id}`. */
const mutateAtualizar = vi.hoisted(() => vi.fn(async () => ({ data: { contact: null } })));

/** O papel de quem edita — lido pelos hooks de auth que a ficha usa. */
const estado = vi.hoisted(() => ({ papel: "manager" as string, falhaNoVocabulario: false }));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { orgId: "org-1", role: estado.papel } }),
  useActiveOrg: () => ({
    orgId: "org-1",
    role: estado.papel,
    name: "Organização de teste",
    currency: "BRL",
    country: null,
  }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutateAsync: mutateAtualizar, isPending: false }),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async (url: unknown) => {
      const alvo = String(url);
      if (alvo.includes("/api/v1/tags/cores")) {
        return { data: [{ tag: "cliente diamante", cor: "#0091ff" }] };
      }
      // A leitura COM texto é a do vocabulário curado (RPC) — a MESMA que o
      // Inbox usa desde a #2855.
      if (alvo.includes("busca=")) {
        if (estado.falhaNoVocabulario) throw new Error("500");
        const busca = decodeURIComponent(alvo.split("busca=")[1] ?? "");
        return { data: busca.includes("diam") ? ["cliente diamante"] : [] };
      }
      // Sem texto: a leitura antiga, só o que está em uso nos contatos.
      if (estado.falhaNoVocabulario) throw new Error("500");
      return { data: ["vip"] };
    }),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}));

function envolver(ui: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ProvedorDeCoresDasEtiquetas>{ui}</ProvedorDeCoresDasEtiquetas>
    </QueryClientProvider>,
  );
}

const campo = () => screen.getByLabelText("Adicionar etiqueta");
/** A sugestão pelo rótulo que ela mesma anuncia (o chip com papel de botão). */
const sugestao = (tag: string) => screen.queryByRole("button", { name: `Adicionar etiqueta: ${tag}` });

/** A cor de FUNDO aplicada, no MESMO formato que o navegador usa. */
function mesmaCor(el: HTMLElement | null, hex: string): boolean {
  if (!el) return false;
  const prova = document.createElement("span");
  prova.style.backgroundColor = hex;
  return (
    window.getComputedStyle(el).backgroundColor === window.getComputedStyle(prova).backgroundColor
  );
}

const CONTATO = {
  id: "ct-3144",
  organization_id: "org-1",
  name: "Joana Prado",
  display_name: null,
  email: null,
  email_normalized: null,
  phone_number: null,
  cpf_hash: null,
  birthdate: null,
  is_blocked: false,
  is_personal: false,
  blocked_reason: null,
  is_anonymized: false,
  anonymized_at: null,
  is_merged_into: null,
  merged_at: null,
  consent: {},
  tags: ["vip"],
  source: "manual",
  source_metadata: {},
  custom_fields: {},
  created_at: "2026-09-14T10:00:00.000Z",
  updated_at: "2026-09-14T10:00:00.000Z",
  last_activity_at: null,
  first_service_at: null,
  ai_opt_out: false,
} satisfies Contact;

const SEM_ETIQUETA = { ...CONTATO, id: "ct-3144-sem-tag", tags: [] } satisfies Contact;

beforeEach(() => {
  estado.papel = "manager";
  estado.falhaNoVocabulario = false;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a ficha pergunta ao vocabulário curado, como o Inbox (issue #3144)", () => {
  it("a etiqueta que só existe no vocabulário curado aparece na sugestão", async () => {
    const user = userEvent.setup();
    envolver(
      <EditContactDialog contact={CONTATO} open onOpenChange={vi.fn()} vocabulario={["vip"]} />,
    );

    // A lista "em uso" (sem texto) não tem a etiqueta; a digitação tem.
    expect(sugestao("cliente diamante")).toBeNull();
    await user.type(campo(), "diam");

    // A MESMA pergunta do Inbox: `?busca=` sobre o vocabulário curado.
    await waitFor(() =>
      expect(apiClient.get).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/contact-tags?busca=diam"),
        expect.anything(),
      ),
    );
    const achada = await screen.findByRole("button", {
      name: "Adicionar etiqueta: cliente diamante",
    });
    // E sai PINTADA com o tom que ela tem no Inbox: a cor vem do mesmo mapa
    // (`ProvedorDeCoresDasEtiquetas`), não da lista que a tela já tinha em mãos —
    // é o que faz a etiqueta do vocabulário curado ser reconhecida de relance.
    await waitFor(() => expect(mesmaCor(achada, "#0091ff")).toBe(true));
  });

  it("escolher a sugestão grava a grafia do vocabulário no PATCH do contato", async () => {
    // `agent` não recebe a paleta (a rota da cor exige manager + MFA): o clique
    // entra direto na lista, que é o caminho que este caso mede.
    estado.papel = "agent";
    const user = userEvent.setup();
    envolver(
      <EditContactDialog contact={CONTATO} open onOpenChange={vi.fn()} vocabulario={["vip"]} />,
    );

    await user.type(campo(), "diam");
    await user.click(await screen.findByRole("button", { name: "Adicionar etiqueta: cliente diamante" }));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(mutateAtualizar).toHaveBeenCalledWith(
        expect.objectContaining({ tags: ["vip", "cliente diamante"] }),
      ),
    );
  });

  it("a etiqueta que já está no contato não volta como sugestão", async () => {
    const user = userEvent.setup();
    envolver(
      <EditContactDialog contact={CONTATO} open onOpenChange={vi.fn()} vocabulario={["vip"]} />,
    );

    await user.type(campo(), "vip");
    // O servidor devolve a própria "vip" na busca; a sugestão a descarta.
    await waitFor(() =>
      expect(apiClient.get).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/contact-tags?busca=vip"),
        expect.anything(),
      ),
    );
    expect(sugestao("vip")).toBeNull();
  });

  it("contato sem etiqueta continua funcionando", async () => {
    // Sem a paleta (papel `agent`), o clique entra direto — é o caminho de quem
    // só classifica.
    estado.papel = "agent";
    const user = userEvent.setup();
    envolver(
      <EditContactDialog contact={SEM_ETIQUETA} open onOpenChange={vi.fn()} vocabulario={["vip"]} />,
    );

    expect(screen.getByText("Nenhuma etiqueta neste contato.")).toBeTruthy();
    await user.type(campo(), "diam");
    await user.click(await screen.findByRole("button", { name: "Adicionar etiqueta: cliente diamante" }));
    expect(screen.getByRole("button", { name: "Remover etiqueta cliente diamante" })).toBeTruthy();
  });

  it("a falha da leitura do vocabulário aparece na ficha, como no Inbox", async () => {
    estado.falhaNoVocabulario = true;
    envolver(
      <EditContactDialog contact={CONTATO} open onOpenChange={vi.fn()} vocabulario={null} />,
    );

    expect(await screen.findByText("Não foi possível carregar as tags.")).toBeTruthy();
  });
});
