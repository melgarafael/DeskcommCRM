/**
 * Semente do módulo "Alertas" (Agente de IA › Ver tudo em IA › Alertas,
 * /app/ai/inbox): a Central de avisos da Clínica Bem Viver com o que a Bia
 * escalou para a equipe — cinco avisos abertos, um de cada gravidade e de
 * destinos diferentes, e um já resolvido para a aba "Resolvidos".
 *
 * Grava como o runtime grava (`agent_inbox_items`, `kind`/`severity`/`ref_kind`
 * do contrato em `lib/ai/inbox-destino.ts`), apontando para as conversas da
 * base: é a referência que faz cada linha mostrar o botão do destino ("Abrir
 * conversa", "Abrir uma conversa afetada"). O aviso de orçamento aponta para a
 * organização (`ai_budget`): para quem atende ele aparece SEM botão, com o
 * "Peça ao gestor…" — é a linha que ensina que nem todo aviso é seu.
 *
 * `limpar` é exportado: um aviso aberto acende o sino (contador) no topo de
 * TODAS as telas, e uma sobra mudaria a foto de qualquer outro módulo.
 *
 * Idempotente: apaga só as próprias linhas (ids fixos) e recria. As lições que
 * marcam um aviso como resolvido mexem nestas mesmas linhas — a próxima
 * rodada da base as devolve ao estado daqui.
 */
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";
import { type Contexto, conversaId, ha, semErro } from "../semear-demonstracao";

const avisoId = (n: number) => `f1d00001-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Aviso = {
  n: number;
  kind: string;
  severity: "info" | "warn" | "critical";
  title: string;
  body: string;
  /** Conversa da base (`conversaId`); ausente = aviso da organização (orçamento). */
  conversa?: number;
  em: string;
  resolvidoEm?: string;
};

const AVISOS: Aviso[] = [
  {
    n: 1, kind: "message_send_stuck", severity: "critical", conversa: 6, em: ha(14),
    // o título e o corpo que o cron recover-stuck-messages grava para UMA mensagem
    title: "Uma resposta não chegou ao cliente",
    body: "Ficou mais de 5 minutos aguardando envio e foi marcada como falha. Verifique se a conexão do WhatsApp está ativa. Nada foi reenviado automaticamente — reenviar sem saber a causa arrisca mandar a mesma mensagem duas vezes.",
  },
  {
    n: 2, kind: "handoff", severity: "critical", conversa: 1, em: ha(38),
    title: "Atendimento automático parou — assumir a conversa",
    body: "A Mariana Souza pediu para falar com uma pessoa sobre o plano alimentar. A Bia avisou que alguém da equipe vai responder.",
  },
  {
    n: 3, kind: "promise_unfulfilled", severity: "warn", conversa: 3, em: ha(88),
    title: "Um retorno prometido a um cliente ficou sem dono",
    body: "A Bia ofereceu à Juliana Castro ver um horário de fisioterapia, e o retorno não chegou a ser agendado. Abra a conversa, veja o que foi combinado e cumpra você mesmo.",
  },
  {
    n: 4, kind: "budget_warning", severity: "warn", em: ha(300),
    title: "O gasto de IA deste mês passou de 80% do limite",
    body: "Já foram usados US$ 12,10 dos US$ 15,00 definidos para o mês. A IA continua respondendo normalmente.",
  },
  {
    n: 5, kind: "snooze_expired", severity: "info", conversa: 12, em: ha(600),
    title: "A Tereza Gomes não respondeu no prazo",
    body: "A conversa ficou em espera para a Tereza confirmar o retorno do clareamento, e o prazo acabou sem resposta.",
  },
  {
    n: 6, kind: "handoff", severity: "critical", conversa: 11, em: ha(2 * 24 * 60), resolvidoEm: ha(2 * 24 * 60 - 90),
    title: "Atendimento automático parou — assumir a conversa",
    body: "O Osvaldo Pires pediu o resultado do exame, que a Bia não pode informar pelo WhatsApp.",
  },
];

/** Limpeza chamada antes de QUALQUER aula: sem ela o sino de todas as telas contaria estes avisos. */
export async function limpar(c: Contexto) {
  semErro(
    await c.db.from("agent_inbox_items").delete().eq("organization_id", c.org).in("id", AVISOS.map((a) => avisoId(a.n))),
    "limpar avisos da Central",
  );
}

export async function semear(c: Contexto) {
  await limpar(c);
  semErro(
    await c.db.from("agent_inbox_items").insert(
      AVISOS.map((a) => ({
        id: avisoId(a.n),
        organization_id: c.org,
        kind: a.kind,
        severity: a.severity,
        title: demo(a.title),
        body: demo(a.body),
        ref_kind: a.conversa ? "conversation" : "ai_budget",
        // o aviso de orçamento aponta para a própria organização, como `orcamento.ts` grava
        ref_id: a.conversa ? conversaId(a.conversa) : c.org,
        status: a.resolvidoEm ? "resolved" : "open",
        resolved_at: a.resolvidoEm ?? null,
        created_at: a.em,
      })),
    ),
    "avisos da Central",
  );
}
