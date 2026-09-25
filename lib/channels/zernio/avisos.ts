/**
 * Avisos de CANAL — o que a plataforma decide sozinha e o operador precisa saber.
 *
 * ─── O que estava invisível ────────────────────────────────────────────────
 *
 * A plataforma revisa as definições aprovadas e mexe no número por conta
 * própria: reprova um template, suspende a linha por falta de pagamento, exige
 * KYC. Nada disso chegava a lugar nenhum. A descoberta acontecia no disparo que
 * não saiu — com a campanha montada e o cliente esperando.
 *
 * ─── Por que aviso, e não só gravar o estado ───────────────────────────────
 *
 * O estado do template já vive em `meta_templates.status` e é atualizado aqui.
 * Mas ninguém abre a tela de templates por acaso: o aviso é o EMPURRÃO para
 * olhar, e por isso mora na Central, onde o humano já procura o que está
 * errado. Gravar sem avisar seria a informação certa no lugar que ninguém vê.
 *
 * ─── Severidade: o que exige ação hoje ─────────────────────────────────────
 *
 * `critical` para o que INTERROMPE o envio (número suspenso, liberado, conta
 * desconectada) e para template reprovado, porque a campanha que dependia dele
 * não vai sair. `warn` para o que pede atenção sem parar nada. `info` para boa
 * notícia — aprovado, reativado —, que vale registrar e não vale interromper.
 *
 * Marcar tudo como crítico é o mesmo que não marcar nada: o operador aprende a
 * ignorar a cor.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { SaudeObservada } from "../health";

export interface AvisoDeCanal {
  kind: "channel_template_review" | "channel_number_alert";
  severity: "info" | "warn" | "critical";
  title: string;
  body: string | null;
}

type Bruto = Record<string, unknown>;
const obj = (v: unknown): Bruto | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Bruto) : null;
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Estados em que a plataforma pode deixar uma definição. */
const GRAVIDADE_DO_TEMPLATE: Record<string, "info" | "warn" | "critical"> = {
  APPROVED: "info",
  REJECTED: "critical",
  DISABLED: "critical",
  PAUSED: "warn",
  PENDING: "info",
  IN_APPEAL: "warn",
  PENDING_DELETION: "warn",
};

/**
 * Eventos de número → o que significam para quem atende.
 *
 * `activated` e `reactivated` são boa notícia; o resto vai de "precisa fazer
 * algo" a "não dá mais para enviar".
 */
const GRAVIDADE_DO_NUMERO: Record<string, { sev: "info" | "warn" | "critical"; texto: string }> = {
  "whatsapp.number.activated": { sev: "info", texto: "Número ativado." },
  "whatsapp.number.reactivated": { sev: "info", texto: "Número reativado." },
  "whatsapp.number.kyc_submitted": { sev: "info", texto: "Documentação enviada para verificação." },
  "whatsapp.number.verification_required": {
    sev: "warn",
    texto: "A plataforma pede verificação deste número.",
  },
  "whatsapp.number.action_required": {
    sev: "warn",
    texto: "A plataforma pede uma ação neste número.",
  },
  "whatsapp.number.declined": { sev: "critical", texto: "Número recusado pela plataforma." },
  "whatsapp.number.suspended": { sev: "critical", texto: "Número SUSPENSO — não é possível enviar." },
  "whatsapp.number.released": {
    sev: "critical",
    texto: "Número liberado e não utilizável (terminal).",
  },
  "account.disconnected": { sev: "critical", texto: "A conta do canal foi desconectada." },
  "account.connected": { sev: "info", texto: "Conta do canal conectada." },
  "verification.failed": { sev: "critical", texto: "Verificação recusada." },
  "verification.approved": { sev: "info", texto: "Verificação aprovada." },
};

/** O evento merece um aviso? `null` quando não é dos nossos. */
export function avisoDoEvento(payload: unknown): AvisoDeCanal | null {
  const p = obj(payload);
  if (!p) return null;
  const evento = str(p.event) ?? "";

  if (evento === "whatsapp.template.status_updated") {
    const t = obj(p.template) ?? {};
    const nome = str(t.name) ?? "(sem nome)";
    const estado = (str(t.status) ?? "UNKNOWN").toUpperCase();
    const motivo = str(t.reason);
    return {
      kind: "channel_template_review",
      severity: GRAVIDADE_DO_TEMPLATE[estado] ?? "warn",
      title: `Modelo "${nome}": ${estado}`,
      // "NONE" é como a plataforma diz "sem motivo" — repassá-lo seria mostrar
      // ruído no lugar onde o operador procura a explicação.
      body: motivo && motivo.toUpperCase() !== "NONE" ? motivo : null,
    };
  }

  const numero = GRAVIDADE_DO_NUMERO[evento];
  if (numero) {
    const detalhe = str(p.reason) ?? str(obj(p.number)?.reason) ?? null;
    return {
      kind: "channel_number_alert",
      severity: numero.sev,
      title: numero.texto,
      body: detalhe,
    };
  }

  return null;
}

/**
 * O evento fala da CONEXÃO? Então ele é uma observação de saúde.
 *
 * ─── Por que isto não podia continuar sendo só um aviso ─────────────────────
 *
 * `registrarAviso` insere em `agent_inbox_items` SEM `ref_kind` nem `ref_id`, e
 * sem tocar em `channel_sessions` nem em `channel_session_health`. Três
 * consequências, todas medidas na leitura do código:
 *
 *   - o resolvedor de `lib/channels/health.ts` fecha avisos filtrando por
 *     `ref_kind` + `ref_id`. Sem esses campos ele nunca alcança este aviso, e o
 *     CRÍTICO fica `open` para sempre — mesmo depois da conta voltar;
 *   - o dedup de `registrarAviso` é por (kind, title, open), e o
 *     `account.connected` tem título DIFERENTE do `account.disconnected`. Então
 *     a volta abria um `info` novo em vez de fechar o crítico;
 *   - a faixa vermelha do topo lê `channel_sessions.status`, que ninguém
 *     escrevia aqui.
 *
 * Aviso que não se fecha sozinho ensina o operador a desconfiar da Central — é
 * a doutrina escrita no arquivo vizinho, e vale exatamente aqui.
 *
 * Devolve `null` para o que NÃO é conexão (revisão de modelo), porque esse
 * continua sendo aviso puro: não diz nada sobre o canal estar de pé.
 */
export function saudeDoEvento(payload: unknown): SaudeObservada | null {
  const p = obj(payload);
  if (!p) return null;
  const evento = str(p.event) ?? "";

  // O canal está de pé de novo. `WORKING` é o que faz o resolvedor fechar o
  // episódio aberto — e é por isso que a boa notícia precisa passar por aqui.
  const DE_PE = new Set([
    "account.connected",
    "whatsapp.number.activated",
    "whatsapp.number.reactivated",
    "verification.approved",
  ]);

  // Credencial/permissão recusada: existe e não vale mais. O operador troca ou
  // refaz a verificação.
  const RECUSADO = new Set([
    "whatsapp.number.suspended",
    "whatsapp.number.declined",
    "verification.failed",
  ]);

  // A sessão não existe mais do lado de lá. O operador reconecta.
  const SUMIU = new Set(["account.disconnected", "whatsapp.number.released"]);

  if (DE_PE.has(evento)) return { reachable: true, status: "WORKING", detail: null };
  if (RECUSADO.has(evento)) return { reachable: true, status: "FAILED", detail: evento };
  if (SUMIU.has(evento)) return { reachable: true, status: "STOPPED", detail: evento };

  // `verification_required` e `action_required` pedem ação mas NÃO derrubam o
  // envio. Tratá-los como queda faria a faixa vermelha acender num canal que
  // está mandando mensagem — e o operador aprenderia a ignorá-la.
  return null;
}

/**
 * Grava o aviso, sem repetir o que já está aberto.
 *
 * A plataforma reentrega quando não recebe 200, e alguns desses eventos chegam
 * em rajada (uma revisão em lote mexe em vários templates). Sem a checagem, a
 * Central viraria uma lista do mesmo aviso — e uma Central ruidosa é uma
 * Central que ninguém lê.
 */
export async function registrarAviso(
  admin: SupabaseClient,
  organizationId: string,
  aviso: AvisoDeCanal,
): Promise<"criado" | "ja_aberto"> {
  const { data: jaAberto } = await admin
    .from("agent_inbox_items")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("kind", aviso.kind)
    .eq("title", aviso.title)
    .eq("status", "open")
    .limit(1)
    .maybeSingle();

  if (jaAberto) return "ja_aberto";

  await admin.from("agent_inbox_items").insert({
    organization_id: organizationId,
    kind: aviso.kind,
    severity: aviso.severity,
    title: aviso.title,
    body: aviso.body,
  });
  return "criado";
}

/**
 * O estado da definição também vai para o espelho local.
 *
 * O aviso empurra para olhar; esta linha é o que a tela de modelos mostra. Sem
 * ela o operador abriria a tela e veria o estado velho — pior que não avisar,
 * porque contradiz o aviso que acabou de ler.
 *
 * Não cria linha: se o template não está espelhado ainda, quem resolve isso é o
 * sync, que sabe montar a linha inteira. Inventar uma aqui, com o pouco que o
 * evento traz, criaria um registro incompleto que o sync depois teria de
 * consertar.
 */
export async function atualizarEspelhoDoTemplate(
  admin: SupabaseClient,
  organizationId: string,
  payload: unknown,
  channelSessionId?: string | null,
): Promise<boolean> {
  const p = obj(payload);
  if (!p || str(p.event) !== "whatsapp.template.status_updated") return false;
  const t = obj(p.template);
  const nome = str(t?.name);
  const estado = str(t?.status);
  if (!nome || !estado) return false;

  const idioma = str(t?.language) ?? str(t?.lang);
  const motivo = str(t?.reason);
  let query = admin
    .from("meta_templates")
    .update({
      status: estado.toUpperCase(),
      rejected_reason: motivo && motivo.toUpperCase() !== "NONE" ? motivo : null,
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", organizationId)
    .eq("name", nome);

  if (channelSessionId) {
    query = query.eq("channel_session_id", channelSessionId);
  }
  if (idioma) {
    query = query.eq("language", idioma);
  }

  const { data } = await query.select("id");

  return (data ?? []).length > 0;
}
