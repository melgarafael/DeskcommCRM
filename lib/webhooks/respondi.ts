/**
 * Normalizador específico do Respondi — o form builder por trás da fonte
 * "Respondi — Decola Aí Imobiliário".
 *
 * ═══ O BUG, MEDIDO ═══
 *
 * O payload real do Respondi tem dois níveis de aninhamento — `{ form: {...},
 * respondent: { answers: {...} } }` — e `mapInboundPayload` (inbound.ts) só
 * olha CHAVE DE TOPO; objeto aninhado é descartado por desenho ("v1", ver o
 * comentário na função). Resultado: `nameHit`/`phoneHit`/`emailHit` batiam
 * `null` para os TRÊS, a rota devolvia 400 "Nenhum campo mapeável" — depois
 * de já ter gravado a linha em `webhook_events_log` (por isso "Últimos
 * recebimentos" mostrava ponto verde: aquele insert roda ANTES do mapeamento
 * e não sabe se o resto vai falhar). Nenhum contato, nenhum card. Medido
 * lendo `webhook_events_log` de produção em 2026-08-25 (dois envios reais,
 * mesma forma, zero lead criado) — ver PROMPT_AUDITORIA_ORQUESTRACAO.md.
 *
 * ═══ ESTE MÓDULO NÃO SUBSTITUI O GENÉRICO ═══
 *
 * A rota chama `isRespondiPayload` primeiro; só quando bate, usa
 * `mapRespondiPayload`. Qualquer outro envio (form HTML solto, Zapier, n8n,
 * o botão interno "Enviar lead de teste") segue `mapInboundPayload`
 * inalterado — é o requisito explícito de preservar o comportamento atual.
 */
import type { MappedLead } from "@/lib/webhooks/inbound";
import { ehChaveDeAnuncio, normalizePhoneBR } from "@/lib/webhooks/inbound";

interface RespondiRawAnswer {
  answer: unknown;
  question: { question_id?: unknown; question_type?: unknown; question_title?: unknown };
}

export interface RespondiPayload {
  form: { form_id?: unknown; form_name?: unknown };
  respondent: {
    date?: unknown;
    score?: unknown;
    status?: unknown;
    answers: Record<string, unknown>;
    raw_answers?: unknown;
    respondent_id?: unknown;
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * True só quando o payload tem a forma exata que o Respondi manda:
 * `form` e `respondent.answers` como objetos. Qualquer outra coisa (payload
 * genérico, `{form: "texto"}`, `respondent` sem `answers`) devolve `false` e
 * a rota cai no caminho de sempre — detecção deliberadamente estrita para
 * nunca capturar por engano um payload de outra origem.
 */
export function isRespondiPayload(payload: unknown): payload is RespondiPayload {
  if (!isRecord(payload)) return false;
  const { form, respondent } = payload;
  return isRecord(form) && isRecord(respondent) && isRecord(respondent.answers);
}

/**
 * Um campo canônico por chave — cada um com a lista de textos de pergunta
 * conhecidos (mesmo padrão de `DEFAULT_FIELD_MAP` em inbound.ts: lista, não
 * string única, pra aceitar variante sem tocar código). Hoje só tem o texto
 * exato do form "Imobiliárias e Incorporadoras" (form_id 9FiY9mrO). Se a
 * Decola AÍ reusar este normalizador noutro form do Respondi com perguntas
 * reescritas, adicione a variante na lista — não crie um segundo arquivo.
 */
type RespondiField =
  | "name"
  | "phone"
  | "email"
  | "company_name"
  | "instagram_or_site"
  | "city_state"
  | "segment"
  | "role"
  | "monthly_revenue_range"
  | "current_marketing_structure"
  | "current_marketing_investment"
  | "viable_investment_range"
  | "commercial_challenge"
  | "start_timeline"
  | "consent";

const RESPONDI_QUESTION_ALIASES: Record<RespondiField, string[]> = {
  name: ["Qual é o seu nome?"],
  phone: ["Qual é o melhor WhatsApp para falarmos sobre essa análise?"],
  email: ["Qual é o seu melhor e-mail?"],
  company_name: ["Qual é o nome da sua empresa?"],
  instagram_or_site: ["Qual é o Instagram ou site da empresa?"],
  city_state: ["Em qual cidade e estado sua empresa atua?"],
  segment: ["Qual é o seguimento da sua empresa?", "Qual é o segmento da sua empresa?"],
  role: ["Qual é a sua função na empresa?"],
  monthly_revenue_range: ["Qual é o faturamento médio mensal da empresa?"],
  current_marketing_structure: ["Como sua empresa faz marketing e atendimento hoje?"],
  current_marketing_investment: ["Quanto sua empresa investe atualmente em marketing por mês?"],
  viable_investment_range: [
    "Considerando estratégia, tecnologia, atendimento e mídia, qual faixa de investimento seria viável para sua empresa crescer?",
  ],
  commercial_challenge: ["Hoje, qual é o principal desafio comercial da sua empresa?"],
  start_timeline: ["Quando você pretende começar a melhorar essa operação?"],
  consent: ["Autorização de contato"],
};

/** Campos que viram custom_fields diretamente (fora nome/telefone/email/consentimento, que têm destino próprio). */
const CUSTOM_FIELD_KEYS: Exclude<RespondiField, "name" | "phone" | "email" | "consent">[] = [
  "company_name",
  "instagram_or_site",
  "city_state",
  "segment",
  "role",
  "monthly_revenue_range",
  "current_marketing_structure",
  "current_marketing_investment",
  "viable_investment_range",
  "commercial_challenge",
  "start_timeline",
];

/**
 * O comentário deste módulo promete que pergunta sem alias é "NUNCA descartada".
 * Um corte cego em 60 caracteres descartava: duas perguntas longas com os mesmos
 * 60 primeiros caracteres do slug colidem no `Record`, e a última sobrescreve a
 * primeira — sem erro, sem log, sem nada na tela.
 *
 * Medido: divergindo no caractere 60 saem 2 chaves; no 61, sai 1. Hoje é
 * LATENTE — as 15 perguntas do formulário real têm alias em
 * `RESPONDI_QUESTION_ALIASES` e nenhuma chega aqui —, mas o dia em que alguém
 * acrescenta duas perguntas parecidas no Respondi é justamente o dia em que
 * este caminho passa a valer, e é para ele que a promessa foi escrita.
 *
 * O sufixo só aparece quando o título de fato excede o corte, então nenhuma
 * chave existente muda de nome. São 8 caracteres de um hash não-criptográfico
 * (FNV-1a) do título COMPLETO: não precisa resistir a adversário, precisa
 * distinguir dois títulos que compartilham prefixo.
 */
function slugifyQuestion(title: string): string {
  const base = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (base.length <= 60) return base;
  return `${base.slice(0, 60)}_${hashCurto(title)}`;
}

/** FNV-1a de 32 bits, em hex. Distinguir prefixo igual, não resistir a ataque. */
function hashCurto(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export type RespondiConsentSource = "legaltext" | "text_label" | "not_found";

export interface RespondiConsent {
  granted: boolean;
  rawAnswer: string | null;
  detectedVia: RespondiConsentSource;
}

const AFFIRMATIVE = /^(yes|true|sim|aceito|autorizo|concordo)\b/i;

/**
 * Consentimento: prioriza o SINAL ESTRUTURAL do Respondi (`question_type ===
 * "legaltext"` em `raw_answers`, valor booleano-ish "yes"/"no") sobre o texto
 * em português do rótulo da pergunta — o rótulo pode ser reescrito no editor
 * do form sem quebrar nada; o `question_type` não muda.
 *
 * Silêncio (campo ausente, resposta vazia, texto não reconhecido) NUNCA vira
 * concessão — a leitura padrão é recusa, porque autorizar contato automático
 * por engano é o lado caro do erro.
 */
function extractConsent(respondent: RespondiPayload["respondent"]): RespondiConsent {
  const rawAnswers = Array.isArray(respondent.raw_answers) ? respondent.raw_answers : [];
  const legaltext = rawAnswers.find(
    (r): r is RespondiRawAnswer =>
      isRecord(r) && isRecord(r.question) && r.question.question_type === "legaltext",
  );
  if (legaltext) {
    const raw = typeof legaltext.answer === "string" ? legaltext.answer : JSON.stringify(legaltext.answer);
    const granted = typeof legaltext.answer === "string" && AFFIRMATIVE.test(legaltext.answer.trim());
    return { granted, rawAnswer: raw, detectedVia: "legaltext" };
  }
  for (const alias of RESPONDI_QUESTION_ALIASES.consent) {
    const v = respondent.answers[alias];
    if (typeof v === "string" && v.trim()) {
      return { granted: AFFIRMATIVE.test(v.trim()), rawAnswer: v.trim(), detectedVia: "text_label" };
    }
  }
  return { granted: false, rawAnswer: null, detectedVia: "not_found" };
}

export interface RespondiMapped extends MappedLead {
  externalId: string | null;
  consent: RespondiConsent;
  companyName: string | null;
}

export function mapRespondiPayload(payload: RespondiPayload): RespondiMapped {
  const { respondent, form } = payload;
  const answers = respondent.answers;

  const pick = (field: RespondiField): string | null => {
    for (const alias of RESPONDI_QUESTION_ALIASES[field]) {
      const v = answers[alias];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  };

  const custom_fields: Record<string, string> = {};
  for (const field of CUSTOM_FIELD_KEYS) {
    const v = pick(field);
    if (v !== null) custom_fields[field] = v;
  }

  // Perguntas do form sem alias conhecido: NUNCA descartadas (diferente do
  // genérico) — entram sob uma chave derivada do próprio texto, pra
  // sobreviver a uma pergunta nova adicionada no Respondi sem exigir deploy
  // antes de captar. Nenhuma delas começa com "utm_" nos envios reais
  // observados (Respondi não manda UTM neste payload); se um dia mandar,
  // cai em source_metadata como o resto do produto espera.
  //
  // O mesmo vale para as chaves de ANÚNCIO (issue #3149): o Respondi não tem
  // campo nativo para o clique, então a pergunta do formulário vem com o rótulo
  // (`fbclid`, `gclid`…), e uma pergunta assim era gravada como campo do card —
  // o clique do anúncio sumia antes de chegar à atribuição do contato. Agora
  // ela segue a MESMA lista (`CHAVES_DE_ANUNCIO`) e o MESMO destino dos outros
  // caminhos: `source_metadata`.
  const matchedTitles = new Set(Object.values(RESPONDI_QUESTION_ALIASES).flat());
  const source_metadata: Record<string, string> = {};
  for (const [title, value] of Object.entries(answers)) {
    if (matchedTitles.has(title)) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    const chave = title.toLowerCase();
    if (chave.startsWith("utm_") || ehChaveDeAnuncio(chave)) {
      source_metadata[chave] = value.trim();
    } else {
      custom_fields[`respondi_q_${slugifyQuestion(title)}`] = value.trim();
    }
  }

  const consent = extractConsent(respondent);
  if (consent.rawAnswer) custom_fields.consent_raw_answer = consent.rawAnswer;
  custom_fields.consent_marketing_status = consent.granted ? "granted" : "declined";

  if (typeof respondent.score === "number") custom_fields.respondi_score = String(respondent.score);
  if (typeof respondent.status === "string") custom_fields.respondi_status = respondent.status;
  if (typeof form.form_id === "string") custom_fields.respondi_form_id = form.form_id;
  if (typeof form.form_name === "string") custom_fields.respondi_form_name = form.form_name;
  if (typeof respondent.respondent_id === "string") {
    custom_fields.respondi_respondent_id = respondent.respondent_id;
  }

  const externalId =
    typeof respondent.respondent_id === "string" && respondent.respondent_id.trim()
      ? `respondi:${respondent.respondent_id.trim()}`
      : null;

  return {
    name: pick("name"),
    phone: normalizePhoneBR(pick("phone")),
    email: pick("email"),
    custom_fields,
    source_metadata,
    externalId,
    consent,
    companyName: pick("company_name"),
  };
}

/** Título do card: empresa + contato — nunca um rótulo genérico fixo. */
export function respondiLeadTitle(mapped: RespondiMapped): string {
  if (mapped.companyName && mapped.name) return `${mapped.companyName} — ${mapped.name}`;
  return mapped.companyName ?? mapped.name ?? mapped.phone ?? mapped.email ?? "Lead sem nome";
}

/**
 * A forma completa que `contacts.consent` exige quando eu decido gravar
 * concessão — a coluna tem DEFAULT com as 3 chaves (marketing/transactional/
 * profiling); um INSERT que passa só `{marketing: {...}}` substitui o
 * default INTEIRO, não faz merge. `transactional`/`profiling` continuam
 * null: este webhook só capta consentimento de marketing/WhatsApp.
 *
 * Para a RECUSA existe `buildContactConsentDenial`, e a diferença entre as
 * duas não é estética — ver o cabeçalho dela.
 */
export function buildContactConsentGrant(formId: string | null): {
  marketing: { granted_at: string; source: string; version: string | null };
  transactional: { granted_at: null; source: null; version: null };
  profiling: { granted_at: null; source: null; version: null };
} {
  return {
    marketing: { granted_at: new Date().toISOString(), source: "webhook:respondi", version: formId },
    transactional: { granted_at: null, source: null, version: null },
    profiling: { granted_at: null, source: null, version: null },
  };
}

/**
 * A RECUSA, gravada como fato positivo — e este é o ponto inteiro.
 *
 * ─── Por que não bastava "não gravar nada" ──────────────────────────────────
 *
 * Bastava, enquanto ninguém precisasse LER a recusa. Não é mais o caso: as
 * ações de automação passaram a consultar o consentimento antes de mandar
 * mensagem (`lib/automation/guarda-do-contato.ts`), e aí o silêncio vira
 * ambiguidade — porque o DEFAULT da coluna `contacts.consent` **já é**
 * `{marketing: {granted_at: null, source: null, version: null}, …}`.
 *
 * Ou seja: TODO contato do produto nasce com exatamente a mesma forma que uma
 * recusa deixaria. "Nunca perguntamos" e "perguntamos e a pessoa disse não"
 * são indistinguíveis no banco de hoje — medido no `supabase/baseline.sql`, na
 * definição da coluna. Uma guarda que bloqueie por `granted_at` ausente
 * bloqueia os DOIS, e o segundo é a instalação inteira: fora deste formulário,
 * nada no produto concede consentimento (não há tela para isso).
 *
 * `declined_at` desfaz o empate. É a única chave que só existe quando alguém
 * respondeu NÃO, e é sobre ela que a guarda decide. Nenhuma migration: a
 * coluna é `jsonb`, a chave nova convive com o default e com qualquer linha
 * antiga — que continua significando "nunca perguntamos", que é a verdade.
 *
 * `granted_at` continua `null` de propósito, e junto: quem lê só o campo
 * antigo (o `deriveLgpdFromContact` do agent-engine, o relatório de
 * conformidade) continua lendo "não concedido", que também é verdade.
 */
export function buildContactConsentDenial(formId: string | null): {
  marketing: { granted_at: null; declined_at: string; source: string; version: string | null };
  transactional: { granted_at: null; source: null; version: null };
  profiling: { granted_at: null; source: null; version: null };
} {
  return {
    marketing: {
      granted_at: null,
      declined_at: new Date().toISOString(),
      source: "webhook:respondi",
      version: formId,
    },
    transactional: { granted_at: null, source: null, version: null },
    profiling: { granted_at: null, source: null, version: null },
  };
}
