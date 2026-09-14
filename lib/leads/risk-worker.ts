import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";

import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import { calculaBucketsAtuais, type EstadoCalculado } from "@/lib/leads/risk-seed";
import { propoeReativacao } from "@/lib/leads/reactivation";
import type { RiskBucket } from "@/lib/leads/risk-radar";
import type { ActivityType } from "@/lib/leads/activity-vocabulary";

/**
 * O OBSERVADOR DA TRAVESSIA — a peça que faz "esfriando" acontecer sem ninguém
 * abrir tela nenhuma.
 *
 * Antes desta wave, `classifyRisk` só rodava dentro de rotas de LEITURA: o
 * estado não existia até alguém olhar. Um radar que só enxerga quando observado
 * não é mecanismo anti-morte — é a mesma morte, com testemunha opcional.
 *
 * ⚠️ SÓ ESCREVE QUANDO O BUCKET MUDA. É a contrapartida que a 0078 pediu e que o
 * banco não consegue garantir: a tabela está DENTRO da publicação de realtime,
 * então um `update` que só refresque `detected_at` publicaria evento sem
 * mudança de estado e o board voltaria a piscar à toa — o defeito que a
 * separação toda existe para impedir.
 *
 * ⚠️ E NÃO TOCA `crm_leads`. Nem por escrita direta, nem pelo trigger: as
 * atividades que ele emite (`lead_cooled`, `lead_reactivated`) estão FORA da
 * lista positiva da 0079, então não carimbam `last_activity_at`. É por isso que
 * o produtor não se autodestrói, e é por isso que o arrasto em voo do usuário
 * não é invalidado por um worker rodando em segundo plano (o 409 fantasma).
 */

export interface ResultadoDaObservacao {
  avaliados: number;
  travessias: number;
  esfriaram: number;
  reativaram: number;
  /** Mudanças de bucket que não merecem linha na timeline (ver `narra`). */
  silenciosas: number;
  falhasDeAtividade: number;
  /** Propostas de reativação criadas nesta passada. */
  propostas: number;
  /**
   * Gravacoes que falharam nesta passada. CONTADA, e nao engolida: sem este
   * numero, trocar o `throw` por `continue` teria virado silencio — que e
   * pior que o defeito que ele conserta.
   */
  falhasDeGravacao: number;
}

/**
 * O que a travessia CONTA para um humano — e o que ela não conta.
 *
 * `null` significa "mude o estado, mas não escreva na timeline". Nem toda
 * mudança de bucket é acontecimento: entrar em `em_voo` é a IA ter agendado
 * retorno, e isso já é registrado por quem agendou. Duplicar viraria duas linhas
 * para um evento só, e a timeline passa a parecer que o sistema fala sozinho.
 */
function narra(
  de: RiskBucket | null,
  para: RiskBucket,
): { tipo: ActivityType; reason: string } | null {
  if (de === para) return null;
  if (para === "em_risco" && (de === "em_dia" || de === null)) {
    return { tipo: "lead_cooled", reason: "Sem resposta além do prazo deste estágio" };
  }
  if (para === "critico") {
    // Vale linha mesmo vindo de `em_risco`: passar de "esfriando" a "parado há
    // muito tempo" é a mudança que decide se alguém liga hoje ou semana que vem.
    return { tipo: "lead_cooled", reason: "Parado há muito tempo — sem resposta" };
  }
  if (para === "em_dia" && de !== null && de !== "em_dia") {
    return { tipo: "lead_reactivated", reason: "Voltou a ter movimento" };
  }
  return null;
}

interface EstadoGravado {
  lead_id: string;
  bucket: RiskBucket;
}

export async function observaTravessias(
  admin: SupabaseClient,
  organizationId: string,
  now: Date = new Date(),
): Promise<ResultadoDaObservacao> {
  const atuais = await calculaBucketsAtuais(admin, organizationId, now);

  const { data: gravados, error } = await admin
    .from("crm_lead_risk_states")
    .select("lead_id, bucket")
    .eq("organization_id", organizationId);
  if (error) throw new Error(`observador de risco: ${error.message}`);
  const anterior = new Map<string, RiskBucket>(
    ((gravados ?? []) as EstadoGravado[]).map((g) => [g.lead_id, g.bucket]),
  );

  const r: ResultadoDaObservacao = {
    avaliados: atuais.length,
    travessias: 0,
    esfriaram: 0,
    reativaram: 0,
    silenciosas: 0,
    falhasDeAtividade: 0,
    propostas: 0,
    falhasDeGravacao: 0,
  };

  for (const e of atuais) {
    const de = anterior.get(e.leadId) ?? null;
    if (de === e.bucket) continue; // nada mudou: NÃO escreve (ver o ⚠️ acima)
    r.travessias += 1;

    const linha = narra(de, e.bucket);
    const { error: upErr } = await admin.from("crm_lead_risk_states").upsert(
      {
        lead_id: e.leadId,
        organization_id: organizationId,
        bucket: e.bucket,
        since: e.since.toISOString(),
        // `detected_at` OMITIDO de propósito: o default `now()` do banco é o
        // mesmo relógio que ancora `since` (via `last_activity_at`). Com o
        // relógio do processo aqui, um negócio tocado 2s antes da passada
        // produzia `since > detected_at` e o worker INTEIRO abortava na
        // constraint. Ver o cabeçalho de `risk-seed.ts`.
        cold_hours: e.coldHours,
      },
      { onConflict: "lead_id" },
    );
    if (upErr) {
      // ⛔ UMA LINHA RUIM CUSTA UMA LINHA.
      //
      // Antes este `throw` parava o laço, e o observador INTEIRO da organização
      // morria na primeira travessia problemática — as demais nem chegavam a
      // ser avaliadas. Medido em produção: um `since` no futuro derrubava a
      // passada toda.
      //
      // ⛔ E NÃO É SILÊNCIO: a falha é CONTADA e registrada. Engolir seria
      // trocar "para e grita" por "não faz e cala", que ninguém descobre — e é
      // pior que o defeito original.
      r.falhasDeGravacao += 1;
      logger.error("risco.gravacao_falhou", {
        organizationId,
        leadId: e.leadId,
        bucket: e.bucket,
        motivo: upErr.message,
      });
      continue;
    }

    if (!linha) {
      r.silenciosas += 1;
      continue;
    }
    if (linha.tipo === "lead_cooled") {
      r.esfriaram += 1;
      // A PROPOSTA NASCE COM O ESFRIAMENTO, no mesmo tick. Deixar para um
      // segundo worker criaria uma janela em que o negócio está frio e não tem
      // o que fazer a respeito — e é justamente a janela em que alguém olharia.
      //
      // Nasce SEM RASCUNHO de propósito: se ela só existisse com texto de LLM,
      // uma indisponibilidade do provedor viraria silêncio, que é a doença que
      // esta wave cura. "Sem rascunho ainda" é estado honesto; "proposta que não
      // nasceu" não é estado, é ausência.
      const proposta = await propoeReativacao(admin, {
        organizationId,
        leadId: e.leadId,
        coldHours: e.coldHours,
        now,
      });
      if (proposta) r.propostas += 1;
    } else r.reativaram += 1;

    const atividade = await emitLeadActivity(admin, {
      organizationId,
      leadId: e.leadId,
      contactId: e.contactId,
      type: linha.tipo,
      sourceModule: "crm",
      sourceId: e.leadId,
      // `webhook_source` é como o produto se declara ator: não foi pessoa nem
      // agente, foi o sistema observando o relógio. `actorParaAtividade` o
      // traduz para `actor_kind = 'system'`, que é a FORMA tracejada na
      // timeline — a mesma de qualquer coisa que aconteceu sem alguém decidir.
      actor: { type: "webhook_source", id: "risk-worker" },
      // O reason NOMEIA o estado, nunca dado do negócio — mesma regra do
      // `lead_edited`: reason é renderizado na tela e vai junto em captura,
      // exportação e ticket de suporte.
      reason: linha.reason,
      payload: { de, para: e.bucket, cold_hours: e.coldHours },
    });
    if (!atividade.ok) {
      // Rastro de mudança já ocorrida: falha BAIXO, mas CONTADA e alertada. O
      // estado já foi gravado; engolir aqui faria a timeline divergir da tabela
      // em silêncio — o card mudaria de cor sem nada explicando por quê.
      r.falhasDeAtividade += 1;
      await registraFalhaDeAtividade(admin, {
        organizationId,
        leadId: e.leadId,
        tipo: linha.tipo,
        origem: "lib/leads/risk-worker.observaTravessias",
        erro: atividade.error,
      });
    }
  }

  return r;
}

export type { EstadoCalculado };
