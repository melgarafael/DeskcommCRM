/**
 * "NÃO TENHO INTERESSE" NA PROSPECÇÃO VIRA RECUSA GRAVADA — E SÓ NA PROSPECÇÃO.
 *
 * Decisão D3 do dono: quem disse que não tem interesse não volta a ser abordado. Antes
 * desta peça a frase não ficava gravada em lugar nenhum: a régua ambígua do PARAR só
 * pegava "já disse que não tenho interesse" e, mesmo assim, só escalava para humano
 * (`lib/opt-out/deteccao.ts`). A empresa que disse "não" seguia elegível para a próxima
 * campanha e para o reaproveitamento da lista.
 *
 * O que este arquivo prende, pela entrada REAL de mensagem (`aplicarEfeitosPosEntrada`):
 *
 * 1. na conversa que a prospecção abriu (`metadata.prospecting_campaign_id`), a frase
 *    grava `consent.marketing` no formato que `recusaRegistrada` lê — e, por isso, a
 *    guarda da prospecção (`contactMayBeProspected`) e a das Campanhas recusam o contato;
 * 2. a auditoria `lgpd.consent_changed` sai, sem o texto da mensagem;
 * 3. o negócio aberto da PROSPECÇÃO é encerrado como perdido, com o rótulo do funil;
 * 4. FORA da prospecção a mesma frase não grava nada;
 * 5. não toca `is_blocked`: o PARAR é outra regra, e segue sendo o único a bloquear.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Tirar a checagem de `campanhaDeProspeccaoDaConversa` em `pos-entrada.ts`: o caso
 *   "fora da prospecção" fica vermelho (a recusa é gravada no atendimento comum).
 * - Tirar a chamada `aplicarSemInteresseDaProspeccao` da entrada: os casos 1-3 ficam
 *   vermelhos.
 * - Tirar o passo "sem-interesse" de `aplicarEfeitosDaRecuperacao`: o caso da
 *   recuperação fica vermelho.
 * - Tirar o `.eq("organization_id")` da leitura da conversa: o caso da cerca fica vermelho.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { EntradaDaRecuperacao, EntradaDeMensagem } from "@/lib/channels/pos-entrada";
import { contactMayBeProspected } from "@/lib/prospecting/guard";
import { recusouMarketing } from "@/lib/campanhas/elegibilidade";

const audit = vi.fn(async (..._a: unknown[]) => {});
const encerraDemanda = vi.fn(async (..._a: unknown[]) => ({ lead: {}, jaEstava: false }) as never);
const garantirLeadDaConversa = vi.fn(async () => ({ criado: false, motivo: "ja_existe" }) as never);

vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));
vi.mock("@/lib/leads/encerramento", () => ({
  encerraDemanda: (...a: unknown[]) => encerraDemanda(...a),
}));
vi.mock("@/lib/leads/nascimento-do-lead", () => ({
  garantirLeadDaConversa: () => garantirLeadDaConversa(),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({
  acelerarFollowupDoInbound: vi.fn(async () => {}),
  drenarEventosDoInbound: vi.fn(async () => {}),
  acelerarPipelineDeEventos: vi.fn(async () => {}),
  kickLocalPipeline: vi.fn(async () => {}),
}));

interface Cena {
  metadataDaConversa: Record<string, unknown> | null;
  consent: Record<string, unknown>;
  leadsDaProspeccao: Array<{ id: string; pipeline_id: string }>;
  settingsDoFunil: Record<string, unknown>;
}

let cena: Cena;
let updatesDeContato: Array<Record<string, unknown>>;
let filtrosDeLeads: Array<[string, unknown]>;
/** Os filtros `.eq` de CADA leitura de `conversations`. */
let leiturasDaConversa: Array<Array<[string, unknown]>>;

/** Builder encadeável do PostgREST: o efeito acontece no `await` ou no `maybeSingle`. */
function consulta(tabela: string) {
  let patch: Record<string, unknown> | null = null;
  const resposta = (): { data: unknown; error: null } => {
    if (patch) {
      if (tabela === "contacts") {
        updatesDeContato.push(patch);
        if (patch.consent) cena.consent = patch.consent as Record<string, unknown>;
        // A gravação da recusa confere a linha alterada (`.select("id")`).
        return { data: [{ id: "contato-1" }], error: null };
      }
      return { data: null, error: null };
    }
    if (tabela === "conversations") return { data: { metadata: cena.metadataDaConversa }, error: null };
    if (tabela === "contacts")
      return { data: { id: "contato-1", consent: cena.consent, is_anonymized: false }, error: null };
    if (tabela === "crm_leads") return { data: cena.leadsDaProspeccao, error: null };
    if (tabela === "crm_pipelines")
      return { data: [{ id: "funil-prospeccao", settings: cena.settingsDoFunil }], error: null };
    return { data: null, error: null };
  };
  const q: Record<string, unknown> = {};
  const encadeia = () => q;
  const filtrosDaConversa: Array<[string, unknown]> = [];
  if (tabela === "conversations") leiturasDaConversa.push(filtrosDaConversa);
  for (const m of ["select", "eq", "is", "in", "order", "limit", "neq", "gte", "lte", "not"]) {
    q[m] = (...args: unknown[]) => {
      if (tabela === "crm_leads" && m === "eq") filtrosDeLeads.push([args[0] as string, args[1]]);
      if (tabela === "conversations" && m === "eq") filtrosDaConversa.push([args[0] as string, args[1]]);
      return encadeia();
    };
  }
  q.update = (p: Record<string, unknown>) => {
    patch = p;
    return q;
  };
  q.maybeSingle = async () => resposta();
  q.single = async () => resposta();
  q.then = (resolve: (v: unknown) => void) => Promise.resolve(resposta()).then(resolve);
  return q;
}

const admin = {
  from: (tabela: string) => consulta(tabela),
  rpc: async () => ({ data: null, error: null }),
} as never;

const ENTRADA: EntradaDeMensagem = {
  organizationId: "org-1",
  contactId: "contato-1",
  conversationId: "conversa-1",
  messageId: "msg-1",
  channelSessionId: "sessao-1",
  texto: "Não tenho interesse, obrigado.",
  nomeDoContato: "Oficina do Zé",
  requestId: "req-1",
  origem: "canal_de_teste",
};

async function rodar(over: Partial<EntradaDeMensagem> = {}) {
  const { aplicarEfeitosPosEntrada } = await import("@/lib/channels/pos-entrada");
  await aplicarEfeitosPosEntrada(admin, { ...ENTRADA, ...over });
}

const CONTATO_DA_GUARDA = {
  is_anonymized: false,
  source: "prospecting",
} as const;

// O grafo de `pos-entrada` é grande: a primeira importação passa do tempo de um caso.
beforeAll(async () => {
  await import("@/lib/channels/pos-entrada");
}, 120_000);

beforeEach(() => {
  cena = {
    metadataDaConversa: { prospecting_campaign_id: "campanha-1" },
    // Base legal documentada: sem a recusa, a guarda da prospecção DEIXA passar —
    // é isso que torna o "recusa depois" uma medida, e não um verde por outra razão.
    consent: { legitimate_interest: { ref: "LIA-2026-01" } },
    leadsDaProspeccao: [{ id: "lead-prospeccao", pipeline_id: "funil-prospeccao" }],
    settingsDoFunil: { lost_reasons: ["Preço", { label: "Não tem interesse" }] },
  };
  updatesDeContato = [];
  filtrosDeLeads = [];
  leiturasDaConversa = [];
  audit.mockClear();
  encerraDemanda.mockClear();
});

describe("na conversa de prospecção", () => {
  it("a frase grava a recusa de marketing, e a prospecção e as Campanhas passam a recusar o contato", async () => {
    expect(
      contactMayBeProspected({ ...CONTATO_DA_GUARDA, consent: cena.consent }),
      "controle: antes da frase, a guarda deixava abordar",
    ).toBe(true);

    await rodar();

    const marketing = cena.consent.marketing as Record<string, unknown>;
    expect(marketing).toMatchObject({ granted: false, motivo: "sem_interesse", origem: "conversa_de_prospeccao" });
    expect(typeof marketing.declined_at).toBe("string");
    expect(cena.consent.legitimate_interest, "a recusa apagou outra finalidade").toEqual({ ref: "LIA-2026-01" });
    expect(contactMayBeProspected({ ...CONTATO_DA_GUARDA, consent: cena.consent })).toBe(false);
    expect(recusouMarketing(cena.consent)).toBe(true);
  });

  it("audita lgpd.consent_changed sem o texto da mensagem", async () => {
    await rodar();
    const linhas = audit.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const consentimento = linhas.find((l) => l.action === "lgpd.consent_changed");
    expect(consentimento).toMatchObject({
      organizationId: "org-1",
      resourceType: "contact",
      resourceId: "contato-1",
      metadata: expect.objectContaining({
        finalidade: "marketing",
        consentimento: "recusado",
        motivo: "sem_interesse",
        origem: "conversa_de_prospeccao",
        prospecting_campaign_id: "campanha-1",
      }),
    });
    expect(JSON.stringify(consentimento)).not.toContain("obrigado");
  });

  it("encerra o negócio aberto da prospecção como perdido, com o rótulo do funil", async () => {
    await rodar();
    expect(filtrosDeLeads).toEqual(
      expect.arrayContaining([
        ["organization_id", "org-1"],
        ["contact_id", "contato-1"],
        ["source", "prospecting"],
        ["status", "open"],
      ]),
    );
    expect(encerraDemanda).toHaveBeenCalledTimes(1);
    expect(encerraDemanda.mock.calls[0]?.[2]).toMatchObject({
      leadId: "lead-prospeccao",
      desfecho: "lost",
      motivo: "Não tem interesse",
    });
  });

  it("sem rótulo no funil, o negócio fecha como 'other' — o banco recusaria texto fora do vocabulário", async () => {
    cena.settingsDoFunil = { lost_reasons: ["Preço"] };
    await rodar();
    expect(encerraDemanda.mock.calls[0]?.[2]).toMatchObject({ motivo: "other" });
  });

  it("NÃO toca is_blocked: o contato segue podendo conversar com a equipe", async () => {
    await rodar();
    expect(updatesDeContato.length).toBeGreaterThan(0);
    for (const u of updatesDeContato) expect(u).not.toHaveProperty("is_blocked");
  });

  it("uma segunda frase não regrava nem audita de novo (idempotente)", async () => {
    await rodar();
    const recusa = cena.consent.marketing;
    audit.mockClear();
    updatesDeContato = [];
    await rodar({ texto: "já falei, não temos interesse" });
    expect(cena.consent.marketing).toEqual(recusa);
    expect(updatesDeContato).toEqual([]);
    expect(audit.mock.calls.some((c) => (c[0] as { action?: string }).action === "lgpd.consent_changed")).toBe(
      false,
    );
  });

  it("toda leitura da conversa leva a cerca da organização e o id da conversa", async () => {
    await rodar();
    expect(leiturasDaConversa.length).toBeGreaterThan(0);
    for (const filtros of leiturasDaConversa) {
      expect(filtros).toEqual(
        expect.arrayContaining([
          ["organization_id", "org-1"],
          ["id", "conversa-1"],
        ]),
      );
    }
  });

  it("frase de cliente escolhendo não grava nem fecha o negócio", async () => {
    await rodar({ texto: "Não tenho interesse no plano mensal, quero o anual" });
    expect(cena.consent.marketing).toBeUndefined();
    expect(encerraDemanda).not.toHaveBeenCalled();
  });

  it("a mensagem comum não grava nada", async () => {
    await rodar({ texto: "Oi! Qual o horário de vocês?" });
    expect(cena.consent.marketing).toBeUndefined();
    expect(encerraDemanda).not.toHaveBeenCalled();
  });
});

describe("fora da conversa de prospecção", () => {
  it.each([
    ["conversa sem metadata", null],
    ["conversa de atendimento comum", { origem: "inbox" }],
  ])("%s: a mesma frase NÃO grava recusa nem fecha negócio", async (_rotulo, metadata) => {
    cena.metadataDaConversa = metadata;
    await rodar();
    expect(cena.consent.marketing).toBeUndefined();
    expect(updatesDeContato).toEqual([]);
    expect(encerraDemanda).not.toHaveBeenCalled();
    expect(audit.mock.calls.some((c) => (c[0] as { action?: string }).action === "lgpd.consent_changed")).toBe(
      false,
    );
  });
});

describe("o PARAR continua sendo outra regra", () => {
  it("'parar de receber' bloqueia pelo caminho de sempre, e o 'sem interesse' não roda por cima", async () => {
    await rodar({ texto: "não tenho interesse, quero parar de receber mensagens" });
    expect(updatesDeContato.some((u) => u.is_blocked === true)).toBe(true);
    expect(cena.consent.marketing).toBeUndefined();
  });
});

describe("a mensagem recuperada de uma queda (aplicarEfeitosDaRecuperacao)", () => {
  async function recuperar(over: Partial<EntradaDaRecuperacao> = {}) {
    const { aplicarEfeitosDaRecuperacao } = await import("@/lib/channels/pos-entrada");
    await aplicarEfeitosDaRecuperacao(admin, {
      ...ENTRADA,
      enviadaEm: "2026-11-14T10:00:00.000Z",
      previa: ENTRADA.texto ?? "",
      ...over,
    });
  }

  it("a mesma frase, reprocessada pela recuperação, grava a recusa", async () => {
    await recuperar();
    expect(cena.consent.marketing).toMatchObject({ granted: false, motivo: "sem_interesse" });
    expect(contactMayBeProspected({ ...CONTATO_DA_GUARDA, consent: cena.consent })).toBe(false);
  });

  it("PARAR já tratado (optOutJaTratado): nada é gravado pelo 'sem interesse'", async () => {
    await recuperar({ texto: "não tenho interesse, quero parar de receber mensagens", optOutJaTratado: true });
    expect(cena.consent.marketing).toBeUndefined();
    expect(updatesDeContato).toEqual([]);
  });
});
