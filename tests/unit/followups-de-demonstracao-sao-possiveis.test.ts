/**
 * AS INSCRIÇÕES DE DEMONSTRAÇÃO SÃO POSSÍVEIS: CADA PASSO É UM QUE O MOTOR GRAVARIA.
 *
 * `scripts/seed-automacoes-e-followups.ts` grava inscrições em
 * `followup_enrollments` e a trilha delas em `followup_enrollment_events`, cujo
 * `event_type` é texto livre. A primeira versão gravou `enrolled` e
 * `node_entered` (este, nenhum código do repositório emite), com datas
 * anteriores ao início da inscrição e uma inscrição "aguardando resposta" parada
 * no nó da mensagem sem envio nenhum antes. O banco aceitou tudo, e o dossiê
 * mostrou "código: node_entered" como se fosse história.
 *
 * Três réguas, da mais barata à mais forte:
 *   1. todo código da trilha aparece como literal num módulo que ESCREVE em
 *      `followup_enrollment_events` — os módulos são achados no código, não
 *      numa lista daqui; e a tela sabe dizê-lo (não cai no `default`);
 *   2. as datas andam para a frente a partir do início, e nada está no futuro;
 *   3. REENCENAÇÃO: cada passo é produzido de novo pela porta real que o grava
 *      (`runFollowupTick`, `completeTurnForEnrollment`, `applyReactivityEvent`),
 *      no relógio do passo, sobre um banco em memória — e o que o motor escreve
 *      tem de ser idêntico ao que o seed grava, inclusive o estado final da
 *      inscrição. Só o banco é dublê.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runFollowupTick, type AdminClient, type FollowupJobRequest } from "@/lib/followup/engine";
import { descreveEvento, resumoDoNo } from "@/lib/followup/eventos-legiveis";
import { flowGraphSchema } from "@/lib/followup/graph-schema";
import type { EnrollmentEventRef, EnrollmentRow } from "@/lib/followup/node-handlers";
import { applyReactivityEvent, type ReactivityAdminClient } from "@/lib/followup/reactivity";
import { completeTurnForEnrollment, type TurnBridgeAdminClient } from "@/lib/followup/turn-bridge";

import {
  inscricoesDeDemonstracao,
  PONTEIRO_DE_DEMONSTRACAO,
  type InscricaoDeDemonstracao,
  type PassoDeDemonstracao,
} from "../../scripts/lib/followups-de-demonstracao";
import { GRAFO_DE_DEMONSTRACAO } from "../../scripts/lib/grafo-de-demonstracao";

const RAIZ = process.cwd();
const ORG = "87500000-0000-4000-8000-0000000000f1";
const PONTEIRO = "87500000-0000-4000-8000-0000000000f2";
const VERSAO = "87500000-0000-4000-8000-0000000000f3";
const CONVERSA = "87500000-0000-4000-8000-0000000000f4";
const EVENTO_DE_ATENDIMENTO = "87500000-0000-4000-8000-0000000000f5";
const AGORA = Date.parse("2026-09-15T12:00:00.000Z");

const GRAFO = flowGraphSchema.parse(GRAFO_DE_DEMONSTRACAO);
const INSCRICOES = inscricoesDeDemonstracao(AGORA, EVENTO_DE_ATENDIMENTO);

function idDaInscricao(i: number): string {
  return `87500000-0000-4000-8000-00000000010${i}`;
}

function idDoContato(i: number): string {
  return `87500000-0000-4000-8000-00000000020${i}`;
}

// ─── 1. o vocabulário vem do código que escreve ────────────────────────────

function arquivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = path.join(dir, nome);
    if (statSync(caminho).isDirectory()) return nome === "node_modules" ? [] : arquivosTs(caminho);
    return /\.tsx?$/.test(nome) && !/\.test\.tsx?$/.test(nome) ? [caminho] : [];
  });
}

/** Quem INSERE em `followup_enrollment_events`, por supabase-js ou por SQL. */
const ESCREVE_NA_TRILHA =
  /from\(\s*["']followup_enrollment_events["']\s*\)\s*\.insert|insert\s+into\s+(?:public\.)?followup_enrollment_events/;

const ESCRITORES = ["lib", "app"]
  .flatMap((d) => arquivosTs(path.join(RAIZ, d)))
  .filter((arquivo) => ESCREVE_NA_TRILHA.test(readFileSync(arquivo, "utf8")));

describe("vocabulário da trilha de demonstração", () => {
  it("o instrumento acha os escritores do motor (controle)", () => {
    // Sem isto, uma regex que deixasse de casar produziria zero escritores — e o
    // caso abaixo reprovaria por outro motivo, ou, com a checagem invertida,
    // passaria medindo nada.
    const relativos = ESCRITORES.map((a) => path.relative(RAIZ, a));
    expect(relativos).toEqual(
      expect.arrayContaining(["lib/followup/engine.ts", "lib/followup/turn-bridge.ts", "lib/followup/reactivity.ts"]),
    );
  });

  it("todo código de passo é um literal que algum escritor da trilha grava", () => {
    const fontes = ESCRITORES.map((a) => readFileSync(a, "utf8"));
    for (const [i, inscricao] of INSCRICOES.entries()) {
      for (const passo of inscricao.passos(idDaInscricao(i))) {
        expect(
          fontes.some((fonte) => fonte.includes(`"${passo.event_type}"`)),
          `"${inscricao.contato.nome}": nenhum código que escreve a trilha grava "${passo.event_type}"`,
        ).toBe(true);
      }
    }
  });

  it("a tela sabe dizer cada passo — nenhum cai no 'Passo registrado pelo motor'", () => {
    const nos = Object.fromEntries(GRAFO.nodes.map((n) => [n.id, resumoDoNo(n)]));
    for (const [i, inscricao] of INSCRICOES.entries()) {
      for (const [j, passo] of inscricao.passos(idDaInscricao(i)).entries()) {
        const legivel = descreveEvento({ id: `p${j}`, ...passo }, nos, "pt-BR");
        expect(legivel.detalhe ?? "", `"${inscricao.contato.nome}", passo ${passo.event_type}`).not.toMatch(/^código:/);
        expect(legivel.onde, `"${inscricao.contato.nome}": o passo aponta para um nó fora do grafo`).not.toMatch(
          /não existe mais/,
        );
      }
    }
  });
});

// ─── 2. o relógio ──────────────────────────────────────────────────────────

describe("datas da trilha de demonstração", () => {
  it("começam no início da inscrição, andam para a frente e não passam de agora", () => {
    for (const [i, inscricao] of INSCRICOES.entries()) {
      const inicio = Date.parse(inscricao.estado.started_at);
      let anterior = inicio;
      const passos = inscricao.passos(idDaInscricao(i));
      expect(passos.length, `"${inscricao.contato.nome}" sem trilha`).toBeGreaterThan(0);
      for (const passo of passos) {
        const quando = Date.parse(passo.created_at);
        expect(quando, `"${inscricao.contato.nome}": ${passo.event_type} antes do passo anterior ou do início`).toBeGreaterThanOrEqual(anterior);
        anterior = quando;
      }
      expect(anterior, `"${inscricao.contato.nome}": trilha no futuro`).toBeLessThanOrEqual(AGORA);
      expect(Date.parse(inscricao.estado.updated_at), `"${inscricao.contato.nome}": updated_at`).toBe(anterior);
      if (inscricao.estado.next_eval_at) {
        expect(Date.parse(inscricao.estado.next_eval_at), `"${inscricao.contato.nome}": relógio vencido`).toBeGreaterThan(AGORA);
      }
    }
  });

  it("a Fila mostra os quatro estados", () => {
    expect(INSCRICOES.map((i) => i.estado.status).sort()).toEqual(
      ["active", "completed", "paused_handoff", "waiting_reply"].sort(),
    );
  });
});

// ─── 3. reencenação com o motor de verdade ────────────────────────────────

interface LinhaDoEvento extends EnrollmentEventRef {
  node_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  created_at: string;
}

/**
 * O banco de UMA inscrição, com as três superfícies estreitas que as portas do
 * motor pedem. Leitura fora do mundo da demonstração (mensagem de entrada, lead,
 * aviso de morte) devolve vazio ou lança — uma demonstração que precise disso
 * não é a que o seed grava.
 */
class BancoEmMemoria implements TurnBridgeAdminClient, ReactivityAdminClient {
  relogio = 0;
  readonly eventos: LinhaDoEvento[] = [];
  readonly jobs: FollowupJobRequest[] = [];

  constructor(public inscricao: EnrollmentRow) {}

  async claimDueEnrollments(_limit: number, leaseSeconds: number): Promise<EnrollmentRow[]> {
    const e = this.inscricao;
    const devida =
      (e.status === "active" || e.status === "waiting_reply") &&
      e.next_eval_at !== null &&
      Date.parse(e.next_eval_at) <= this.relogio &&
      (e.claimed_until === null || Date.parse(e.claimed_until) <= this.relogio);
    if (!devida) return [];
    e.claimed_until = new Date(this.relogio + leaseSeconds * 1000).toISOString();
    return [{ ...e }];
  }
  async loadEnrollmentById(orgId: string, id: string): Promise<EnrollmentRow | null> {
    return orgId === this.inscricao.organization_id && id === this.inscricao.id ? { ...this.inscricao } : null;
  }
  async loadFlowGraph(_orgId: string, versionId: string) {
    return versionId === VERSAO ? GRAFO : null;
  }
  async loadLeadFacts() {
    return { lead_stage: null, tags: [], contact_name: null, custom_fields: {} };
  }
  async loadLastInboundBody() {
    return null;
  }
  async loadEnrollmentEvents(): Promise<EnrollmentEventRef[]> {
    return this.eventos.map((e) => ({ ...e }));
  }
  async insertEnrollmentEvent(evento: {
    node_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    idempotency_key: string;
  }): Promise<{ inserted: boolean }> {
    if (this.eventos.some((e) => e.idempotency_key === evento.idempotency_key)) return { inserted: false };
    this.eventos.push({
      node_id: evento.node_id,
      event_type: evento.event_type,
      payload: evento.payload,
      idempotency_key: evento.idempotency_key,
      created_at: new Date(this.relogio).toISOString(),
    });
    return { inserted: true };
  }
  async updateEnrollment(_id: string, _orgId: string, patch: Partial<EnrollmentRow>): Promise<void> {
    Object.assign(this.inscricao, patch);
  }
  async loadFlowPointerName() {
    return PONTEIRO_DE_DEMONSTRACAO.name;
  }
  async insertDeadInboxItem(item: { body: string }): Promise<void> {
    throw new Error(`a demonstração morreu: ${item.body}`);
  }
  async persistirRespostaFollowup(): Promise<void> {
    throw new Error("a demonstração não grava resposta de cliente");
  }
  async loadConversationContactId() {
    return this.inscricao.contact_id;
  }
  async loadContactBlocked() {
    return false;
  }
  async loadLiveEnrollmentsForContact() {
    const e = this.inscricao;
    if (!["active", "waiting_reply", "paused_handoff"].includes(e.status)) return [];
    return [
      {
        id: e.id,
        status: e.status,
        current_node_id: e.current_node_id,
        steps_taken: e.steps_taken,
        pointer_id: e.pointer_id,
        handoff_policy: PONTEIRO_DE_DEMONSTRACAO.handoff_policy,
        trigger_config: PONTEIRO_DE_DEMONSTRACAO.trigger_config,
      },
    ];
  }
  async agoraNoBanco() {
    return new Date(this.relogio).toISOString();
  }
}

/** A inscrição como `enrollFlow` (lib/followup/enroll.ts) a cria: no gatilho, relógio = agora. */
function inscricaoRecemCriada(i: number, inscricao: InscricaoDeDemonstracao): EnrollmentRow {
  const inicio = inscricao.estado.started_at;
  return {
    id: idDaInscricao(i),
    organization_id: ORG,
    pointer_id: PONTEIRO,
    version_id: VERSAO,
    contact_id: idDoContato(i),
    conversation_id: null,
    current_node_id: GRAFO.nodes.find((n) => n.type === "trigger")!.id,
    status: "active",
    next_eval_at: inicio,
    claimed_until: null,
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    steps_taken: 0,
    outcome: null,
    cancel_reason: null,
    started_at: inicio,
    completed_at: null,
    updated_at: inicio,
  };
}

/** Chama a porta real que grava este passo, no relógio dele. */
async function reencenar(banco: BancoEmMemoria, passo: PassoDeDemonstracao): Promise<void> {
  banco.relogio = Date.parse(passo.created_at);
  const clock = () => new Date(banco.relogio);
  const db: AdminClient = banco;
  switch (passo.origem) {
    case "motor":
      await runFollowupTick({ db, clock, enqueueJob: async (job) => void banco.jobs.push(job) });
      return;
    case "envio": {
      const job = banco.jobs.shift();
      expect(job, `"${passo.event_type}": não há envio enfileirado para concluir`).toBeDefined();
      await completeTurnForEnrollment(banco, ORG, banco.inscricao.id, job!.payload.node_id, { kind: "sent" }, clock);
      return;
    }
    case "atendimento_humano":
      await applyReactivityEvent(banco, clock, {
        id: EVENTO_DE_ATENDIMENTO,
        organization_id: ORG,
        event_type: "ai.handoff_triggered",
        entity_kind: "conversation",
        entity_id: CONVERSA,
        payload: { conversation_id: CONVERSA },
        metadata: {},
        consumed_by: [],
        attempts: 0,
      });
      return;
  }
}

describe("reencenação das inscrições de demonstração com o motor", () => {
  for (const [i, inscricao] of INSCRICOES.entries()) {
    it(`"${inscricao.contato.nome}": o motor grava a mesma trilha e chega ao mesmo estado`, async () => {
      const banco = new BancoEmMemoria(inscricaoRecemCriada(i, inscricao));
      const passos = inscricao.passos(banco.inscricao.id);

      for (const [n, passo] of passos.entries()) {
        const antes = banco.eventos.length;
        await reencenar(banco, passo);
        expect(banco.eventos.length, `passo ${n + 1} (${passo.event_type}): o motor não gravou nada neste instante`).toBe(
          antes + 1,
        );
        const { origem: _origem, ...gravado } = passo;
        expect(banco.eventos[antes], `passo ${n + 1}: o motor gravaria outra coisa`).toEqual(gravado);
      }

      const e = banco.inscricao;
      expect({
        status: e.status,
        current_node_id: e.current_node_id,
        steps_taken: e.steps_taken,
        next_eval_at: e.next_eval_at,
        outcome: e.outcome,
        started_at: e.started_at,
        updated_at: e.updated_at,
        completed_at: e.completed_at,
      }).toEqual(inscricao.estado);
      expect(banco.jobs, "sobrou envio enfileirado sem conclusão").toEqual([]);
    });
  }

  it("o dublê reprova a trilha antiga (controle do instrumento)", async () => {
    // Os dois passos da primeira versão, no relógio dela: um dia antes do fim da
    // espera e um código que ninguém emite. Sem este controle, um dublê que
    // aceitasse qualquer passo deixaria os casos acima verdes medindo nada.
    const inscricao = INSCRICOES[1]!;
    const banco = new BancoEmMemoria(inscricaoRecemCriada(1, inscricao));
    const inicio = Date.parse(inscricao.estado.started_at);
    await reencenar(banco, {
      origem: "motor",
      node_id: "wait-1",
      event_type: "node_entered",
      payload: { node_type: "wait" },
      idempotency_key: "wait-1:0",
      created_at: new Date(inicio + 60_000).toISOString(),
    });
    expect(banco.eventos[0]?.event_type).toBe("node_advanced");
    expect(banco.eventos[0]?.event_type).not.toBe("node_entered");
  });
});
