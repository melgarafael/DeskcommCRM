/**
 * O LEAD DO FORMULÁRIO INSTANTÂNEO DA META — leitura PURA do que a Meta entrega.
 *
 * ═══ A FORMA DO PAYLOAD, E POR QUE A LEITURA É TÃO DESCONFIADA ═══
 *
 * O webhook do Lead Ads é um envelope de PÁGINA, o mesmo formato dos outros
 * webhooks da Meta (`object: "page"` → `entry[]` → `changes[]` → `value`). O que
 * interessa mora em `changes[].value`, e o filtro é `changes[].field ===
 * "leadgen"`: o mesmo endpoint recebe `feed`, `messages` e o que mais a página
 * assinar, e tratar tudo como lead faria a primeira mudança de contrato criar
 * contato em branco.
 *
 * `value.field_data[]` é a lista de RESPOSTAS do formulário, na forma
 * `{ name, values: [...] }` — o mesmo par que a API de recuperação de lead
 * devolve. Ela é a única fonte de nome, telefone e e-mail aqui: **esta fatia não
 * chama a Graph API**. Sem credencial real, a prova é por fixture, e a chamada
 * autenticada é a próxima fatia — por isso a ausência de `field_data` é um
 * desfecho NOMEADO (`sem_field_data`), e não um `undefined` que alguém depois
 * confunde com "a pessoa não preencheu nada".
 *
 * ─── Por que módulo puro, sem rede e sem banco ─────────────────────────────
 *
 * Porque é a única parte desta porta que pode ser provada com o payload real na
 * mão. A rota faz assinatura, tenant e escrita; o parser faz texto → dado. Um
 * parser que lesse o banco no meio não teria como ser testado contra o documento
 * da Meta, e é o documento que muda sem avisar.
 *
 * ─── O telefone sai NORMALIZADO, e isso é contrato ────────────────────────
 *
 * `normalizePhoneBR` é a mesma régua da ingestão de canal e da captação por
 * formulário (`lib/webhooks/inbound.ts` reexporta esta função): celular BR com o
 * nono dígito, E.164 com `+`, que é o que `contacts.phone_number` aceita
 * (`contacts_phone_e164_format`). Normalizar aqui — e não na rota — é o que faz
 * o reaproveitamento do contato ser por igualdade de forma, sem uma segunda
 * régua que divergiria na primeira mudança.
 *
 * Número que a régua não reconhece vira `null` e a resposta CRUA continua em
 * `respostas`/`campos`: perder o que a pessoa digitou seria pior que não casar
 * contato, e é do valor cru que quem depurar a fonte precisa.
 */
import { normalizePhoneBR } from "@/lib/channels/phone-variants";

/** Uma resposta do formulário, como a Meta manda: rótulo técnico + valores. */
interface CampoDoFormulario {
  name?: unknown;
  values?: unknown;
}

/** O `value` de um `changes[]` de leadgen, com o que a Meta documenta. */
interface ValorDoLeadgen {
  leadgen_id?: unknown;
  page_id?: unknown;
  form_id?: unknown;
  ad_id?: unknown;
  adgroup_id?: unknown;
  campaign_id?: unknown;
  created_time?: unknown;
  field_data?: unknown;
}

export interface RespostaDoFormulario {
  /** O `name` do campo — a chave estável que a Meta usa, não o rótulo da tela. */
  campo: string;
  valor: string;
}

export interface LeadDoFormulario {
  /** `leadgen_id`: a identidade da ENTREGA deste lead (idempotência por ele). */
  leadgenId: string;
  pageId: string | null;
  formId: string | null;
  adId: string | null;
  campaignId: string | null;
  /** `value.created_time`, em segundos (epoch) — quando a pessoa preencheu. */
  criadoEm: number | null;
  /** `entry[].time`, em segundos (epoch) — o instante do SINAL (janela da porta). */
  entradaEm: number | null;
  nome: string | null;
  /** E.164 canônico (`+55…`), ou `null` se a régua não reconheceu o número. */
  telefone: string | null;
  email: string | null;
  /** Todas as respostas, na ordem em que o formulário as trouxe. */
  respostas: RespostaDoFormulario[];
  /** As mesmas respostas em mapa, para `custom_fields` do negócio. */
  campos: Record<string, string>;
}

/** Por que um `changes[]` de leadgen não virou lead. Nunca é silêncio. */
export type MotivoDoDescarte = "sem_leadgen_id" | "sem_field_data";

export interface LeadDescartado {
  leadgenId: string | null;
  motivo: MotivoDoDescarte;
}

export type LeituraDoLeadAds =
  | { ok: false; motivo: "json_invalido" }
  | { ok: true; leads: LeadDoFormulario[]; descartados: LeadDescartado[] };

/**
 * Os nomes de campo que carregam a IDENTIDADE da pessoa.
 *
 * A lista é fechada e conhecida, como `CHAVES_DE_ANUNCIO` em
 * `lib/webhooks/inbound.ts`: um formulário pode ter uma pergunta chamada
 * "telefone do responsável", e adivinhar por prefixo entregaria ao cadastro o
 * número errado. O que não está aqui continua indo para as respostas do
 * formulário — que é onde o dado fica visível.
 *
 * Comparadas DEPOIS de `chaveCanonica`, então acento, caixa e espaço não
 * importam: o mesmo formulário chega como `Full Name`, `full_name` ou
 * `Nome Completo` conforme quem montou.
 */
const CAMPOS_DE_NOME = ["full_name", "nome_completo", "nome", "name"] as const;
const CAMPOS_DE_TELEFONE = [
  "phone_number",
  "telefone",
  "telefone_celular",
  "celular",
  "whatsapp",
  "phone",
] as const;
const CAMPOS_DE_EMAIL = ["email", "e_mail", "email_address", "correio_eletronico"] as const;

/**
 * Chave comparável: sem acento, sem caixa, sem espaço nem pontuação.
 *
 * `normalize("NFD")` + remoção de diacríticos é o que faz "E-mail" e "e_mail"
 * caírem na mesma chave — e é o mesmo tratamento que `lib/contacts` usa para
 * etiqueta e busca.
 */
function chaveCanonica(bruto: string): string {
  return bruto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() !== "" ? valor.trim() : null;
}

function segundos(valor: unknown): number | null {
  return typeof valor === "number" && Number.isFinite(valor) && valor > 0
    ? Math.trunc(valor)
    : null;
}

/**
 * Os valores de um campo, como texto.
 *
 * A Meta usa `values` como LISTA porque um campo de múltipla escolha devolve mais
 * de um valor. `values` com um item — o caso de nome, telefone e e-mail — vira o
 * item; com vários, vira a lista unida por `, `, que é o que o card do negócio
 * sabe mostrar. Devolver só o primeiro descartaria resposta de quem marcou duas
 * opções, e o produto já perde dado demais em silêncio.
 */
function valoresDoCampo(campo: CampoDoFormulario): string[] {
  const bruto = campo.values;
  if (!Array.isArray(bruto)) return [];
  const saida: string[] = [];
  for (const item of bruto) {
    const valor = texto(item);
    if (valor !== null) saida.push(valor);
  }
  return saida;
}

function campoDoFormulario(bruto: unknown): CampoDoFormulario | null {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return null;
  const nome = texto((bruto as CampoDoFormulario).name);
  const temValores = Array.isArray((bruto as CampoDoFormulario).values);
  return nome !== null && temValores ? (bruto as CampoDoFormulario) : null;
}

/** O primeiro campo cuja chave canônica casa com a lista — a ordem manda. */
function primeiroCampo(
  respostas: RespostaDoFormulario[],
  aliases: readonly string[],
): RespostaDoFormulario | null {
  for (const alias of aliases) {
    const achado = respostas.find((r) => r.campo === alias);
    if (achado) return achado;
  }
  return null;
}

/**
 * `first_name` + `last_name` — o par que a Meta usa quando o formulário pede os
 * dois em campos separados (é o padrão de formulário criado no Gerenciador).
 *
 * Fica como PLANO B: se o formulário tem `full_name`, ele é o nome que a pessoa
 * escreveu por inteiro, e é ele que a ficha mostra.
 */
function nomeEmDuasPartes(respostas: RespostaDoFormulario[]): string | null {
  const primeiro = primeiroCampo(respostas, ["first_name", "nome"]);
  const ultimo = primeiroCampo(respostas, ["last_name", "sobrenome"]);
  const partes = [primeiro?.valor, ultimo?.valor].filter((p): p is string => Boolean(p));
  return partes.length > 0 ? partes.join(" ") : null;
}

/**
 * Um `value` de leadgen vira lead — ou vira um DESCARTE nomeado.
 *
 * `entryTime` viaja junto porque a janela da porta (`lib/leads/lead-ads/
 * assinatura.ts`) mede a entrega pelo instante do SINAL, que mora no `entry`, e
 * não em `value` — duas entradas de uma mesma entrega podem chegar com horas
 * diferentes, e é o sinal que diz se esta entrega ainda vale.
 */
function leadDoValor(
  valor: ValorDoLeadgen,
  entryTime: number | null,
  pageIdDoEntry: string | null,
): LeadDoFormulario | LeadDescartado {
  const leadgenId = texto(valor.leadgen_id);
  if (leadgenId === null) return { leadgenId: null, motivo: "sem_leadgen_id" };

  // A resposta que não veio: a rota NÃO busca na Graph API nesta fatia, e um
  // lead criado só com o id seria um card em branco com nome de telefone.
  const brutos = Array.isArray(valor.field_data) ? valor.field_data : [];
  const respostas: RespostaDoFormulario[] = [];
  for (const bruto of brutos) {
    const campo = campoDoFormulario(bruto);
    if (!campo) continue;
    const chave = chaveCanonica(campo.name as string);
    if (chave === "") continue;
    const valores = valoresDoCampo(campo);
    if (valores.length === 0) continue;
    respostas.push({ campo: chave, valor: valores.join(", ") });
  }
  if (respostas.length === 0) return { leadgenId, motivo: "sem_field_data" };

  const doNome = primeiroCampo(respostas, CAMPOS_DE_NOME);
  const doTelefone = primeiroCampo(respostas, CAMPOS_DE_TELEFONE);
  const doEmail = primeiroCampo(respostas, CAMPOS_DE_EMAIL);

  // Identidade sai das respostas para o cadastro; o que sobra continua sendo
  // resposta do formulário e vai para `custom_fields`. A remoção é por CAMPO, e
  // não por posição: um formulário que mande o telefone duas vezes não pode
  // deixar a segunda cópia aparecendo como pergunta respondida.
  const consumidos = new Set(
    [doNome?.campo, doTelefone?.campo, doEmail?.campo].filter((c): c is string => Boolean(c)),
  );
  const campos: Record<string, string> = {};
  for (const resposta of respostas) {
    if (consumidos.has(resposta.campo)) continue;
    campos[resposta.campo] = resposta.valor;
  }

  const nome = (doNome?.valor ?? nomeEmDuasPartes(respostas))?.slice(0, 200) ?? null;
  const email = doEmail?.valor.slice(0, 320) ?? null;

  return {
    leadgenId,
    pageId: texto(valor.page_id) ?? pageIdDoEntry,
    formId: texto(valor.form_id),
    adId: texto(valor.ad_id),
    campaignId: texto(valor.campaign_id),
    criadoEm: segundos(valor.created_time),
    entradaEm: entryTime,
    nome: nome !== null && nome.trim() !== "" ? nome : null,
    // Sem número reconhecível o contato nasce sem telefone — o que NÃO pode
    // acontecer é o número cru entrar na coluna, que tem CHECK de E.164 e
    // derrubaria o INSERT inteiro.
    telefone: normalizePhoneBR(doTelefone?.valor),
    email: email !== null && email.trim() !== "" ? email : null,
    respostas,
    campos,
  };
}

/**
 * O corpo CRU de uma entrega → leads + descartes nomeados.
 *
 * Nunca lança: `for...of` sobre número lança, e a lição está escrita em
 * `lib/channels/meta/envelope.ts` (o cast que não confere nada em execução subia
 * até o framework e a Meta reentregava em backoff um corpo que nunca melhora).
 * JSON malformado também não é exceção: é `json_invalido`.
 */
export function lerLeadsDoFormularioMeta(corpo: string): LeituraDoLeadAds {
  let bruto: unknown;
  try {
    bruto = JSON.parse(corpo) as unknown;
  } catch {
    return { ok: false, motivo: "json_invalido" };
  }
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) {
    return { ok: false, motivo: "json_invalido" };
  }

  const entradas = (bruto as { entry?: unknown }).entry;
  if (!Array.isArray(entradas)) return { ok: true, leads: [], descartados: [] };

  const leads: LeadDoFormulario[] = [];
  const descartados: LeadDescartado[] = [];

  for (const entrada of entradas) {
    if (!entrada || typeof entrada !== "object" || Array.isArray(entrada)) continue;
    const pagina = entrada as { id?: unknown; time?: unknown; changes?: unknown };
    const pageId = texto(pagina.id);
    const entradaEm = segundos(pagina.time);
    const mudancas = pagina.changes;
    if (!Array.isArray(mudancas)) continue;

    for (const mudanca of mudancas) {
      if (!mudanca || typeof mudanca !== "object" || Array.isArray(mudanca)) continue;
      const { field, value } = mudanca as { field?: unknown; value?: unknown };
      // Só leadgen é assunto desta porta. `messages`, `feed` e `mention` chegam
      // no MESMO endpoint assinado, e um 400 por causa deles faria a Meta
      // reentregar para sempre um evento que não nos interessa.
      if (texto(field) !== "leadgen") continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;

      const lido = leadDoValor(value as ValorDoLeadgen, entradaEm, pageId);
      if ("motivo" in lido) descartados.push(lido);
      else leads.push(lido);
    }
  }

  return { ok: true, leads, descartados };
}
