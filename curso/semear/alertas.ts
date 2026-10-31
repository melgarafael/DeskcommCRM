/**
 * Semente do módulo "Alertas" (/app/ai/inbox, a "Central de avisos").
 *
 * Numa instalação fresca a Central está vazia: os avisos nascem do worker e dos
 * crons, que ficam PARADOS na bancada do curso. Aqui gravamos seis avisos como
 * os produtores do produto gravam — mesmo `kind`, `severity`, `ref_kind` e o
 * mesmo texto de título e corpo —, para a tela mostrar as três gravidades, um
 * aviso com botão, um sem botão e a aba "Resolvidos":
 *
 *   abertos   — handoff (crítico, conversa da Mariana), message_send_stuck
 *               (crítico, a mensagem que falhou na conversa da Fernanda),
 *               snooze_expired (atenção, conversa da Juliana) e
 *               contact_proposal_expired (informativo, sem botão);
 *   resolvidos — qr_rescan da conexão da base (caiu ontem e já voltou) e um
 *               handoff antigo da conversa do Lucas.
 *
 * Textos de origem: lib/ai/handoff/orchestrator.ts + lib/escalacao/passagem.ts
 * (handoff), app/api/v1/cron/recover-stuck-messages/route.ts, app/api/v1/cron/
 * snooze-watcher/route.ts, lib/contacts/proposta-de-dado.ts e
 * lib/channels/health.ts (qr_rescan). Os avisos só APONTAM para conversas e
 * para a conexão da base (ref_id); nenhuma linha da base é alterada.
 *
 * Também devolve o "Lembrete de caso parado" da organização ao padrão do
 * produto (ligado, a cada 24 horas, três avisos por espera): a última lição
 * troca o intervalo pela tela, e a seguinte precisa começar do padrão.
 *
 * Idempotente: apaga só os avisos com os ids daqui e recria. O gatilho
 * `trg_aviso_da_central_criado` anuncia cada aviso no event_log; com o worker
 * parado, nada vai ao celular de ninguém.
 */
import { type Contexto, conversaId, ha, ontemAs, semErro } from "../semear-demonstracao";
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";

const avisoId = (n: number) => `d1190000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Aviso = {
  n: number;
  kind: string;
  severity: "info" | "warn" | "critical";
  title: string;
  body: string | null;
  ref: { kind: string; id: string } | null;
  em: string;
  resolvido?: string;
};

export async function semear(c: Contexto) {
  const { db, org, sessao } = c;

  const AVISOS: Aviso[] = [
    {
      n: 1,
      kind: "handoff",
      severity: "critical",
      title: demo("Atendimento automático parou — assumir a conversa"),
      body: [
        demo("O cliente pediu para falar com uma pessoa"),
        demo("O cliente JÁ FOI avisado de que uma pessoa vai assumir."),
        demo("Abra a conversa para ver o contexto."),
      ].join(" · "),
      ref: { kind: "conversation", id: conversaId(1) },
      em: ha(37),
    },
    {
      n: 2,
      kind: "message_send_stuck",
      severity: "critical",
      title: demo("Uma resposta não chegou ao cliente"),
      body: demo(
        "Ficaram mais de 5 minutos aguardando envio e foram marcadas como falha. Verifique se a conexão do WhatsApp está ativa e se o worker de envio está rodando. Nada foi reenviado automaticamente — reenviar sem saber a causa arrisca mandar a mesma mensagem duas vezes.",
      ),
      ref: { kind: "conversation", id: conversaId(5) },
      em: ha(116),
    },
    {
      n: 3,
      kind: "snooze_expired",
      severity: "warn",
      title: demo("Lead não respondeu no prazo"),
      body: null,
      ref: { kind: "conversation", id: conversaId(3) },
      em: ha(28),
    },
    {
      n: 4,
      kind: "contact_proposal_expired",
      severity: "info",
      title: demo("Uma informação de cliente venceu sem alguém conferir"),
      body: demo(
        "O assistente ouviu um dado na conversa com um cliente e ninguém confirmou a tempo. Ele saiu da ficha para não parecer que já estava salvo. Se a informação ainda importa, peça de novo ou preencha à mão.",
      ),
      ref: { kind: "organization", id: org },
      em: ha(180),
    },
    {
      n: 5,
      kind: "qr_rescan",
      severity: "critical",
      title: demo('WhatsApp "Recepção Bem Viver" desconectado — precisa escanear o QR de novo'),
      body: demo("Enquanto isso não acontecer, nenhuma mensagem entra nem sai por esta conexão."),
      ref: { kind: "channel_session", id: sessao },
      em: ontemAs(8, 12),
      resolvido: ontemAs(8, 40),
    },
    {
      n: 6,
      kind: "handoff",
      severity: "critical",
      title: demo("Atendimento automático parou — assumir a conversa"),
      body: [
        demo("O assistente não teve confiança suficiente para responder"),
        demo("O cliente JÁ FOI avisado de que uma pessoa vai assumir."),
        demo("Abra a conversa para ver o contexto."),
      ].join(" · "),
      ref: { kind: "conversation", id: conversaId(6) },
      em: ha(240),
      resolvido: ha(190),
    },
  ];

  semErro(
    await db
      .from("agent_inbox_items")
      .delete()
      .eq("organization_id", org)
      .in(
        "id",
        AVISOS.map((a) => avisoId(a.n)),
      ),
    "limpar avisos da Central",
  );
  semErro(
    await db.from("agent_inbox_items").insert(
      AVISOS.map((a) => ({
        id: avisoId(a.n),
        organization_id: org,
        kind: a.kind,
        severity: a.severity,
        title: a.title,
        body: a.body,
        ref_kind: a.ref?.kind ?? null,
        ref_id: a.ref?.id ?? null,
        status: a.resolvido ? "resolved" : "open",
        resolved_at: a.resolvido ?? null,
        created_at: a.em,
      })),
    ),
    "avisos da Central",
  );

  // o padrão do produto (migration 0766): ligado, a cada 24 horas, três avisos por espera
  semErro(
    await db
      .from("organizations")
      .update({ lembrete_caso_ligado: true, lembrete_caso_intervalo_horas: 24, lembrete_caso_teto: 3 })
      .eq("id", org),
    "lembrete de caso parado no padrão",
  );
}
