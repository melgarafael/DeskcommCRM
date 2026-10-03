// @vitest-environment node
//
// Os casos leem o texto de DENTRO do PDF gerado, pelo mesmo motivo de
// `lib/propostas/documento/pdf-do-documento.test.ts`: em jsdom o pdfjs-dist
// quebra ("Bad FCHECK in flate stream"). O render é o MESMO de
// `lib/propostas/pdf-da-proposta.ts`, então a prova aqui é a prova do produto:
// texto extraído do arquivo que o operador vai baixar.
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { extractPdfText } from "@/lib/ai/rag/extractors/pdf";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/users/nome-do-atendente", () => ({ nomesDosAtendentes: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), isServiceRoleConfigured: () => true }));
vi.mock("@/lib/i18n/dicionario", () => ({ traduzir: (texto: string) => texto }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// A marca da ORGANIZAÇÃO vem do settings em produção; aqui devolve uma fixa,
// para o cabeçalho ser determinístico e nenhum teste depender de logo externo.
vi.mock("@/lib/propostas/marca-da-organizacao-para-pdf", () => ({
  marcaDaOrganizacaoParaPdf: vi.fn(async () => ({
    appName: "Clínica Bem Viver",
    accentHex: "#0f766e",
    logoUrl: null,
  })),
}));

import { audit } from "@/lib/audit";

import { linhasDoHistorico, montarPdfDaConversa, type ConversaParaPdf, type MensagemParaPdf } from "./exporta-pdf";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "33333333-3333-4333-8333-333333333333";
const CONTATO_ID = "44444444-4444-4444-8444-444444444444";
const ATENDENTE_ID = "11111111-1111-4111-8111-111111111111";

/** A tradução da suíte é a identidade: a frase fixa sai igual no PDF. */
const t = (texto: string) => texto;

const conversa: ConversaParaPdf = {
  id: CONV_ID,
  channel: "whatsapp",
  status: "open",
  created_at: "2026-08-31T10:00:00.000Z",
  contato: { name: "José da Silva", display_name: null, phone_number: "+5511999990000" },
};

/**
 * A conversa fake de 3 mensagens — entregue EMBARALHADA de propósito: o PDF
 * promete ordem cronológica, e ordem lida do banco não é promessa de nada
 * (a rota lê do fim para o começo, é assim que o `limit` corta).
 *
 * 12:00Z/12:02Z/12:05Z = 09:00/09:02/09:05 no fuso da organização.
 */
function mensagensDe3(): MensagemParaPdf[] {
  const base = { type: "text", media_derived_text: null, edited_at: null, revoked_at: null, metadata: {} };
  return [
    {
      ...base,
      id: "m3",
      direction: "outbound",
      body: "Terceira mensagem do atendente",
      sent_via: "user",
      sent_by_user_id: ATENDENTE_ID,
      sent_at: "2026-09-01T12:05:00.000Z",
      created_at: "2026-09-01T12:05:00.000Z",
    },
    {
      ...base,
      id: "m1",
      direction: "inbound",
      body: "Primeira mensagem do cliente",
      sent_via: "external_device",
      sent_by_user_id: null,
      sent_at: "2026-09-01T12:00:00.000Z",
      created_at: "2026-09-01T12:00:00.000Z",
    },
    {
      ...base,
      id: "m2",
      direction: "inbound",
      body: "Segunda mensagem do cliente",
      sent_via: "external_device",
      sent_by_user_id: null,
      sent_at: "2026-09-01T12:02:00.000Z",
      created_at: "2026-09-01T12:02:00.000Z",
    },
  ];
}

const nomesDosUsuarios: Map<string, string | null> = new Map([[ATENDENTE_ID, "Ana Souza"]]);

type Linha = Record<string, unknown>;

/**
 * Um client Supabase falso com a cadeia que a rota usa
 * (`select → eq → order/limit/maybeSingle`). As tabelas vêm em ordem de
 * escrita real, não de leitura: a rota pede DESC e `linhasDoHistorico`
 * reordena — é esse desacoplamento que o teste mede.
 */
function clienteFalso(): SupabaseClient {
  const tabelas: Record<string, Linha[]> = {
    organizations: [
      {
        id: ORG_ID,
        legal_name: "Clínica Bem Viver LTDA",
        display_name: "Clínica Bem Viver",
        timezone: "America/Sao_Paulo",
      },
    ],
    conversations: [
      {
        id: CONV_ID,
        organization_id: ORG_ID,
        contact_id: CONTATO_ID,
        channel: "whatsapp",
        status: "open",
        created_at: "2026-08-31T10:00:00.000Z",
      },
    ],
    contacts: [
      {
        id: CONTATO_ID,
        organization_id: ORG_ID,
        name: "José da Silva",
        display_name: null,
        phone_number: "+5511999990000",
      },
    ],
    messages: [
      {
        id: "m3",
        organization_id: ORG_ID,
        conversation_id: CONV_ID,
        direction: "outbound",
        type: "text",
        body: "Terceira mensagem do atendente",
        sent_via: "user",
        sent_by_user_id: ATENDENTE_ID,
        sent_at: "2026-09-01T12:05:00.000Z",
        created_at: "2026-09-01T12:05:00.000Z",
        metadata: {},
      },
      {
        id: "m2",
        organization_id: ORG_ID,
        conversation_id: CONV_ID,
        direction: "inbound",
        type: "text",
        body: "Segunda mensagem do cliente",
        sent_via: "external_device",
        sent_by_user_id: null,
        sent_at: "2026-09-01T12:02:00.000Z",
        created_at: "2026-09-01T12:02:00.000Z",
        metadata: {},
      },
      {
        id: "m1",
        organization_id: ORG_ID,
        conversation_id: CONV_ID,
        direction: "inbound",
        type: "text",
        body: "Primeira mensagem do cliente",
        sent_via: "external_device",
        sent_by_user_id: null,
        sent_at: "2026-09-01T12:00:00.000Z",
        created_at: "2026-09-01T12:00:00.000Z",
        metadata: {},
      },
    ],
  };

  const criar = (tabela: string) => {
    const filtros: Array<[string, unknown]> = [];
    let ordenar: { campo: string; asc: boolean } | null = null;
    let limite: number | null = null;

    const selecionar = (): Linha[] => {
      let saida = (tabelas[tabela] ?? []).filter((l) => filtros.every(([c, v]) => l[c] === v));
      const ordemAtual = ordenar;
      if (ordemAtual) {
        saida = [...saida].sort((a, b) => {
          const x = String(a[ordemAtual.campo] ?? "");
          const y = String(b[ordemAtual.campo] ?? "");
          return ordemAtual.asc ? x.localeCompare(y) : y.localeCompare(x);
        });
      }
      return limite === null ? saida : saida.slice(0, limite);
    };

    const cadeia = {
      select: () => cadeia,
      eq: (coluna: string, valor: unknown) => {
        filtros.push([coluna, valor]);
        return cadeia;
      },
      order: (campo: string, opts?: { ascending?: boolean }) => {
        ordenar = { campo, asc: opts?.ascending ?? true };
        return cadeia;
      },
      limit: (n: number) => {
        limite = n;
        return cadeia;
      },
      maybeSingle: async () => ({ data: selecionar()[0] ?? null, error: null }),
      then: (
        aoDar: ((v: unknown) => unknown) | null | undefined,
        aoFalhar: ((e: unknown) => unknown) | null | undefined,
      ) => Promise.resolve({ data: selecionar(), error: null }).then(aoDar, aoFalhar),
    };
    return cadeia;
  };

  return { from: (tabela: string) => criar(tabela) } as unknown as SupabaseClient;
}

function requisicao(query = "formato=pdf"): NextRequest {
  return new NextRequest(`http://localhost/api/v1/conversations/${CONV_ID}/export?${query}`);
}

function ctx(id = CONV_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function permitir(): void {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ATENDENTE_ID, idioma: "pt-BR", full_name: "Carlos Supervisor", email: "carlos@clinicabr.com" },
    org: { orgId: ORG_ID, name: "Clínica Bem Viver", role: "agent" },
  } as never);
}

async function rota() {
  return import("@/app/api/v1/conversations/[id]/export/route");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(nomesDosAtendentes).mockResolvedValue(new Map(nomesDosUsuarios));
});

describe("conversas/exporta-pdf", () => {
  it("coloca as 3 mensagens da conversa fake em ordem cronológica, com autor e horário", async () => {
    const pdf = await montarPdfDaConversa(clienteFalso(), ORG_ID, conversa, mensagensDe3(), {
      t,
      exportadoPor: "Carlos Supervisor",
      nomesDosUsuarios,
      geradoEm: "2026-10-03T15:30:00.000Z",
    });

    expect(pdf.ok).toBe(true);
    if (!pdf.ok) throw new Error(pdf.motivo);
    expect(pdf.nomeDoArquivo).toBe("historico-conversa-jose-da-silva-2026-10-03.pdf");

    const texto = await extractPdfText(pdf.buffer);

    // As 3 estão, e estão NA ORDEM — a ordem é a do tempo, não a de entrada.
    const p1 = texto.indexOf("Primeira mensagem do cliente");
    const p2 = texto.indexOf("Segunda mensagem do cliente");
    const p3 = texto.indexOf("Terceira mensagem do atendente");
    expect([p1, p2, p3].every((p) => p >= 0)).toBe(true);
    expect(p1).toBeLessThan(p2);
    expect(p2).toBeLessThan(p3);

    // Autor + horário, na MESMA linha, acima do corpo da mensagem.
    expect(texto).toContain("José da Silva · 01/09/2026 09:00 · recebida");
    expect(texto).toContain("José da Silva · 01/09/2026 09:02 · recebida");
    expect(texto).toContain("Ana Souza · 01/09/2026 09:05 · enviada");

    // Cabeçalho datado, com quem baixou e o controlador no rodapé.
    expect(texto).toContain("Histórico da conversa");
    expect(texto).toContain("José da Silva · whatsapp");
    expect(texto).toContain("Mensagens: 3");
    expect(texto).toContain("Exportado por: Carlos Supervisor em 03/10/2026 12:30");
    expect(texto).toContain("Clínica Bem Viver LTDA");
  });

  it("linhasDoHistorico ordena pelo tempo, com autor, horário e direção em cada linha", () => {
    const linhas = linhasDoHistorico(conversa, mensagensDe3(), { t, nomesDosUsuarios });

    expect(linhas.map((l) => l.id)).toEqual(["m1", "m2", "m3"]);
    expect(linhas.map((l) => l.horario)).toEqual([
      "01/09/2026 09:00",
      "01/09/2026 09:02",
      "01/09/2026 09:05",
    ]);
    expect(linhas.map((l) => l.autor)).toEqual(["José da Silva", "José da Silva", "Ana Souza"]);
    expect(linhas.map((l) => l.direcao)).toEqual(["inbound", "inbound", "outbound"]);
    expect(linhas.map((l) => l.texto)).toEqual([
      "Primeira mensagem do cliente",
      "Segunda mensagem do cliente",
      "Terceira mensagem do atendente",
    ]);
  });

  it("mensagem apagada pelo autor fica como linha, sem o texto que saiu do ar", () => {
    const apagada = mensagensDe3()[0] as MensagemParaPdf;
    const linhas = linhasDoHistorico(conversa, [
      { ...apagada, body: "o texto que a pessoa apagou", revoked_at: "2026-09-01T12:10:00.000Z" },
    ], { t });

    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.texto).toBe("Mensagem apagada pelo autor.");
    expect(linhas[0]?.texto).not.toContain("o texto que a pessoa apagou");
  });

  it("GET com papel errado (viewer) devolve 403 e não toca no banco", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Permissão insuficiente. Requer role >= agent.", 403, {
        requestId: "req-403",
      }),
    } as never);

    const { GET } = await rota();
    const res = await GET(requisicao(), ctx());

    expect(res.status).toBe(403);
    // Gate antes de qualquer leitura: sem papel não há client, não há query,
    // não há render — nada do histórico chega a ser buscado.
    expect(createClient).not.toHaveBeenCalled();
  });

  it("GET com papel certo devolve o PDF baixável, datado no nome, e audita sem PII", async () => {
    permitir();
    vi.mocked(createClient).mockResolvedValue(clienteFalso() as never);

    const { GET } = await rota();
    const res = await GET(requisicao(), ctx());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="historico-conversa-jose-da-silva-\d{4}-\d{2}-\d{2}\.pdf"$/,
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const texto = await extractPdfText(Buffer.from(await res.arrayBuffer()));
    expect(texto).toContain("Primeira mensagem do cliente");
    expect(texto).toContain("José da Silva · 01/09/2026 09:00 · recebida");
    expect(texto).toContain("Ana Souza · 01/09/2026 09:05 · enviada");

    // Audit: quem, qual conversa e QUANTAS linhas — nunca o corpo da mensagem.
    expect(audit).toHaveBeenCalledWith({
      action: "conversation.exported",
      actorUserId: ATENDENTE_ID,
      organizationId: ORG_ID,
      resourceType: "conversation",
      resourceId: CONV_ID,
      requestId: expect.any(String),
      metadata: { mensagens: 3, formato: "pdf" },
    });
  });

  it("GET pedindo outro formato não devolve PDF em silêncio: 422", async () => {
    permitir();

    const { GET } = await rota();
    const res = await GET(requisicao("formato=csv"), ctx());

    expect(res.status).toBe(422);
    expect(createClient).not.toHaveBeenCalled();
  });
});
