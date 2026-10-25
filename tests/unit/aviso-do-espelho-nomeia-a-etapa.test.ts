/**
 * O AVISO DO ESPELHO NOMEIA A ETAPA DO FUNIL — NUNCA O PASSO INTERNO DO AGENTE.
 *
 * ═══ O DEFEITO (issue #3148) ═══
 *
 * Quando o espelho do funil recusava o movimento, a Central abria
 * `O assistente concluiu que este negócio deveria ir para "lost"` — e `lost` é o
 * PASSO INTERNO do agente (`update.transition.to`, em `inbound-turn.ts`), não o
 * nome que o dono cadastrou no quadro dele ("Perdido"). Quem lê o aviso nunca viu
 * `lost`: o vocabulário da máquina de estados do atendimento não existe para ele.
 *
 * ═══ O QUE ESTE ARQUIVO PRENDE ═══
 *
 * 1. os TRÊS avisos de estado legítimo (`fora_do_escopo`, `perda_sem_motivo`,
 *    `campos_obrigatorios`) nomeiam a etapa pela leitura do FUNIL do dono;
 * 2. o nome VEM do funil — o mesmo passo do agente cai em nomes diferentes por
 *    tenant, e o texto é o que estiver cadastrado (sem tradução nossa);
 * 3. sem nome resolvido o aviso cai num texto legível, nunca no rótulo interno
 *    (é o caso da recusa de ESCOPO, que decide antes de ler as etapas);
 * 4. o ramo de INCIDENTE continua com o passo interno — é diagnóstico de quem
 *    depura o funil quebrado, e a decisão está escrita no código.
 *
 * ⚠️ O caminho medido aqui é o REAL, de ponta a ponta: o supabase é falso, mas
 * `sincronizaEstagioDoAgente` e `resolveDestinoDoAgente` são as implementações de
 * produção (nenhum `deps.sync` injetado) e a asserção final lê o TEXTO que chega
 * ao banco da Central (`abreAvisoDoEspelhoRecusado`). Um dublê do alvo provaria
 * só que o dublê sabe o nome.
 */
import { describe, expect, it } from "vitest";

import {
  abreAvisoDoEspelhoRecusado,
  avisoDoEspelhoRecusado,
  mirrorLeadStageToCrm,
} from "@/lib/agent-engine/edge/crm/move-lead-stage";

const ORG = "org-1";
const CONTATO = "contato-1";
const PIPELINE = "pipe-1";

type Resposta = { data: unknown; error: { message: string } | null };

interface Cenario {
  leads?: Resposta;
  stages?: Resposta;
  funil?: Resposta;
}

function funilDoTeste(stages: unknown[]): Resposta {
  return { data: stages, error: null };
}

/**
 * Fake do supabase-js: distingue as tabelas pela `from` e devolve a resposta do
 * cenário. `maybeSingle` serve os dois pontos que o código lê por linha única
 * (`crm_pipelines.settings` e o nome da etapa de ORIGEM).
 */
function fakeAdmin(c: Cenario = {}) {
  const leads = c.leads ?? {
    data: [
      {
        id: "lead-1",
        organization_id: ORG,
        pipeline_id: PIPELINE,
        stage_id: "s1",
        status: "open",
        created_at: "2026-01-01T00:00:00Z",
        last_activity_at: null,
        custom_fields: null,
        won_reason: null,
      },
    ],
    error: null,
  };
  const stages = c.stages ?? funilDoTeste([]);
  const funil = c.funil ?? { data: { settings: { fields: [] } }, error: null };
  return {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from(tabela: string) {
      const b = {
        select: () => b,
        update: () => b,
        eq: () => b,
        maybeSingle: () =>
          Promise.resolve(tabela === "crm_pipelines" ? funil : { data: { name: "s1" }, error: null }),
        then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
          Promise.resolve(tabela === "crm_leads" ? leads : stages).then(onF, onR),
      };
      return b;
    },
  } as never;
}

const cfg = (c: Cenario = {}) => ({ supabase: fakeAdmin(c) }) as never;

/** O funil de uma clínica: uma etapa comum e a etapa de PERDA, com o nome do tenant. */
const funilComPerda = (nomeDaPerda: string) =>
  funilDoTeste([
    { id: "s1", name: "Avaliação", agent_stage_hint: "qualifying", is_archived: false, is_lost: false },
    { id: "s9", name: nomeDaPerda, agent_stage_hint: "lost", is_archived: false, is_lost: true },
  ]);

/**
 * Percorre o caminho de produção: espelho recusado → aviso → texto gravado na
 * Central. Devolve o que o dono LÊ (título + corpo), que é onde o defeito se vê.
 */
async function avisoQueChegaNaCentral(
  c: Cenario,
  toStage: string,
  pipelineIds?: readonly string[],
): Promise<{ motivo: string; nomeDaEtapa: string | undefined; titulo: string; corpo: string }> {
  const mirror = await mirrorLeadStageToCrm({} as never, cfg(c), {
    tenantId: ORG,
    leadId: CONTATO,
    toStage: toStage as never,
    ...(pipelineIds !== undefined ? { pipelineIds } : {}),
  });
  if (mirror.ok) throw new Error("esperava recusa do espelho");

  const chamadas: Array<{ params: unknown[] }> = [];
  const db = {
    query: async (_sql: string, params: unknown[]) => {
      chamadas.push({ params });
      return { rows: [] };
    },
  };
  await abreAvisoDoEspelhoRecusado(db as never, ORG, {
    ...(mirror.negocioId !== undefined ? { negocioId: mirror.negocioId } : {}),
    motivo: mirror.reason,
    detalhe: mirror.detail,
    etapaDeDestino: toStage,
    ...(mirror.stageName !== undefined ? { etapaDoFunil: mirror.stageName } : {}),
  });

  if (chamadas.length !== 1) throw new Error(`esperava 1 item na Central, veio ${chamadas.length}`);
  // Ordem dos parâmetros de `insertInboxItem`: org, kind, severity, title, body, ref_kind, ref_id…
  const params = chamadas[0]!.params;
  return {
    motivo: mirror.reason,
    nomeDaEtapa: mirror.stageName,
    titulo: params[3] as string,
    corpo: params[4] as string,
  };
}

describe("o aviso do espelho nomeia a etapa do FUNIL, não o passo interno (#3148)", () => {
  it("(a) a perda sem motivo mostra o nome do funil e NUNCA o rótulo interno", async () => {
    const a = await avisoQueChegaNaCentral({ stages: funilComPerda("Perdido") }, "lost");

    expect(a.motivo).toBe("perda_sem_motivo");
    // O nome atravessou o caminho REAL: etapas → resolvedor → sync → espelho.
    expect(a.nomeDaEtapa).toBe("Perdido");
    expect(a.corpo).toContain("Perdido");
    // O defeito da issue: o passo interno do agente no texto para humano.
    expect(a.corpo).not.toContain("lost");
    expect(a.titulo).not.toContain("lost");
  });

  it("(b) o nome é o do FUNIL do tenant — em espanhol, e sem tradução nossa", async () => {
    // O MESMO passo interno (`lost`) num funil em espanhol: se o texto viesse de
    // uma tradução nossa, ele não seria este. O que decide é o nome cadastrado.
    const a = await avisoQueChegaNaCentral({ stages: funilComPerda("Perdido por precio") }, "lost");

    expect(a.motivo).toBe("perda_sem_motivo");
    expect(a.nomeDaEtapa).toBe("Perdido por precio");
    expect(a.corpo).toContain("Perdido por precio");
    expect(a.corpo).not.toContain("lost");
  });

  it("(c) sem nome resolvido o aviso cai em texto legível — e não vaza o rótulo interno", async () => {
    // A recusa de ESCOPO decide ANTES de ler as etapas (não há consulta nova ao CRM
    // só para nomear): o nome genuinamente não existe neste ponto.
    const a = await avisoQueChegaNaCentral({ stages: funilComPerda("Perdido") }, "lost", ["outro-funil"]);

    expect(a.motivo).toBe("fora_do_escopo");
    expect(a.nomeDaEtapa).toBeUndefined();
    expect(a.corpo).toContain("a etapa de destino do funil");
    expect(a.corpo).not.toContain("lost");
    expect(a.corpo).not.toBe("");
  });

  it("a outra recusa de estado legítimo (`campos_obrigatorios`) também nomeia a etapa do funil", async () => {
    // ⚠️ `obrigatorio_em.etapas` é `z.string().uuid()` e o parse DESCARTA o campo
    // quando o id não é UUID — com `s1`/`s2` a exigência nunca acenderia e o
    // cenário mediria um movimento que passou. Os ids são UUID, como na instalação.
    const AVALIACAO = "11111111-1111-4111-8111-111111111111";
    const PROPOSTA = "22222222-2222-4222-8222-222222222222";
    const c: Cenario = {
      stages: funilDoTeste([
        { id: AVALIACAO, name: "Avaliação", agent_stage_hint: "qualifying", is_archived: false, is_lost: false },
        { id: PROPOSTA, name: "Proposta enviada", agent_stage_hint: "negotiating", is_archived: false, is_lost: false },
      ]),
      funil: {
        data: {
          settings: {
            fields: [
              { key: "concorrente", label: "Concorrente", type: "text", obrigatorio_em: { etapas: [PROPOSTA] } },
            ],
          },
        },
        error: null,
      },
    };
    const a = await avisoQueChegaNaCentral(c, "negotiating");

    expect(a.motivo).toBe("campos_obrigatorios");
    expect(a.nomeDaEtapa).toBe("Proposta enviada");
    expect(a.corpo).toContain("Proposta enviada");
    expect(a.corpo).not.toContain("negotiating");
  });

  it("o ramo de INCIDENTE mantém o passo interno — é diagnóstico, não texto para humano", () => {
    // A decisão escrita no código: `fora_do_escopo`, `perda_sem_motivo` e
    // `campos_obrigatorios` são estado legítimo e falam a língua do dono; o funil
    // QUEBRADO é incidente, e ali o passo que o agente tentou é o que se depura.
    const incidente = avisoDoEspelhoRecusado({
      motivo: "crm_unavailable",
      detalhe: "o banco do CRM não respondeu",
      etapaDeDestino: "lost",
    });

    expect(incidente).not.toBeNull();
    expect(incidente!.body).toContain("lost");
    expect(incidente!.body).toContain("Reconcilie");
  });

  it("nome em branco não vira aspas vazias no meio do aviso", () => {
    // Guarda de borda: um `stageName` que chegou como "" (trim) cai no texto de
    // reserva, e não em `deveria ir para ""`.
    const aviso = avisoDoEspelhoRecusado({
      motivo: "perda_sem_motivo",
      detalhe: "d",
      etapaDeDestino: "lost",
      etapaDoFunil: "   ",
    });

    expect(aviso!.body).toContain("a etapa de destino do funil");
    expect(aviso!.body).not.toContain('""');
    expect(aviso!.body).not.toContain("lost");
  });
});
