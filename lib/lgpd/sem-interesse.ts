/**
 * "NÃO TEM INTERESSE" GRAVADO COMO RECUSA DE MARKETING — a forma, num lugar só.
 *
 * ═══ A regra (decisão D3 do dono) ═══
 *
 * Quem disse que não tem interesse não volta a ser abordado. A marca é uma recusa de
 * MARKETING em `contacts.consent.marketing`, no formato `{ granted: false, declined_at }`
 * que `recusaRegistrada` (`lib/lgpd/recusa-registrada.ts`) já lê. Por isso ela vale, sem
 * código novo em cada guarda, para a prospecção (`lib/prospecting/guard.ts`), as
 * Campanhas de envio (`lib/campanhas/elegibilidade.ts`), as automações e o e-mail
 * (`lib/automation/guarda-do-contato.ts`, `lib/automation/actions/send-email.ts`).
 *
 * Não é o PARAR: o contato NÃO fica bloqueado (`is_blocked`), a equipe continua
 * podendo responder, e a IA continua atendendo quem escreve.
 *
 * ═══ Desfazer ═══
 *
 * A recusa guarda o que estava em `marketing` antes dela (`anterior`). Desfazer (aba
 * LGPD da ficha) devolve exatamente aquilo: o consentimento que existia volta, e a
 * ausência volta a ser ausência. Só se desfaz a recusa QUE ESTE ARQUIVO gravou
 * (`motivo: "sem_interesse"`); a revogação feita pela captação ou pela ficha não é
 * tocada por aqui.
 */
import { normalizarTexto } from "@/lib/opt-out/deteccao";
import { recusaRegistrada } from "@/lib/lgpd/recusa-registrada";

/** O motivo gravado na recusa. Constante: o leitor e o escritor usam a mesma. */
export const MOTIVO_SEM_INTERESSE = "sem_interesse" as const;

/** De onde a recusa veio. Vai na própria recusa e na auditoria. */
export type OrigemDoSemInteresse = "ficha" | "conversa_de_prospeccao";

/**
 * O motivo de perda que o negócio recebe quando o funil não tem um rótulo próprio.
 * O banco só aceita motivo canônico ou listado no funil (`fn_validate_lost_reason_required`),
 * e nenhum canônico diz "sem interesse" — `requested_by_customer` é cancelamento.
 */
export const MOTIVO_DE_PERDA_SEM_ROTULO = "other" as const;

type Consent = Record<string, unknown>;

function comoObjeto(v: unknown): Consent {
  return v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Consent) } : {};
}

/**
 * Onde a frase vale: o id da campanha de prospecção que `lib/prospecting/store.ts` grava em
 * `conversations.metadata`, ou `null` quando a conversa não é de prospecção. Lido pela
 * ingestão (`lib/channels/pos-entrada.ts`) e pelo nascimento do card
 * (`lib/leads/nascimento-do-lead.ts`): uma régua só para "esta conversa é de prospecção".
 */
export function campanhaDeProspeccaoDaConversa(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const id = (metadata as Record<string, unknown>).prospecting_campaign_id;
  return typeof id === "string" && id.trim() !== "" ? id : null;
}

/** A recusa de marketing deste contato é a "sem interesse" gravada por aqui? */
export function ehRecusaSemInteresse(consent: unknown): boolean {
  if (!recusaRegistrada(consent, "marketing")) return false;
  const marketing = comoObjeto(comoObjeto(consent).marketing);
  return marketing.motivo === MOTIVO_SEM_INTERESSE;
}

/** A recusa "sem interesse" como a tela a lê. A forma gravada só é conhecida aqui. */
export interface RecusaSemInteresse {
  /** ISO-8601, ou `null` quando a data gravada não é legível. */
  declinedAt: string | null;
  origem: OrigemDoSemInteresse;
}

/**
 * Lê a recusa "sem interesse" do `consent`, ou `null` quando ela não existe. A ficha e o
 * nascimento do card leem por aqui, e nunca o caminho do jsonb direto (anti-pattern 6).
 */
export function lerRecusaSemInteresse(consent: unknown): RecusaSemInteresse | null {
  if (!ehRecusaSemInteresse(consent)) return null;
  const marketing = comoObjeto(comoObjeto(consent).marketing);
  const data = typeof marketing.declined_at === "string" ? marketing.declined_at : null;
  return {
    declinedAt: data && !Number.isNaN(Date.parse(data)) ? data : null,
    origem: marketing.origem === "conversa_de_prospeccao" ? "conversa_de_prospeccao" : "ficha",
  };
}

/**
 * A recusa de ofertas resumida para quem só precisa decidir o que mostrar (o painel da
 * conversa, pelo `crm-summary`): `"sem_interesse"` para a recusa que este módulo grava,
 * `"outra"` para a recusa de marketing vinda de outro caminho (captação, ficha), `null`
 * sem recusa. Com qualquer recusa o "Marcar sem interesse" não aparece: gravar por cima
 * apagaria a data e a origem da primeira.
 */
export type SituacaoDaRecusaDeOfertas = "sem_interesse" | "outra" | null;

export function situacaoDaRecusaDeOfertas(consent: unknown): SituacaoDaRecusaDeOfertas {
  if (lerRecusaSemInteresse(consent)) return "sem_interesse";
  return recusaRegistrada(consent, "marketing") ? "outra" : null;
}

/**
 * Quanto tempo depois da recusa a conversa da prospecção NÃO ganha card novo.
 *
 * É a janela da despedida: o "ok, obrigado" que vem logo depois do "não tenho
 * interesse" (o #4076 mediu despedidas até 85 minutos depois do fechamento). Passada
 * a janela, quem volta para comprar na MESMA conversa abre negócio como qualquer um.
 * A recusa de ofertas continua valendo: ela barra a prospecção e as Campanhas, não o
 * atendimento.
 */
export const JANELA_SEM_CARD_DEPOIS_DA_RECUSA_MS = 6 * 60 * 60 * 1000;

/** A recusa "sem interesse" foi gravada dentro da janela da despedida? */
export function recusaSemInteresseRecente(consent: unknown, agoraMs: number): boolean {
  const recusa = lerRecusaSemInteresse(consent);
  if (!recusa?.declinedAt) return false;
  const idade = agoraMs - Date.parse(recusa.declinedAt);
  // Um minuto de folga para trás: o relógio de quem gravou e o de quem lê podem divergir.
  return idade > -60_000 && idade < JANELA_SEM_CARD_DEPOIS_DA_RECUSA_MS;
}

/**
 * O `consent` com a recusa "sem interesse" em `marketing`, ou `null` quando já existe
 * uma recusa de marketing (de qualquer origem): reescrevê-la apagaria a data e a origem
 * da recusa que veio primeiro.
 */
export function consentComSemInteresse(
  consent: unknown,
  dados: { agora: string; origem: OrigemDoSemInteresse },
): Consent | null {
  if (recusaRegistrada(consent, "marketing")) return null;
  const atual = comoObjeto(consent);
  const anterior = atual.marketing && typeof atual.marketing === "object" ? atual.marketing : null;
  return {
    ...atual,
    marketing: {
      granted: false,
      declined_at: dados.agora,
      motivo: MOTIVO_SEM_INTERESSE,
      origem: dados.origem,
      anterior,
    },
  };
}

/**
 * O `consent` sem a recusa "sem interesse", com o `marketing` de antes dela de volta, ou
 * `null` quando a recusa de marketing não é a "sem interesse" (nada a desfazer).
 */
export function consentSemASemInteresse(consent: unknown): Consent | null {
  if (!ehRecusaSemInteresse(consent)) return null;
  const atual = comoObjeto(consent);
  const anterior = comoObjeto(atual.marketing).anterior;
  const resto = { ...atual };
  delete resto.marketing;
  return anterior && typeof anterior === "object" && !Array.isArray(anterior)
    ? { ...resto, marketing: anterior }
    : resto;
}

/**
 * Rótulos que, no funil de quem instala, já significam "não tem interesse" — o
 * primeiro é o que o Cold Call grava (`lib/cold-call/regras.ts`).
 */
const ROTULOS_EQUIVALENTES = new Set([
  "nao tem interesse",
  "nao tenho interesse",
  "sem interesse",
  "nao teve interesse",
  "nao ha interesse",
  "desinteresse",
  "desinteressado",
  "nao interessado",
  "nao esta interessado",
]);

/**
 * O motivo de perda do negócio: o rótulo do funil que diz "não tem interesse", quando o
 * funil tem um; senão `other`, e a timeline diz o porquê. Lê os dois formatos de
 * `settings.lost_reasons` (texto puro e `{ label }`, #1537).
 */
export function motivoDePerdaSemInteresse(settingsDoFunil: unknown): string {
  const lista = comoObjeto(settingsDoFunil).lost_reasons;
  if (!Array.isArray(lista)) return MOTIVO_DE_PERDA_SEM_ROTULO;
  for (const item of lista) {
    const rotulo =
      typeof item === "string" ? item : typeof (item as { label?: unknown } | null)?.label === "string"
        ? (item as { label: string }).label
        : null;
    if (!rotulo) continue;
    const chave = normalizarTexto(rotulo).replace(/[^a-z ]/gu, "").replace(/\s+/gu, " ").trim();
    if (ROTULOS_EQUIVALENTES.has(chave)) return rotulo;
  }
  return MOTIVO_DE_PERDA_SEM_ROTULO;
}
