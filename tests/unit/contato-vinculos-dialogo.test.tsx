/**
 * O DIÁLOGO "EXCLUIR CONTATO?" AVISA ANTES DO CLIQUE (issue #1925).
 *
 * O #1949 fez o 409 nomear o vínculo, mas só DEPOIS que a pessoa tentava: a
 * janela de confirmação prometia uma exclusão irreversível sem dizer que a
 * Agenda ia barrar. Esta suíte cobre as duas metades que faltaram:
 *
 *  1. a pré-checagem (`GET /api/v1/contacts/[id]/vinculos`) devolve a MESMA
 *     contagem da exclusão, escopada pela organização de quem chama — o
 *     compromisso de outra organização não aparece nem como 0 para ficha
 *     alheia (404);
 *  2. o diálogo mostra a frase nomeando o vínculo, com o link para a Agenda,
 *     e continua sem aviso nenhum quando não há vínculo — caso em que a
 *     exclusão segue e sai.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextRequest } from "next/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContactsTable } from "@/components/contacts/ContactsTable";
import type { Contact } from "@/lib/types/contacts";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

const getMock = vi.fn();
const deleteMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => getMock(...a),
    delete: (...a: unknown[]) => deleteMock(...a),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: "org-1", name: "Clínica", role: "admin", cliente_pela_agenda: false }),
  useAuth: () => ({ user: { id: "u-1", is_platform_admin: false }, activeOrg: null }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn(), orgAtivaDaApi: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

const ORG = "c05e7a00-0000-4000-8000-000000000001";
const ORG_ALHEIA = "c05e7a00-0000-4000-8000-000000000002";
const CONTATO = "c05e7a00-0000-4000-8000-0000000000c1";

const CONTATO_LINHA = {
  id: CONTATO,
  organization_id: ORG,
  name: "Joana Prado",
  display_name: "Joana",
  email: null,
  email_normalized: null,
  phone_number: null,
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
  source: "whatsapp",
  source_metadata: {},
  custom_fields: {},
  created_at: "2026-01-01T10:00:00.000Z",
  updated_at: "2026-01-01T10:00:00.000Z",
  last_activity_at: null,
  first_service_at: null,
  ai_opt_out: false,
} satisfies Contact;

/** Onde a contagem enxerga: ficha existente e agenda desta organização. */
const estado = vi.hoisted(() => ({
  contatoVisivel: true,
  agenda: [] as Array<Record<string, string>>,
}));

/**
 * Um termo do `.or()` do PostgREST, no subconjunto que a rota usa:
 * `coluna.eq.valor`, `coluna.neq.valor`, `coluna.is.null` e `coluna.not.is.null`.
 * Termo fora disso derruba o teste, em vez de contar errado calado.
 */
function casaTermo(linha: Record<string, string>, termo: string): boolean {
  const [coluna, ...resto] = termo.split(".");
  const valor = linha[coluna!];
  const op = resto.join(".");
  if (op === "is.null") return valor === undefined || valor === null;
  if (op === "not.is.null") return valor !== undefined && valor !== null;
  if (resto[0] === "eq") return valor === resto.slice(1).join(".");
  if (resto[0] === "neq") return valor !== resto.slice(1).join(".");
  throw new Error(`termo de .or() sem dublê: ${termo}`);
}

/**
 * Dublê do supabase: `contacts` responde o 404/200 da pré-checagem e
 * `calendar_appointments` aplica os `.eq()` e o `.or()` recebidos antes de
 * contar — o filtro `organization_id` que a prova de "outra organização não
 * enxerga" precisa exercitar, e o recorte de status do achado A9 (compromisso
 * cancelado não barra).
 */
function supabaseFalso() {
  const cadeiaDeContagem = () => {
    const filtros: Array<[string, unknown]> = [];
    const ous: string[] = [];
    const cadeia: Record<string, unknown> = {};
    cadeia.select = () => cadeia;
    cadeia.eq = (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return cadeia;
    };
    cadeia.or = (expressao: string) => {
      ous.push(expressao);
      return cadeia;
    };
    cadeia.then = (resolver: (v: unknown) => unknown) => {
      const contagem = estado.agenda.filter(
        (linha) =>
          filtros.every(([coluna, valor]) => linha[coluna] === valor) &&
          ous.every((expressao) => expressao.split(",").some((termo) => casaTermo(linha, termo))),
      ).length;
      return Promise.resolve({ count: contagem, error: null }).then(resolver);
    };
    return cadeia;
  };
  const cadeiaDeContato = () => {
    const cadeia: Record<string, unknown> = {};
    cadeia.select = () => cadeia;
    cadeia.eq = () => cadeia;
    cadeia.maybeSingle = async () => ({
      data: estado.contatoVisivel ? { id: CONTATO, organization_id: ORG } : null,
      error: null,
    });
    return cadeia;
  };
  return {
    from: (tabela: string) =>
      tabela === "contacts" ? cadeiaDeContato() : cadeiaDeContagem(),
  };
}

beforeEach(() => {
  estado.contatoVisivel = true;
  estado.agenda = [];
  getMock.mockReset();
  deleteMock.mockReset();
  deleteMock.mockResolvedValue(undefined);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: {
      id: "c05e7a00-0000-4000-8000-0000000000a1",
      email: "ana@clinica.com.br",
      full_name: "Ana",
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR" as const,
      organizations: [{ organization_id: ORG, organization_name: "Clínica", role: "agent" }],
    },
    org: { orgId: ORG, name: "Clínica", role: "agent" },
  } as never);
  vi.mocked(createClient).mockResolvedValue(supabaseFalso() as never);
});

async function consultarRota() {
  const { GET } = await import("@/app/api/v1/contacts/[id]/vinculos/route");
  const res = await GET(
    new NextRequest(`https://crm.exemplo/api/v1/contacts/${CONTATO}/vinculos`),
    { params: Promise.resolve({ id: CONTATO }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

describe("GET /api/v1/contacts/[id]/vinculos — a pré-checagem", () => {
  it("conta o compromisso da própria organização e nomeia o vínculo", async () => {
    estado.agenda = [{ contact_id: CONTATO, organization_id: ORG, status: "confirmed" }];

    const { status, body } = await consultarRota();

    expect(status).toBe(200);
    expect((body as unknown as { data: unknown }).data).toEqual({
      vinculos: ["1 compromisso(s) na agenda"],
      por_tabela: { calendar_appointments: 1 },
    });
  });

  it("compromisso cancelado não barra; o vivo e a reserva de serviço cancelada barram (A9)", async () => {
    // A função de exclusão desvincula o cancelado comum (migration 9405), então
    // a pré-checagem não pode contá-lo: contar faria a tela pedir "cancele" de
    // algo já cancelado. A reserva de serviço não se desvincula com sessão de
    // usuário, e por isso continua contando.
    estado.agenda = [
      { contact_id: CONTATO, organization_id: ORG, status: "cancelled" },
      { contact_id: CONTATO, organization_id: ORG, status: "confirmed" },
      { contact_id: CONTATO, organization_id: ORG, status: "completed" },
      { contact_id: CONTATO, organization_id: ORG, status: "cancelled", service_occurrence_id: "occ-1" },
    ];

    const { status, body } = await consultarRota();

    expect(status).toBe(200);
    expect((body as unknown as { data: unknown }).data).toEqual({
      vinculos: ["3 compromisso(s) na agenda"],
      por_tabela: { calendar_appointments: 3 },
    });
  });

  it("só compromisso cancelado: nenhum vínculo, a exclusão é liberada (A9)", async () => {
    estado.agenda = [{ contact_id: CONTATO, organization_id: ORG, status: "cancelled" }];

    const { status, body } = await consultarRota();

    expect(status).toBe(200);
    expect((body as unknown as { data: unknown }).data).toEqual({
      vinculos: [],
      por_tabela: {},
    });
  });

  it("o compromisso de outra organização não aparece", async () => {
    estado.agenda = [{ contact_id: CONTATO, organization_id: ORG_ALHEIA, status: "confirmed" }];

    const { status, body } = await consultarRota();

    expect(status).toBe(200);
    expect((body as unknown as { data: unknown }).data).toEqual({
      vinculos: [],
      por_tabela: {},
    });
  });

  it("ficha que a organização não enxerga responde 404, sem contar nada", async () => {
    estado.contatoVisivel = false;
    estado.agenda = [{ contact_id: CONTATO, organization_id: ORG, status: "confirmed" }];

    const { status } = await consultarRota();

    expect(status).toBe(404);
  });
});

function comQuery(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

function montarTabela() {
  return render(
    comQuery(
      <ContactsTable
        contacts={[CONTATO_LINHA]}
        orderBy="last_activity_at"
        orderDir="desc"
        onSort={() => {}}
      />,
    ),
  );
}

async function abrirExclusao() {
  montarTabela();
  fireEvent.click(screen.getByTitle("Excluir contato"));
}

describe("diálogo 'Excluir contato?' — o aviso antes do clique", () => {
  it("com compromisso: nomeia o vínculo e leva para a Agenda", async () => {
    getMock.mockResolvedValue({ data: { por_tabela: { calendar_appointments: 1 } } });

    await abrirExclusao();

    expect(
      await screen.findByText(
        "Este contato tem 1 compromisso não cancelado na Agenda. Cancele o compromisso antes de excluir.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Abrir Agenda" })).toHaveAttribute(
      "href",
      "/app/agenda",
    );
    expect(getMock).toHaveBeenCalledWith(`/api/v1/contacts/${CONTATO}/vinculos`);
  });

  it("sem vínculo: nenhum aviso, e a exclusão passa", async () => {
    getMock.mockResolvedValue({ data: { por_tabela: {} } });

    await abrirExclusao();

    // O diálogo continua dizendo o que a ação faz — ele é confirmação, não
    // aviso. Esperar o título é o que separa "ainda não chegou a prévia" de
    // "não havia vínculo para avisar".
    expect(await screen.findByText("Excluir contato?")).toBeInTheDocument();
    expect(screen.queryByText(/Este contato tem/)).toBeNull();
    expect(screen.getByText(/e a conversa associada, se houver/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Excluir" }));
    // `mutateAsync` entra na fila do react-query: a chamada da rota vem no
    // mesmo tick seguinte, não dentro do `fireEvent`.
    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith(`/api/v1/contacts/${CONTATO}`),
    );
  });
});
