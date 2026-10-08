import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { getLeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";

/**
 * RAG E CONTEXTO CALAM PARA PESSOAL (spec 21, etapa 9).
 *
 * Conversa de pessoal nunca é ingerida no acervo; ao marcar, o que já foi
 * ingerido sai do alcance (`usable_for_rag=false`); o turno nunca usa pessoal
 * (guard `contact_personal`, mesma família do bloqueio); e o contexto do
 * agente carrega a marca lida na hora.
 *
 * ─── SABOTAGEM (prova no CI) ───────────────────────────────────────────────
 * - Tirar o filtro do lote mas manter o zerar no marcar: conversa marcada
 *   DEPOIS de ingerida continua respondível (o caso "lote exclui" cai e o
 *   "marcar zera o passado" continua verde — é por isso que são dois casos).
 * - Tirar o `skip("contact_personal")`: o turno volta a rodar para pessoal.
 * - Tirar `is_personal` do payload do contexto: o caso "contexto sinaliza" cai.
 * Linha para reverter: `lib/ai/rag/ingest/conversations.ts`,
 * `workers/ai-response-worker.ts`, `lib/agent-engine/edge/crm/get-lead-context.ts`,
 * `app/api/v1/contacts/[id]/personal/route.ts`.
 */

const RAIZ = process.cwd();
const fonte = (...partes: string[]) => fs.readFileSync(path.join(RAIZ, ...partes), "utf8");
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const LOTE = semComentarios(fonte("lib", "ai", "rag", "ingest", "conversations.ts"));
const GUARD = semComentarios(fonte("workers", "ai-response-worker.ts"));
const ROTA = semComentarios(
  fonte("app", "api", "v1", "contacts", "[id]", "personal", "route.ts"),
);
const CONTEXTO = semComentarios(
  fonte("lib", "agent-engine", "edge", "crm", "get-lead-context.ts"),
);

describe("RAG nunca ingere pessoal", () => {
  it("o lote exclui conversas de contatos pessoais na leitura", () => {
    expect(LOTE).toMatch(/semConversasDePessoal/);
    expect(LOTE).toMatch(/\.eq\("is_personal",\s*true\)/);
  });

  it("marcar zera usable_for_rag (o passado sai do acervo)", () => {
    expect(ROTA).toMatch(/usable_for_rag/);
    expect(ROTA).toMatch(/\.update\(\{\s*usable_for_rag:\s*false\s*\}\)/);
  });
});

describe("turno nunca roda para pessoal", () => {
  it("o guard pula com motivo próprio, ao lado do bloqueio", () => {
    expect(GUARD).toMatch(/skip\("contact_personal"\)/);
    expect(GUARD).toMatch(/contacts:contact_id\([^)]*is_personal/);
  });

  it("o motivo existe no vocabulário de skip", () => {
    const tipos = semComentarios(fonte("lib", "ai", "types.ts"));
    expect(tipos).toMatch(/"contact_personal"/);
  });
});

describe("contexto do agente sinaliza pessoal", () => {
  it("o payload carrega is_personal lido na hora", () => {
    expect(CONTEXTO).toMatch(/is_personal:\s*contact\.is_personal/);
  });

  it("com contato pessoal, o contexto vem marcado", async () => {
    const db = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: vi.fn(async (sql: string, _params: any[]) => {
        if (sql.includes("from contacts")) {
          return {
            rows: [
              {
                name: "Fulano",
                display_name: null,
                email: null,
                phone_number: "+5511999999999",
                tags: [],
                is_blocked: false,
                is_personal: true,
                source: "whatsapp",
                consent: null,
                is_anonymized: false,
              },
            ],
          };
        }
        if (sql.includes("crm_lead_activities")) return { rows: [] };
        if (sql.includes("from messages")) return { rows: [] };
        if (sql.includes("from demandas")) return { rows: [] };
        if (sql.includes("from crm_proposals")) throw new Error("sem propostas aqui");
        if (sql.includes("from crm_leads")) return { rows: [] };
        throw new Error(`query não mockada: ${sql.slice(0, 60)}`);
      }),
    };
    const r = await getLeadContext(
      db as never,
      {} as never,
      {
        tenantId: "11111111-1111-4111-8111-111111111111",
        leadId: "22222222-2222-4222-8222-222222222222",
        conversationId: "33333333-3333-4333-8333-333333333333",
        fuso: "America/Sao_Paulo",
      },
      { historyLimit: 20, maxTokens: 1000 },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.context.contact.is_personal).toBe(true);
  });
});
