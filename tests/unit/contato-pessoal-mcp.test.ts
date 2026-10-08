import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/types";
import {
  listLeadsHandler,
  getLeadHandler,
  updateLeadHandler,
  moveLeadHandler,
  retomarLeadHandler,
} from "@/app/api/v1/leads/_handler";
import { crmSearchContacts, crmGetContact } from "@/lib/mcp/tools/contacts";
import { crmGetConversation, crmGetConversationHistory } from "@/lib/mcp/tools/conversations";
import { crmGetLead } from "@/lib/mcp/tools/leads";
import { crmStartConversationAndSend } from "@/lib/mcp/tools/start-conversation";

/**
 * MCP: LEITURA EXCLUI, ESCRITA RECUSA (spec 21, etapa 12).
 *
 * Leitura (lista, busca, ficha, histórico) não devolve pessoal; escrita
 * (criar lead, mover, retomar, enviar, abrir conversa) recusa pessoal.
 * `crm_send_whatsapp_message` herda a recusa do `sendMessageHandler` (etapa
 * 11); `crm_start_conversation_and_send` recusa ANTES de abrir, para não
 * nascer conversa vazia; `crm_propose_contact_field` NÃO muda (D9).
 *
 * ─── SABOTAGEM (prova no CI) ───────────────────────────────────────────────
 * - Tirar a recusa do `crm_get_contact`: a ficha de pessoal abre e o caso
 *   "ficha recusa" cai (vaza telefone/e-mail ao assistente externo).
 * - Tirar o diagnóstico de 404 da conversa/histórico/lead: o modelo recebe
 *   "não encontrado" para o que existe e o caso do motivo cai.
 * - Tirar o `.not("contact_id", ...)` do `listLeadsHandler`: o negócio de
 *   pessoal volta à lista e o caso da lista cai.
 * - Tirar a checagem de `openSharedContactConversation`: a rota
 *   `open-with-contact` volta a abrir conversa para pessoal.
 * - Tirar a pré-checagem do `crm_start_conversation_and_send`: nasce conversa
 *   vazia antes do `send` recusar.
 * Linha para reverter: `lib/mcp/tools/contacts.ts`,
 * `lib/mcp/tools/conversations.ts`, `lib/mcp/tools/leads.ts`,
 * `lib/mcp/tools/start-conversation.ts`, `app/api/v1/leads/_handler.ts`,
 * `lib/messaging/open-shared-contact-conversation.ts`,
 * `app/api/v1/conversations/open-with-contact/route.ts`,
 * `app/api/v1/calls/route.ts`, `app/api/v1/voice/calls/history/route.ts`.
 */

const RAIZ = process.cwd();
const fonte = (...partes: string[]) => fs.readFileSync(path.join(RAIZ, ...partes), "utf8");
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO_PESSOAL = "33333333-3333-4333-8333-333333333333";
const CONTATO_LIVRE = "44444444-4444-4444-8444-444444444444";
const CONV = "22222222-2222-4222-8222-222222222222";
const SESSAO = "55555555-5555-4555-8555-555555555555";

function ctxMcp(supabase: unknown) {
  return {
    supabase,
    organizationId: ORG,
    role: "agent",
    actor: { type: "user", id: "u-1" },
    apiTokenId: "tok-1",
    requestId: "req-1",
  } as never;
}

function ctxHandler() {
  return {
    organization_id: ORG,
    actor: { type: "user", id: "u-1" },
    requestId: "req-1",
  } as never;
}

function contato(pessoal: boolean) {
  return {
    id: pessoal ? CONTATO_PESSOAL : CONTATO_LIVRE,
    organization_id: ORG,
    name: null,
    display_name: pessoal ? "Mãe" : "Cliente",
    email: null,
    phone_number: "+5511999999999",
    cpf_hash: null,
    birthdate: null,
    is_blocked: false,
    blocked_reason: null,
    is_personal: pessoal,
    is_anonymized: false,
    anonymized_at: null,
    is_merged_into: null,
    merged_at: null,
    consent: {},
    tags: [],
    source: "manual",
    source_metadata: {},
    custom_fields: {},
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    last_activity_at: null,
    first_service_at: null,
  };
}

/** Fake para `getContactHandler`: contatos por maybeSingle + conversas do `withConversas`. */
function bancoFicha(pessoal: boolean) {
  return {
    from: (tabela: string) => ({
      select: () => {
        if (tabela === "conversations") {
          const q: {
            eq: () => unknown;
            in: () => unknown;
            order: () => Promise<{ data: unknown[]; error: null }>;
          } = {
            eq: () => q,
            in: () => q,
            order: () => Promise.resolve({ data: [], error: null }),
          };
          return q;
        }
        const q: { eq: () => unknown; maybeSingle: () => Promise<{ data: unknown; error: null }> } = {
          eq: () => q,
          maybeSingle: async () => ({ data: contato(pessoal), error: null }),
        };
        return q;
      },
    }),
  } as never;
}

describe("crm_get_contact recusa pessoal no tool (não na ficha da tela)", () => {
  it("pessoal devolve permitido:false com motivo contato_pessoal", async () => {
    const r = (await crmGetContact.handler(
      { contact_id: CONTATO_PESSOAL },
      ctxMcp(bancoFicha(true)),
    )) as Record<string, unknown>;
    expect(r).toMatchObject({ permitido: false, motivo: "contato_pessoal" });
    expect(String(r.mensagem)).toMatch(/pessoal/);
  });

  it("contato normal abre e carrega is_personal da coluna", async () => {
    const r = (await crmGetContact.handler(
      { contact_id: CONTATO_LIVRE },
      ctxMcp(bancoFicha(false)),
    )) as Record<string, unknown>;
    expect(r).toMatchObject({ id: CONTATO_LIVRE, is_personal: false });
  });
});

describe("crm_search_contacts carrega is_personal da coluna (a exclusão chega na etapa 13)", () => {
  function bancoBusca() {
    return {
      from: (tabela: string) => ({
        select: () => {
          if (tabela === "conversations") {
            const q: {
              eq: () => unknown;
              in: () => unknown;
              order: () => Promise<{ data: unknown[]; error: null }>;
            } = {
              eq: () => q,
              in: () => q,
              order: () => Promise.resolve({ data: [], error: null }),
            };
            return q;
          }
          const q: {
            eq: () => unknown;
            is: () => unknown;
            order: () => unknown;
            limit: () => unknown;
            or: () => unknown;
            then: (ok: (v: unknown) => unknown) => unknown;
          } = {
            eq: () => q,
            is: () => q,
            order: () => q,
            limit: () => q,
            or: () => q,
            then: (ok) =>
              Promise.resolve({ data: [contato(true), contato(false)], error: null }).then(ok),
          };
          return q;
        },
      }),
    } as never;
  }

  it("cada item diz se é pessoal (elo coluna → ferramenta)", async () => {
    const r = (await crmSearchContacts.handler({ query: "mae", limit: 10 }, ctxMcp(bancoBusca()))) as {
      contacts: Array<{ id: string; is_personal: boolean }>;
    };
    expect(r.contacts.find((c) => c.id === CONTATO_PESSOAL)?.is_personal).toBe(true);
    expect(r.contacts.find((c) => c.id === CONTATO_LIVRE)?.is_personal).toBe(false);
  });
});

/** Fake para o 404 do `getConversationHandler` + a leitura diagnóstica. */
function bancoConversa404(diagnosticoPessoal: boolean | null) {
  return {
    from: () => ({
      select: (s: string) => {
        const ehDiagnostico = s.includes("contacts:contact_id(is_personal)");
        const q: { eq: () => unknown; maybeSingle: () => Promise<{ data: unknown; error: null }> } = {
          eq: () => q,
          maybeSingle: async () =>
            ehDiagnostico
              ? {
                  data:
                    diagnosticoPessoal === null
                      ? null
                      : {
                          contact_id: CONTATO_PESSOAL,
                          contacts: { is_personal: diagnosticoPessoal },
                        },
                  error: null,
                }
              : { data: null, error: null },
        };
        return q;
      },
    }),
  } as never;
}

describe("crm_get_conversation não distingue pessoal (404 mudo)", () => {
  const entrada = { conversation_id: CONV };

  it("conversa de pessoal com turno recebe a MESMA recusa de outra conversa", async () => {
    const ctx = {
      ...(ctxMcp(bancoConversa404(true)) as Record<string, unknown>),
      contatoDoTurno: CONTATO_LIVRE,
    };
    const r = (await crmGetConversation.handler(entrada, ctx as never)) as Record<string, unknown>;
    expect(r).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
  });

  it("conversa de pessoal sem turno dá o mesmo 404 de uuid inexistente", async () => {
    const r1 = crmGetConversation.handler(entrada, ctxMcp(bancoConversa404(true)));
    await expect(r1).rejects.toMatchObject({ status: 404 });
    const r2 = crmGetConversation.handler(entrada, ctxMcp(bancoConversa404(false)));
    await expect(r2).rejects.toMatchObject({ status: 404 });
  });

  it("uuid que não existe com turno continua fora_da_conversa", async () => {
    const ctx = {
      ...(ctxMcp(bancoConversa404(null)) as Record<string, unknown>),
      contatoDoTurno: CONTATO_LIVRE,
    };
    const r = (await crmGetConversation.handler(entrada, ctx as never)) as Record<string, unknown>;
    expect(r).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
  });
});

/** Fake para o histórico sem turno: duas leituras planas (conversa, contato). */
function bancoHistoricoPessoal() {
  const linha =
    (tabela: string) =>
    (tabela === "conversations" ? [{ contact_id: CONTATO_PESSOAL }] : [{ is_personal: true }]);
  return {
    from: (tabela: string) => ({
      select: () => {
        const q: {
          eq: () => unknown;
          limit: () => unknown;
          then: (ok: (v: unknown) => unknown) => unknown;
        } = {
          eq: () => q,
          limit: () => q,
          then: (ok) => Promise.resolve(ok({ data: linha(tabela), error: null })),
        };
        return q;
      },
    }),
  } as never;
}

describe("crm_get_conversation_history não distingue pessoal (404 mudo)", () => {
  it("histórico de pessoal sem turno dá 404 como uuid inexistente", async () => {
    const r = crmGetConversationHistory.handler(
      { conversation_id: CONV, limit: 20 },
      ctxMcp(bancoHistoricoPessoal()),
    );
    await expect(r).rejects.toMatchObject({ status: 404 });
  });
});

/** Fake para os handlers de lead: crm_leads + contacts por maybeSingle. */
function bancoLeads(lead: Record<string, unknown> | null, pessoal: boolean | null) {
  return {
    from: (tabela: string) => ({
      select: (s: string) => {
        const q: { eq: () => unknown; maybeSingle: () => Promise<{ data: unknown; error: null }> } = {
          eq: () => q,
          maybeSingle: async () => {
            if (tabela === "crm_leads") {
              if (s.trim() === "contact_id") {
                return {
                  data: lead ? { contact_id: (lead as { contact_id?: string }).contact_id } : null,
                  error: null,
                };
              }
              return { data: lead, error: null };
            }
            return { data: pessoal === null ? null : { is_personal: pessoal }, error: null };
          },
        };
        return q;
      },
    }),
  } as never;
}

const LEAD_DE_PESSOAL = {
  id: "lead-1",
  organization_id: ORG,
  contact_id: CONTATO_PESSOAL,
  pipeline_id: "p-1",
  status: "open",
  title: "Negócio",
  owner_user_id: null,
};

describe("crm_get_lead recusa pessoal; escrita de lead recusa no handler", () => {
  it("ficha de negócio de pessoal devolve contato_pessoal", async () => {
    const r = (await crmGetLead.handler(
      { lead_id: "lead-1" },
      ctxMcp(bancoLeads(LEAD_DE_PESSOAL, true)),
    )) as Record<string, unknown>;
    expect(r).toMatchObject({ permitido: false, motivo: "contato_pessoal" });
  });

  it("negócio normal abre (sem turno, mesma org)", async () => {
    const leadLivre = { ...LEAD_DE_PESSOAL, contact_id: CONTATO_LIVRE };
    const r = (await crmGetLead.handler(
      { lead_id: "lead-1" },
      ctxMcp(bancoLeads(leadLivre, false)),
    )) as { lead: Record<string, unknown> };
    expect(r.lead).toMatchObject({ id: "lead-1" });
  });

  it("trocar o contato para um pessoal leva 403 (update)", async () => {
    const err = await updateLeadHandler(
      bancoLeads({ ...LEAD_DE_PESSOAL, contact_id: CONTATO_LIVRE }, true) as never,
      ctxHandler(),
      "lead-1",
      { contact_id: CONTATO_PESSOAL } as never,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });

  it("trocar para contato inexistente continua 404 (a guarda não virou manta)", async () => {
    const err = await updateLeadHandler(
      bancoLeads({ ...LEAD_DE_PESSOAL, contact_id: CONTATO_LIVRE }, null) as never,
      ctxHandler(),
      "lead-1",
      { contact_id: CONTATO_PESSOAL } as never,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });

  it("mover negócio de pessoal leva 403 antes de ler a etapa", async () => {
    const err = await moveLeadHandler(
      bancoLeads(LEAD_DE_PESSOAL, true) as never,
      ctxHandler(),
      "lead-1",
      { to_stage_id: "st-1" } as never,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });

  it("retomar negócio de pessoal leva 403", async () => {
    const origem = { ...LEAD_DE_PESSOAL, status: "lost" };
    const err = await retomarLeadHandler(
      bancoLeads(origem, true) as never,
      ctxHandler(),
      "lead-1",
      {},
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });
});

describe("listLeadsHandler exclui pessoal no banco (leitura exclui)", () => {
  function bancoLista() {
    const excluidos = new Set<string>();
    const cadeia = (dados: Array<Record<string, unknown>>) => {
      const q: {
        eq: () => unknown;
        in: () => unknown;
        not: (_c: string, _op: string, v: string) => unknown;
        or: () => unknown;
        order: () => unknown;
        limit: () => unknown;
        then: (ok: (v: unknown) => unknown) => unknown;
      } = {
        eq: () => q,
        in: () => q,
        not: (_c, _op, v) => {
          String(v)
            .replace(/[()]/g, "")
            .split(",")
            .filter(Boolean)
            .forEach((id) => excluidos.add(id));
          return q;
        },
        or: () => q,
        order: () => q,
        limit: () => q,
        then: (ok) =>
          Promise.resolve({
            data: dados.filter((r) => !excluidos.has(String(r.contact_id ?? r.id))),
            error: null,
          }).then(ok),
      };
      return q;
    };
    return {
      from: (tabela: string) => ({
        select: () =>
          cadeia(
            tabela === "contacts"
              ? [{ id: CONTATO_PESSOAL }]
              : [
                  {
                    id: "lead-p",
                    organization_id: ORG,
                    contact_id: CONTATO_PESSOAL,
                    created_at: "2026-10-01T00:00:00.000Z",
                  },
                  {
                    id: "lead-ok",
                    organization_id: ORG,
                    contact_id: CONTATO_LIVRE,
                    created_at: "2026-10-02T00:00:00.000Z",
                  },
                ],
          ),
      }),
    } as never;
  }

  it("negócio de pessoal não sai na lista; o normal sai", async () => {
    const r = await listLeadsHandler(bancoLista(), ctxHandler(), {});
    const ids = r.leads.map((l) => String(l.id));
    expect(ids).not.toContain("lead-p");
    expect(ids).toContain("lead-ok");
  });
});

describe("abrir conversa com pessoal recusa antes de nascer (tool + ponto único + rota)", () => {
  function bancoAbertura() {
    return {
      from: (tabela: string) => ({
        select: (s: string) => {
          if (s.includes("is_personal")) {
            const q: { eq: () => unknown; maybeSingle: () => Promise<{ data: unknown; error: null }> } = {
              eq: () => q,
              maybeSingle: async () => ({ data: { is_personal: true }, error: null }),
            };
            return q;
          }
          const q: {
            eq: () => unknown;
            in: () => unknown;
            is: () => unknown;
            limit: () => Promise<{ data: unknown[]; error: null }>;
          } = {
            eq: () => q,
            in: () => q,
            is: () => q,
            limit: () =>
              Promise.resolve({
                data: [{ id: CONTATO_PESSOAL, phone_number: "+5511999999999" }],
                error: null,
              }),
          };
          return q;
        },
      }),
    } as never;
  }

  it("por contact_id: recusa sem abrir", async () => {
    const r = (await crmStartConversationAndSend.handler(
      { channel_session_id: SESSAO, contact_id: CONTATO_PESSOAL, type: "text", body: "oi" },
      ctxMcp(bancoAbertura()),
    )) as Record<string, unknown>;
    expect(r).toMatchObject({ permitido: false, motivo: "contato_pessoal" });
  });

  it("por telefone de pessoal: recusa sem abrir", async () => {
    const r = (await crmStartConversationAndSend.handler(
      { channel_session_id: SESSAO, phone_number: "+5511999999999", type: "text", body: "oi" },
      ctxMcp(bancoAbertura()),
    )) as Record<string, unknown>;
    expect(r).toMatchObject({ permitido: false, motivo: "contato_pessoal" });
  });

  it("o ponto único recusa (defesa da rota open-with-contact)", () => {
    const src = semComentarios(fonte("lib", "messaging", "open-shared-contact-conversation.ts"));
    expect(src).toMatch(/is_personal/);
    expect(src).toMatch(/contact_personal/);
  });

  it("a rota traduz contact_personal em 403", () => {
    const src = semComentarios(
      fonte("app", "api", "v1", "conversations", "open-with-contact", "route.ts"),
    );
    expect(src).toMatch(/contact_personal/);
    expect(src).toMatch(/403/);
  });
});

describe("envio e chamadas: herança e cercas no código", () => {
  it("crm_send_whatsapp_message delega ao sendMessageHandler (herda o 403 da etapa 11)", () => {
    const src = semComentarios(fonte("lib", "mcp", "tools", "messages.ts"));
    expect(src).toMatch(/sendMessageHandler\(/);
  });

  it("POST /api/v1/calls recusa pessoal (contato ou lead)", () => {
    const src = semComentarios(fonte("app", "api", "v1", "calls", "route.ts"));
    expect(src).toMatch(/is_personal/);
    expect(src).toMatch(/forbidden/);
  });

  it("GET /api/v1/calls e o histórico de voz escondem pessoal (mesma primitiva do inbox)", () => {
    for (const partes of [
      ["app", "api", "v1", "calls", "route.ts"],
      ["app", "api", "v1", "voice", "calls", "history", "route.ts"],
    ] as Array<string[]>) {
      const src = semComentarios(fonte(...partes));
      expect(src).toMatch(/idsDeContatosPessoais/);
      expect(src).toMatch(/\.not\("contact_id",\s*"in"/);
    }
  });
});

describe("getLeadHandler some com pessoal até por link direto", () => {
  it("ficha de negócio de pessoal dá 404 (não 403, para não revelar)", async () => {
    const err = await getLeadHandler(
      bancoLeads(LEAD_DE_PESSOAL, true) as never,
      ctxHandler(),
      "lead-1",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });
});
