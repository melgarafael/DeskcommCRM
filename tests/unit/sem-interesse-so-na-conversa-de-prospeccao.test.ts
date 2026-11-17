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
 * - Fazer `dentroDaJanelaDaProspeccao` devolver sempre `true` (a marca da conversa
 *   valendo para sempre, decisão 1B): os casos "fora da janela" ficam vermelhos.
 * - Tratar o adiamento como recusa em `pos-entrada.ts` (tirar o ramo `"adiamento"`):
 *   o bloco "adiamento" fica vermelho — o negócio vai para Perdido e a tarefa não nasce.
 * - Tirar o `encerrarFollowupsDaProspeccao` do ramo do adiamento: o caso do follow-up
 *   automático fica vermelho.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { EntradaDaRecuperacao, EntradaDeMensagem } from "@/lib/channels/pos-entrada";
import { contactMayBeProspected } from "@/lib/prospecting/guard";
import { recusouMarketing } from "@/lib/campanhas/elegibilidade";
import { ORIGEM_ADIAMENTO_DA_PROSPECCAO } from "@/lib/tarefas/vocabulario-de-origem";

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

const criarTarefaInterna = vi.fn(async (..._a: unknown[]) => ({ ok: true, tarefa_id: "tarefa-1", assigned_to: "vendedor-1" }));
vi.mock("@/lib/tarefas/criar-tarefa", () => ({
  criarTarefaInterna: (...a: unknown[]) => criarTarefaInterna(...a),
}));
/** A porta SQL só responde as três leituras da tarefa de retomada. */
const consultasDaPorta: Array<{ sql: string; parametros: readonly unknown[] }> = [];
vi.mock("@/lib/db", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  portaDaAplicacao: () => ({
    query: async () => [],
    queryOne: async (sql: string, parametros: readonly unknown[] = []) => {
      consultasDaPorta.push({ sql, parametros });
      if (sql.includes("user_organizations")) return cena.responsavel ? { user_id: cena.responsavel } : null;
      if (sql.includes("crm_tasks")) return cena.tarefaAberta ? { id: "tarefa-aberta" } : null;
      if (sql.includes("organizations")) return { locale: "pt-BR" };
      return null;
    },
  }),
}));
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
  /** `prospecting_candidates.attempted_at` das abordagens do contato. */
  abordagens: Array<{ attempted_at: string }>;
  erroNaAbordagem: boolean;
  responsavel: string | null;
  tarefaAberta: boolean;
  /** Inscrições vivas de follow-up do contato: uma da prospecção, uma de atendimento. */
  inscricoes: Array<{ id: string; status: string; current_node_id: null; conversation_id: string }>;
}

let cena: Cena;
let updatesDeContato: Array<Record<string, unknown>>;
let filtrosDeLeads: Array<[string, unknown]>;
/** As tabelas que receberam UPDATE (o follow-up encerrado aparece aqui). */
let tabelasAtualizadas: string[];
let filtrosDaAbordagem: Array<[string, unknown]>;
/** Os ids de `followup_enrollments` que receberam o UPDATE de encerramento. */
let inscricoesEncerradas: string[];
/** Os filtros `.eq` de CADA leitura de `conversations`. */
let leiturasDaConversa: Array<Array<[string, unknown]>>;

/** Builder encadeável do PostgREST: o efeito acontece no `await` ou no `maybeSingle`. */
function consulta(tabela: string) {
  let patch: Record<string, unknown> | null = null;
  let idFiltrado: unknown = null;
  let lista = false;
  const resposta = (): { data: unknown; error: null } => {
    if (patch) {
      tabelasAtualizadas.push(tabela);
      if (tabela === "followup_enrollments") {
        inscricoesEncerradas.push(String(idFiltrado));
        return { data: [{ id: idFiltrado }], error: null };
      }
      if (tabela === "contacts") {
        updatesDeContato.push(patch);
        if (patch.consent) cena.consent = patch.consent as Record<string, unknown>;
        // A gravação da recusa confere a linha alterada (`.select("id")`).
        return { data: [{ id: "contato-1" }], error: null };
      }
      return { data: null, error: null };
    }
    // A conferência das OUTRAS conversas das inscrições (`.in("id", …)`): a de atendimento
    // não tem a marca da prospecção.
    if (tabela === "conversations" && lista)
      return { data: [{ id: "conversa-atendimento", metadata: { origem: "inbox" } }], error: null };
    if (tabela === "conversations") return { data: { metadata: cena.metadataDaConversa }, error: null };
    if (tabela === "contacts")
      return { data: { id: "contato-1", consent: cena.consent, is_anonymized: false }, error: null };
    if (tabela === "crm_leads") return { data: cena.leadsDaProspeccao, error: null };
    if (tabela === "prospecting_candidates")
      return cena.erroNaAbordagem
        ? ({ data: null, error: { message: "falhou" } } as never)
        : { data: cena.abordagens, error: null };
    if (tabela === "followup_enrollments")
      return { data: cena.inscricoes, error: null };
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
      if (tabela === "conversations" && (m === "eq" || m === "in"))
        filtrosDaConversa.push([m === "in" ? `${String(args[0])}:in` : (args[0] as string), args[1]]);
      if (tabela === "prospecting_candidates" && m === "eq") filtrosDaAbordagem.push([args[0] as string, args[1]]);
      if (m === "eq" && args[0] === "id") idFiltrado = args[1];
      if (m === "in" && args[0] === "id") lista = true;
      return encadeia();
    };
  }
  q.update = (p: Record<string, unknown>) => {
    patch = p;
    return q;
  };
  // A linha da timeline do encerramento (`followup_enrollment_events`).
  q.insert = () => q;
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

const DIA = 24 * 60 * 60 * 1000;

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
    abordagens: [{ attempted_at: new Date(Date.now() - 2 * DIA).toISOString() }],
    erroNaAbordagem: false,
    responsavel: "vendedor-1",
    tarefaAberta: false,
    inscricoes: [
      { id: "inscricao-prospeccao", status: "active", current_node_id: null, conversation_id: "conversa-1" },
      { id: "inscricao-atendimento", status: "active", current_node_id: null, conversation_id: "conversa-atendimento" },
    ],
  };
  inscricoesEncerradas = [];
  updatesDeContato = [];
  tabelasAtualizadas = [];
  filtrosDaAbordagem = [];
  consultasDaPorta.length = 0;
  criarTarefaInterna.mockClear();
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
      expect(filtros).toContainEqual(["organization_id", "org-1"]);
      // A conferência das conversas das OUTRAS inscrições (`encerrar-pela-recusa.ts`) lê
      // em lista; a da frase lê a própria conversa.
      if (!filtros.some(([campo]) => campo === "id:in")) expect(filtros).toContainEqual(["id", "conversa-1"]);
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

// Frases de controle de NICHO (clínica, imobiliária): o paciente e o comprador escolhendo
// dizem "não tenho interesse" o tempo todo. Na conversa comum nada pode ser gravado, nem
// com a frase nua; e as que têm complemento de escolha não gravam nem na prospecção.
const FRASES_DE_NICHO = [
  "Não tenho interesse nesse horário, tem às 15h?",
  "não tenho interesse em fazer o clareamento agora, só a limpeza",
  "Não tenho interesse no plano odontológico",
  "não me interessa a consulta online, prefiro presencial",
  "Não tenho interesse nesse apartamento, tem outro de dois quartos?",
  "não tenho interesse em casa, só apartamento",
  "Não tenho interesse na região norte",
] as const;

describe("frases de controle de nicho (clínica, imobiliária)", () => {
  it.each([
    ["clínica", "Não tenho interesse."],
    ["imobiliária", "não tenho interesse, obrigado"],
    ...FRASES_DE_NICHO.map((f) => ["nicho", f] as [string, string]),
  ])("%s, conversa de atendimento: %s — nada é gravado", async (_nicho, texto) => {
    cena.metadataDaConversa = { origem: "inbox" };
    await rodar({ texto });
    expect(updatesDeContato).toEqual([]);
    expect(encerraDemanda).not.toHaveBeenCalled();
  });

  it.each(FRASES_DE_NICHO.map((f) => [f]))(
    "nem na conversa de prospecção a escolha vira recusa: %s",
    async (texto) => {
      await rodar({ texto });
      expect(cena.consent.marketing).toBeUndefined();
      expect(updatesDeContato).toEqual([]);
      expect(encerraDemanda).not.toHaveBeenCalled();
    },
  );
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

// ─── 1A · A JANELA (decisão do dono, 15/11, doc 360) ──────────────────────────
// A marca da prospecção nunca sai da conversa. A frase só conta com negócio da
// prospecção aberto ou até 30 dias depois da última abordagem.
describe("1A · a frase só conta dentro da janela da prospecção", () => {
  function nadaAconteceu() {
    expect(cena.consent.marketing, "gravou recusa fora da janela").toBeUndefined();
    expect(updatesDeContato).toEqual([]);
    expect(encerraDemanda).not.toHaveBeenCalled();
    expect(tabelasAtualizadas, "encerrou acompanhamento fora da janela").not.toContain("followup_enrollments");
    expect(criarTarefaInterna).not.toHaveBeenCalled();
  }

  it("sem negócio aberto, abordagem há 10 dias: ainda é resposta à prospecção e grava", async () => {
    cena.leadsDaProspeccao = [];
    cena.abordagens = [{ attempted_at: new Date(Date.now() - 10 * DIA).toISOString() }];
    await rodar();
    expect(cena.consent.marketing).toMatchObject({ granted: false, motivo: "sem_interesse" });
  });

  it("com negócio da prospecção aberto, abordagem antiga não importa: grava", async () => {
    cena.abordagens = [{ attempted_at: new Date(Date.now() - 200 * DIA).toISOString() }];
    await rodar();
    expect(cena.consent.marketing).toMatchObject({ granted: false, motivo: "sem_interesse" });
    expect(tabelasAtualizadas).toContain("followup_enrollments");
  });

  it.each([
    ["cliente antigo, abordado há 6 meses, sem negócio aberto", "Não tenho interesse, obrigado.", 180],
    ["31 dias depois da última abordagem", "Não tenho interesse.", 31],
    ["clínica: paciente antigo", "não tenho interesse, já tenho dentista", 120],
    ["imobiliária: cliente que já comprou", "Não temos interesse, já fechamos com outra imobiliária", 90],
    ["adiamento fora da janela também não cria tarefa", "Não tenho interesse agora, me chama mês que vem", 60],
  ])("%s: conversa normal — nada gravado, nada encerrado", async (_rotulo, texto, dias) => {
    cena.leadsDaProspeccao = [];
    cena.abordagens = [{ attempted_at: new Date(Date.now() - dias * DIA).toISOString() }];
    await rodar({ texto });
    nadaAconteceu();
  });

  it("sem negócio aberto e sem abordagem registrada: nada é gravado", async () => {
    cena.leadsDaProspeccao = [];
    cena.abordagens = [];
    await rodar();
    nadaAconteceu();
  });

  it("a leitura da abordagem falhou: nada é gravado (erra para o lado de não gravar)", async () => {
    cena.leadsDaProspeccao = [];
    cena.erroNaAbordagem = true;
    await rodar();
    nadaAconteceu();
  });

  it("a leitura da abordagem leva a cerca da organização e o contato", async () => {
    await rodar();
    expect(filtrosDaAbordagem).toEqual(
      expect.arrayContaining([
        ["organization_id", "org-1"],
        ["contact_id", "contato-1"],
      ]),
    );
  });
});

// ─── 2A · ADIAMENTO NÃO É RECUSA ────────────────────────────────────────────
describe("2A · adiamento vira tarefa, não Perdido", () => {
  it.each([
    ["Não tenho interesse agora, me chama mês que vem", 30],
    ["não estou interessado agora, talvez mais pra frente", 30],
    ["Agora não, me chama mês que vem", 30],
    ["Por enquanto não tenho interesse, talvez depois das férias", 30],
    ["No momento não estamos interessados, me procura no ano que vem", 30],
    ["Não tenho interesse no momento, me chama semana que vem", 7],
  ])("%s: não grava recusa, não fecha o negócio, cria a tarefa do vendedor", async (texto, prazo) => {
    await rodar({ texto });
    expect(cena.consent.marketing, "adiamento gravou recusa").toBeUndefined();
    expect(contactMayBeProspected({ ...CONTATO_DA_GUARDA, consent: cena.consent })).toBe(true);
    expect(recusouMarketing(cena.consent)).toBe(false);
    expect(encerraDemanda, "adiamento mandou o negócio para Perdido").not.toHaveBeenCalled();
    expect(criarTarefaInterna).toHaveBeenCalledTimes(1);
    expect(criarTarefaInterna.mock.calls[0]?.[1]).toMatchObject({
      organizationId: "org-1",
      contactId: "contato-1",
      leadId: "lead-prospeccao",
      atribuirA: { usuario_id: "vendedor-1" },
      origem: ORIGEM_ADIAMENTO_DA_PROSPECCAO,
      venceEmDias: prazo,
    });
  });

  it("o responsável sai da organização certa, com o dono do negócio como primeiro candidato", async () => {
    cena.leadsDaProspeccao = [{ id: "lead-prospeccao", pipeline_id: "funil-prospeccao", owner_user_id: "dono-do-lead" } as never];
    await rodar({ texto: "Não tenho interesse agora, me chama mês que vem" });
    const responsavel = consultasDaPorta.find((c) => c.sql.includes("user_organizations"));
    expect(responsavel?.parametros.slice(0, 3)).toEqual(["org-1", "contato-1", "dono-do-lead"]);
  });

  it("encerra o follow-up AUTOMÁTICO da prospecção e mantém o negócio aberto; o de atendimento fica", async () => {
    await rodar({ texto: "Não tenho interesse agora, me chama mês que vem" });
    expect(inscricoesEncerradas, "o toque automático continuaria saindo").toContain("inscricao-prospeccao");
    expect(inscricoesEncerradas, "encerrou acompanhamento de atendimento").not.toContain("inscricao-atendimento");
    expect(encerraDemanda, "adiamento mandou o negócio para Perdido").not.toHaveBeenCalled();
    expect(recusouMarketing(cena.consent)).toBe(false);
  });

  it("com tarefa aberta para o mesmo vendedor, não cria outra", async () => {
    cena.tarefaAberta = true;
    await rodar({ texto: "Não tenho interesse agora, me chama mês que vem" });
    expect(criarTarefaInterna).not.toHaveBeenCalled();
    expect(encerraDemanda).not.toHaveBeenCalled();
  });

  it("'não tenho interesse, agora me tira da lista' é o PARAR, não adiamento", async () => {
    await rodar({ texto: "não tenho interesse, agora me tira da lista" });
    expect(updatesDeContato.some((u) => u.is_blocked === true)).toBe(true);
    expect(criarTarefaInterna).not.toHaveBeenCalled();
  });

  it("'nem agora nem nunca' é recusa: grava e fecha", async () => {
    await rodar({ texto: "não tenho interesse, nem agora nem nunca" });
    expect(cena.consent.marketing).toMatchObject({ granted: false, motivo: "sem_interesse" });
    expect(encerraDemanda).toHaveBeenCalledTimes(1);
    expect(criarTarefaInterna).not.toHaveBeenCalled();
  });

  it("fora da conversa de prospecção, o adiamento também não faz nada", async () => {
    cena.metadataDaConversa = { origem: "inbox" };
    await rodar({ texto: "Não tenho interesse agora, me chama mês que vem" });
    expect(criarTarefaInterna).not.toHaveBeenCalled();
    expect(updatesDeContato).toEqual([]);
  });
});
