import { beforeEach, describe, expect, it, vi } from "vitest";

import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import {
  razaoDaMudancaPeloAgente,
  resolveDestinoDoAgente,
  sincronizaEstagioDoAgente,
  type EstagioCandidato,
} from "@/lib/leads/agent-stage-sync";
import {
  avisoDoEspelhoRecusado,
  MIRROR_WARN_ONLY,
  mirrorLeadStageToCrm,
} from "@/lib/agent-engine/edge/crm/move-lead-stage";

vi.mock("@/lib/leads/activity-emitter", async (orig) => ({
  ...(await orig<typeof import("@/lib/leads/activity-emitter")>()),
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
}));

/**
 * O cenário 26 vive aqui: o MESMO passo do agente cai em estágios de nomes
 * completamente diferentes conforme o nicho, e o resolvedor não pode saber nada
 * sobre "Avaliação" ou "Aguardando pagamento" — só sobre o hint.
 */
const clinica: EstagioCandidato[] = [
  { id: "c1", name: "Primeiro contato", agent_stage_hint: "contacted", is_archived: false },
  { id: "c2", name: "Avaliação", agent_stage_hint: "qualifying", is_archived: false },
  { id: "c3", name: "Proposta enviada", agent_stage_hint: "negotiating", is_archived: false },
  { id: "c4", name: "Tratamento fechado", agent_stage_hint: "won", is_archived: false },
];
const ecommerce: EstagioCandidato[] = [
  { id: "e1", name: "Carrinho abandonado", agent_stage_hint: null, is_archived: false },
  { id: "e2", name: "Aguardando pagamento", agent_stage_hint: "negotiating", is_archived: false },
  { id: "e3", name: "Pago", agent_stage_hint: "won", is_archived: false },
  { id: "e4", name: "Em separação", agent_stage_hint: null, is_archived: false },
];

describe("resolveDestinoDoAgente", () => {
  it("cenário 26: o mesmo passo cai em nomes diferentes por nicho", () => {
    const naClinica = resolveDestinoDoAgente(clinica, "negotiating", "c1");
    const noEcommerce = resolveDestinoDoAgente(ecommerce, "negotiating", "e1");
    expect(naClinica).toEqual({ move: true, stageId: "c3", stageName: "Proposta enviada" });
    expect(noEcommerce).toEqual({ move: true, stageId: "e2", stageName: "Aguardando pagamento" });
  });

  it("sem mapeamento: NÃO move, e não inventa o mais próximo", () => {
    // O e-commerce não declarou nada para "qualifying". Mover para "Carrinho
    // abandonado" ou "Em separação" por proximidade poria o negócio num lugar
    // que ninguém escolheu — e o usuário veria um card se mexendo sozinho.
    expect(resolveDestinoDoAgente(ecommerce, "qualifying", "e1")).toEqual({
      move: false,
      motivo: "sem_mapeamento",
      passo: "qualifying",
    });
  });

  it("já está lá: não é falha, é ausência de trabalho", () => {
    // Distinguir de `sem_mapeamento` importa: um vira rastro de configuração
    // faltando, o outro é o caso normal de o agente reafirmar onde já está.
    expect(resolveDestinoDoAgente(clinica, "qualifying", "c2")).toEqual({
      move: false,
      motivo: "ja_esta_la",
      passo: "qualifying",
    });
  });

  it("estágio ARQUIVADO não é destino", () => {
    // Mandar um negócio vivo para um estágio arquivado o esconderia do board —
    // desaparecer é pior que não se mover.
    const comArquivado: EstagioCandidato[] = [
      { id: "x1", name: "Ativo", agent_stage_hint: null, is_archived: false },
      { id: "x2", name: "Antigo", agent_stage_hint: "qualifying", is_archived: true },
    ];
    expect(resolveDestinoDoAgente(comArquivado, "qualifying", "x1")).toEqual({
      move: false,
      motivo: "sem_mapeamento",
      passo: "qualifying",
    });
  });

  it("pipeline SEM hint nenhum nunca move — e isso é o estado de todo clone novo", () => {
    const semHints: EstagioCandidato[] = ecommerce.map((e) => ({ ...e, agent_stage_hint: null }));
    for (const passo of ["new", "contacted", "qualifying", "qualified", "negotiating", "won", "lost"]) {
      expect(resolveDestinoDoAgente(semHints, passo, "e1").move).toBe(false);
    }
  });

  it("a razão nomeia OS DOIS lados da tradução", () => {
    // Quem lê a timeline conhece só o nome do tenant; quem depura conhece só o
    // passo do agente. Um sem o outro deixa metade das pessoas sem contexto.
    const r = razaoDaMudancaPeloAgente("Avaliação", "qualifying");
    expect(r).toContain("Avaliação");
    expect(r).toContain("qualifying");
    expect(r).toContain("assistente");
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * `sincronizaEstagioDoAgente` contra um supabase-js falso — os dois defeitos que
 * só viraram comportamento de produção quando a ponte da Fase 4 acordou este
 * código (até então ele não tinha chamador nenhum):
 *
 *  1. o supabase-js NÃO LANÇA em falha de rede (devolve `{data:null, error}`), e
 *     o erro dos SELECTs era descartado — banco fora virava "sem_negocio";
 *  2. o UPDATE sem `.select()` não observa "0 linhas afetadas", então a trava
 *     otimista barrar (humano arrastou o card) era reportado como movimento
 *     feito, com atividade `stage_changed` de algo que não aconteceu.
 */
type Resposta = { data: unknown; error: { message: string } | null };
interface Cenario {
  leads: Resposta;
  stages: Resposta;
  update: Resposta;
  /** Erro devolvido pelo `emit_event` — o rastro pode falhar sem desfazer o movimento. */
  rpcError?: { message: string } | null;
  /** O `crm_pipelines.settings` que a régua de campos obrigatórios lê (#1536). */
  funil?: Resposta;
}

const ORG = "org-1";
const CONTATO = "contato-1";
const LEAD = { id: "lead-1", organization_id: ORG, pipeline_id: "pipe-1", stage_id: "s1", status: "open", created_at: "2026-01-01T00:00:00Z", last_activity_at: null };
const STAGES = [
  { id: "s1", name: "Primeiro contato", agent_stage_hint: "contacted", is_archived: false },
  { id: "s2", name: "Proposta enviada", agent_stage_hint: "negotiating", is_archived: false },
];

function cenario(over: Partial<Cenario> = {}): Cenario {
  return {
    leads: { data: [LEAD], error: null },
    stages: { data: STAGES, error: null },
    update: { data: [{ id: LEAD.id }], error: null },
    ...over,
  };
}

/**
 * Fake do query builder: thenable, e distingue SELECT de UPDATE pela chamada.
 *
 * ⚠️ UPDATE **sem** `.select()` devolve `data: null`, como o supabase-js real —
 * é o que faz este fake exigir o `.select("id")` do código de produção. Sem essa
 * regra, remover só o `.select("id")` (mantendo o check de comprimento) passaria
 * verde aqui e, no banco de verdade, faria TODO movimento virar `conflito_humano`:
 * o card nunca mais andaria e o painel mostraria conflito onde não há.
 */
/** As chamadas de `emit_event` que o código fez — o fake registra em vez de
 *  engolir, porque é o `event_log` que ACIONA automação e follow-up, e um fake
 *  que apenas aceitasse a chamada não distinguiria "emitiu certo" de "emitiu". */
interface ChamadaRpc {
  fn: string;
  args: Record<string, unknown>;
}

function fakeAdmin(c: Cenario, rpcs: ChamadaRpc[] = []) {
  return {
    rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push({ fn, args });
      return Promise.resolve({ data: null, error: c.rpcError ?? null });
    },
    from(tabela: string) {
      const b = {
        _update: false,
        _select: false,
        select: () => {
          b._select = true;
          return b;
        },
        update: () => {
          b._update = true;
          return b;
        },
        eq: () => b,
        maybeSingle: () =>
          Promise.resolve(
            tabela === "crm_pipelines"
              ? (c.funil ?? { data: { name: "Funil" }, error: null })
              : { data: { name: "Primeiro contato" }, error: null },
          ),
        then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
          const r = b._update
            ? b._select
              ? c.update
              : { ...c.update, data: null } // UPDATE sem .select() não devolve linha nenhuma
            : tabela === "crm_leads"
              ? c.leads
              : c.stages;
          return Promise.resolve(r).then(onF, onR);
        },
      };
      return b;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const sincroniza = (c: Cenario) =>
  sincronizaEstagioDoAgente(fakeAdmin(c), { organizationId: ORG, contactId: CONTATO, passo: "negotiating" });

/** Como `sincroniza`, mas devolve também o que foi para o `event_log`. */
async function sincronizaObservando(c: Cenario) {
  const rpcs: ChamadaRpc[] = [];
  const r = await sincronizaEstagioDoAgente(fakeAdmin(c, rpcs), {
    organizationId: ORG,
    contactId: CONTATO,
    passo: "negotiating",
  });
  return { r, eventos: rpcs.filter((x) => x.fn === "emit_event") };
}

describe("sincronizaEstagioDoAgente", () => {
  beforeEach(() => vi.mocked(emitLeadActivity).mockClear());

  it("caminho feliz: move e emite UMA atividade", async () => {
    const r = await sincroniza(cenario());
    expect(r).toMatchObject({ moveu: true, motivo: "movido", stageName: "Proposta enviada" });
    expect(vi.mocked(emitLeadActivity)).toHaveBeenCalledTimes(1);
  });

  it("SELECT de leads com erro é INDISPONIBILIDADE, não 'sem_negocio'", async () => {
    const r = await sincroniza(cenario({ leads: { data: null, error: { message: "TypeError: fetch failed" } } }));
    expect(r.motivo).toBe("indisponivel");
    expect(r.detalhe).toContain("fetch failed");
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("SELECT de stages com erro é INDISPONIBILIDADE, não 'sem_mapeamento'", async () => {
    const r = await sincroniza(cenario({ stages: { data: null, error: { message: "connection refused" } } }));
    expect(r.motivo).toBe("indisponivel");
  });

  it("UPDATE com erro é falha de escrita — jamais 'ja_esta_la' (que a ponte lê como sucesso)", async () => {
    const r = await sincroniza(cenario({ update: { data: null, error: { message: "deadlock detected" } } }));
    expect(r).toMatchObject({ moveu: false, motivo: "falha_de_escrita" });
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("trava otimista atuou (0 linhas): não moveu, e NÃO fabrica atividade na timeline", async () => {
    const r = await sincroniza(cenario({ update: { data: [], error: null } }));
    expect(r).toMatchObject({ moveu: false, motivo: "conflito_humano" });
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });
});

/**
 * MOVER PELO ASSISTENTE TEM DE SER INDISTINGUÍVEL DE MOVER PELA MÃO.
 *
 * A atividade em `crm_lead_activities` é para humano ler; o `event_log` é o que
 * ACIONA quem reage — `lib/automation/engine.handler.ts` (regras do tenant) e
 * `lib/followup/gatilho-etapa.ts` consomem `lead.stage_changed`. Antes deste
 * bloco, o assistente movia o card, a timeline contava a história e NENHUMA
 * regra rodava: metade dos movimentos da organização passava sem acionar nada,
 * sem erro e sem log. Regra que ignora metade dos movimentos em silêncio é pior
 * que regra que dispara demais, porque a primeira é invisível.
 *
 * ⚠️ `entity_kind` é asserido de propósito. O motor de automação FILTRA por
 * `crm_lead` (o trigger legado `fn_emit_event_on_lead_change` emite `lead`, e o
 * filtro é o que impede a regra de rodar duas vezes). Emitir com o valor errado
 * seria emitir para ninguém — e o evento existiria no banco, o que faz esse
 * defeito parecer resolvido em qualquer prova que só conte linhas.
 */
describe("sincronizaEstagioDoAgente — o evento que aciona automação e follow-up", () => {
  beforeEach(() => vi.mocked(emitLeadActivity).mockClear());

  it("movimento do assistente emite lead.stage_changed, com entity_kind que o motor de automação lê", async () => {
    const { r, eventos } = await sincronizaObservando(cenario());
    expect(r.moveu).toBe(true);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.args).toMatchObject({
      p_event_type: "lead.stage_changed",
      p_entity_kind: "crm_lead",
      p_entity_id: LEAD.id,
      p_organization_id: ORG,
      p_payload: {
        pipeline_id: LEAD.pipeline_id,
        from_stage_id: "s1",
        to_stage_id: "s2",
        status: "open",
      },
    });
  });

  it("o evento diz QUEM moveu — sem ator, quem depurar a regra disparada não tem por onde começar", async () => {
    const { eventos } = await sincronizaObservando(cenario());
    expect(eventos[0]!.args.p_metadata).toMatchObject({
      actor_kind: "ai",
      source: "agent-stage-sync",
      passo_do_agente: "negotiating",
    });
  });

  it("a trava otimista barrou (humano venceu a corrida): NÃO emite evento de um movimento que não houve", async () => {
    const { r, eventos } = await sincronizaObservando(cenario({ update: { data: [], error: null } }));
    expect(r.motivo).toBe("conflito_humano");
    expect(eventos).toHaveLength(0);
  });

  it("escrita falhou: NÃO emite evento", async () => {
    const { r, eventos } = await sincronizaObservando(
      cenario({ update: { data: null, error: { message: "deadlock detected" } } }),
    );
    expect(r.motivo).toBe("falha_de_escrita");
    expect(eventos).toHaveLength(0);
  });

  it("o rastro pode falhar sem desfazer o movimento — o card andou, e isso não se retira", async () => {
    const { r } = await sincronizaObservando(cenario({ rpcError: { message: "event_log indisponível" } }));
    expect(r).toMatchObject({ moveu: true, motivo: "movido" });
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * A RÉGUA DE CAMPOS OBRIGATÓRIOS NO CAMINHO DO ASSISTENTE (CR do mantenedor, #1536).
 *
 * `agent-stage-sync.ts` grava `stage_id` direto — sem a pergunta aqui, o
 * assistente seria o ÚNICO caminho do produto que move sem passar por
 * `validaCamposExigidos`. O padrão testado é o MESMO da perda (#917) no
 * próprio arquivo: não move, devolve o motivo e deixa o rastro (o espelho abre
 * item de inbox com o que falta).
 *
 * `obrigatorio_em.etapas` é `z.string().uuid()` e `camposDoFunil` DESCARTA o
 * campo quando o id não é UUID — por isso a etapa de destino deste cenário é
 * um UUID, como na instalação real (os `s1`/`s2` dos dublês de cima não
 * passariam do parse e a recusa nunca acenderia).
 */
describe("o assistente move pela MESMA régua dos outros caminhos (#1536)", () => {
  beforeEach(() => vi.mocked(emitLeadActivity).mockClear());

  const ETAPA_UUID = "99999999-9999-4999-8999-999999999999";
  const stagesComUuid = STAGES.map((s) => (s.id === "s2" ? { ...s, id: ETAPA_UUID } : s));
  const cenarioExigente = () =>
    cenario({
      stages: { data: stagesComUuid, error: null },
      funil: {
        data: {
          settings: {
            fields: [
              {
                key: "concorrente",
                label: "Concorrente",
                type: "text",
                obrigatorio_em: { etapas: [ETAPA_UUID] },
              },
            ],
          },
        },
        error: null,
      },
    });

  it("não move: devolve `campos_obrigatorios` com o que falta, e NADA é escrito", async () => {
    const { r, eventos } = await sincronizaObservando(cenarioExigente());

    expect(r).toMatchObject({ moveu: false, motivo: "campos_obrigatorios" });
    expect(r.detalhe).toContain("Concorrente");
    // Nem atividade na timeline nem evento: o card ficou onde estava.
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
    expect(eventos).toHaveLength(0);
  });

  it("funil SEM a exigência continua movendo — a recusa não virou bloqueio geral", async () => {
    const { r } = await sincronizaObservando(
      cenario({ stages: { data: stagesComUuid, error: null } }),
    );
    expect(r).toMatchObject({ moveu: true, motivo: "movido" });
    expect(vi.mocked(emitLeadActivity)).toHaveBeenCalledTimes(1);
  });

  it("o espelho vira aviso ACIONÁVEL: não é warn-only nem incidente", () => {
    expect(MIRROR_WARN_ONLY.has("campos_obrigatorios" as never)).toBe(false);

    const aviso = avisoDoEspelhoRecusado({
      motivo: "campos_obrigatorios",
      detalhe: "Preencha os campos obrigatórios antes de continuar: Concorrente.",
      etapaDeDestino: "Proposta enviada",
    });

    expect(aviso).not.toBeNull();
    expect(aviso!.body).toContain("Concorrente");
    expect(aviso!.body).toContain("Proposta enviada");
    // Nada quebrou: não é o aviso de incidente.
    expect(aviso!.body).not.toContain("Reconcilie");
    expect(aviso!.dedupe).toBe("kind_ref_e_titulo");
  });

  it("a passagem pelo espelho traduz o motivo — não cai no `motivo não traduzido`", async () => {
    const sync = vi.fn(async () => ({
      moveu: false as const,
      motivo: "campos_obrigatorios" as const,
      detalhe: "Preencha os campos obrigatórios antes de continuar: Concorrente.",
    }));
    const r = await mirrorLeadStageToCrm(
      {} as never,
      { supabase: {} as never } as never,
      { tenantId: "org", leadId: "contato", toStage: "negotiating" as never },
      { sync: sync as never },
    );
    expect(r.ok ? null : r.reason).toBe("campos_obrigatorios");
    expect(r.ok ? null : r.detail).toContain("Concorrente");
  });
});
