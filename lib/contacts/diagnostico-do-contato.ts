/**
 * O DIAGNÓSTICO DA EMPRESA na ficha do contato: segmento, CNPJ, o que a equipe
 * (ou a IA) levantou e a oferta sugerida.
 *
 * ── Este arquivo é o ESQUEMA CENTRAL (anti-pattern 6 do CLAUDE.md) ────────────
 *
 * Os valores moram em `contacts.custom_fields`, sob as chaves de
 * `CHAVES_DO_DIAGNOSTICO`. Sem coluna nova pelo mesmo motivo dos `link_*`
 * (`lib/leads/links-de-contato.ts`): coluna exige migration e apêndice no
 * baseline, e o diagnóstico é um punhado de textos lidos e gravados JUNTO com a
 * ficha. Em troca, nenhuma tela, rota ou ferramenta lê esse jsonb pelo nome da
 * chave: todo mundo passa por `lerDiagnostico` (leitura tolerante) e
 * `aplicarDiagnostico` (escrita que devolve o objeto completo). Quem grava pelo
 * agente (a ferramenta do PR seguinte) usa `autoriaDoAgente`.
 *
 * ── Por que a leitura é tolerante e a escrita é por DIFERENÇA ────────────────
 *
 * `segmento` e `documento_cnpj` são nomes que uma organização pode já ter
 * criado como campo personalizado próprio, com outro tipo (uma lista de
 * opções, um número). A leitura recusa em silêncio o valor que não é do nosso
 * formato, e a tela mostra o campo vazio. Se a escrita regravasse TODAS as
 * chaves a partir do formulário, salvar sem tocar no segmento apagaria o valor
 * da organização. Por isso `aplicarDiagnostico` só toca na chave que a pessoa
 * MUDOU em relação ao que a tela leu; o resto do `custom_fields` volta byte a
 * byte como estava.
 *
 * ── Por que devolve o objeto COMPLETO ────────────────────────────────────────
 *
 * O `PATCH /api/v1/contacts/:id` SUBSTITUI `custom_fields` inteiro
 * (`app/api/v1/contacts/_handler.ts`, "SUBSTITUIÇÃO, não merge"). Mandar só o
 * diagnóstico apagaria os links e os campos da organização.
 *
 * ── LGPD ─────────────────────────────────────────────────────────────────────
 *
 * Tudo aqui é `custom_fields`, que o gatilho
 * `trg_contacts_anonimizado_limpa_custom_fields` zera por inteiro quando o
 * contato é anonimizado — pelos dois caminhos (cascata e rota direta). Cerca:
 * `tests/unit/diagnostico-do-contato-some-na-anonimizacao.test.ts` e o
 * invariante `tests/invariants/lgpd-alcanca-campos-personalizados-do-contato.test.ts`.
 */
import { z } from "zod";

import { ROLE_RANK, type Role } from "@/lib/auth/types";
import { formatCnpj, normalizeCnpj } from "@/lib/crm-b2b/normalize";
import { aplicarLinksAlterados, type LinksDoContato } from "@/lib/leads/links-de-contato";

export const CHAVES_DO_DIAGNOSTICO = {
  segmento: "segmento",
  cnpj: "documento_cnpj",
  resumo: "diag_resumo",
  oferta: "diag_oferta",
  observacoes: "diag_observacoes",
  por: "diag_por",
  em: "diag_em",
} as const;

/** Os campos de texto que a tela edita. Autoria e data não são digitadas. */
export const CAMPOS_DE_TEXTO = ["segmento", "cnpj", "resumo", "oferta", "observacoes"] as const;
export type CampoDeTexto = (typeof CAMPOS_DE_TEXTO)[number];

/**
 * Só o diagnóstico propriamente dito muda a AUTORIA. A observação é recado da
 * equipe: anotar ao lado de um texto da IA não o transforma em texto da equipe,
 * e o selo "escrito pela IA" continuaria verdadeiro.
 */
const CAMPOS_QUE_DEFINEM_A_AUTORIA: readonly CampoDeTexto[] = ["resumo", "oferta"];

export const TETO_DO_DIAGNOSTICO = {
  segmento: 120,
  cnpj: 18,
  resumo: 4000,
  oferta: 2000,
  observacoes: 4000,
} as const satisfies Record<CampoDeTexto, number>;

/** Quem escreveu o diagnóstico: `agente:<uuid>` ou `usuario:<uuid>`. */
export const TIPOS_DE_AUTOR = ["agente", "usuario"] as const;
export type TipoDeAutor = (typeof TIPOS_DE_AUTOR)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const autoriaSchema = z
  .string()
  .max(80)
  .refine((v) => {
    const [tipo, id, ...resto] = v.split(":");
    return (
      resto.length === 0 &&
      (TIPOS_DE_AUTOR as readonly string[]).includes(tipo ?? "") &&
      UUID.test(id ?? "")
    );
  });

function texto(teto: number) {
  return z
    .string()
    .transform((v) => v.trim())
    .pipe(z.string().min(1).max(teto));
}

/** CNPJ com ou sem máscara, numérico ou alfanumérico; guardado sem máscara. */
export const cnpjSchema = z
  .string()
  .max(TETO_DO_DIAGNOSTICO.cnpj)
  .transform((v, ctx) => {
    const normalizado = normalizeCnpj(v.trim());
    if (!normalizado) {
      ctx.addIssue({ code: "custom", message: "CNPJ inválido." });
      return z.NEVER;
    }
    return normalizado;
  });

/**
 * O formato de cada chave. É o que a leitura aceita e o que uma escrita por
 * outro caminho (a ferramenta do agente) precisa validar antes de gravar.
 */
export const diagnosticoSchema = z.object({
  segmento: texto(TETO_DO_DIAGNOSTICO.segmento).optional(),
  cnpj: cnpjSchema.optional(),
  resumo: texto(TETO_DO_DIAGNOSTICO.resumo).optional(),
  oferta: texto(TETO_DO_DIAGNOSTICO.oferta).optional(),
  observacoes: texto(TETO_DO_DIAGNOSTICO.observacoes).optional(),
  por: autoriaSchema.optional(),
  em: z.iso.datetime({ offset: true }).optional(),
});
export type Diagnostico = z.infer<typeof diagnosticoSchema>;

/** O que a tela edita: um texto por campo, vazio quando não há valor legível. */
export type TextosDoDiagnostico = Record<CampoDeTexto, string>;

/**
 * Lê o diagnóstico de um `custom_fields`. Nunca lança: cada chave é conferida
 * sozinha, e o valor fora do formato (de um campo homônimo da organização, ou
 * gravado à mão pela API) simplesmente não aparece.
 */
export function lerDiagnostico(
  customFields: Record<string, unknown> | null | undefined,
): Diagnostico {
  const saida: Diagnostico = {};
  const forma = diagnosticoSchema.shape;
  for (const campo of Object.keys(CHAVES_DO_DIAGNOSTICO) as (keyof typeof CHAVES_DO_DIAGNOSTICO)[]) {
    const bruto = customFields?.[CHAVES_DO_DIAGNOSTICO[campo]];
    if (bruto === undefined || bruto === null) continue;
    const lido = forma[campo].safeParse(bruto);
    if (lido.success && lido.data !== undefined) {
      (saida as Record<string, unknown>)[campo] = lido.data;
    }
  }
  return saida;
}

/** Os textos que o formulário começa mostrando. O CNPJ vem com máscara. */
export function textosDoDiagnostico(diagnostico: Diagnostico): TextosDoDiagnostico {
  return {
    segmento: diagnostico.segmento ?? "",
    cnpj: diagnostico.cnpj ? formatCnpj(diagnostico.cnpj) : "",
    resumo: diagnostico.resumo ?? "",
    oferta: diagnostico.oferta ?? "",
    observacoes: diagnostico.observacoes ?? "",
  };
}

/** O CNPJ digitado é recusado? Vazio não é erro: é "sem CNPJ". */
export function cnpjInvalido(valor: string): boolean {
  const limpo = valor.trim();
  return limpo !== "" && normalizeCnpj(limpo) === null;
}

/** O diagnóstico tem algum conteúdo para mostrar? */
export function diagnosticoVazio(diagnostico: Diagnostico): boolean {
  return CAMPOS_DE_TEXTO.every((campo) => !diagnostico[campo]);
}

export interface Autoria {
  tipo: TipoDeAutor;
  id: string;
}

export function autoriaDoDiagnostico(diagnostico: Diagnostico): Autoria | null {
  if (!diagnostico.por) return null;
  const [tipo, id] = diagnostico.por.split(":") as [TipoDeAutor, string];
  return { tipo, id };
}

/** O selo "Escrito pela IA": o diagnóstico foi gravado por um agente. */
export function escritoPelaIA(diagnostico: Diagnostico): boolean {
  return autoriaDoDiagnostico(diagnostico)?.tipo === "agente";
}

export function autoriaDoAgente(agentId: string): string {
  return `agente:${agentId}`;
}

export function autoriaDoUsuario(userId: string): string {
  return `usuario:${userId}`;
}

function valorParaGravar(campo: CampoDeTexto, textoDigitado: string): string | null {
  const limpo = textoDigitado.trim();
  if (!limpo) return null;
  if (campo === "cnpj") return normalizeCnpj(limpo);
  return limpo.slice(0, TETO_DO_DIAGNOSTICO[campo]);
}

/**
 * O `custom_fields` NOVO, para o PATCH que substitui o objeto inteiro.
 *
 * - Só a chave cujo texto MUDOU em relação a `inicial` é tocada; as outras,
 *   inclusive valores que a leitura não entendeu, ficam como estavam.
 * - Texto vazio apaga a chave (ausência, nunca string vazia).
 * - CNPJ inválido não é gravado: a chave fica como estava. Quem chama confere
 *   antes com `cnpjInvalido` e avisa a pessoa.
 * - Mudou o diagnóstico ou a oferta: a autoria passa a ser `autor` e a data,
 *   `agora`. Sem diagnóstico nem oferta, autoria e data saem junto.
 */
export function aplicarDiagnostico(
  customFields: Record<string, unknown> | null | undefined,
  inicial: TextosDoDiagnostico,
  editado: TextosDoDiagnostico,
  autor: string,
  agora: Date = new Date(),
): Record<string, unknown> {
  const saida: Record<string, unknown> = { ...(customFields ?? {}) };
  let mudouAutoria = false;

  for (const campo of CAMPOS_DE_TEXTO) {
    if (editado[campo].trim() === inicial[campo].trim()) continue;
    const chave = CHAVES_DO_DIAGNOSTICO[campo];
    if (campo === "cnpj" && cnpjInvalido(editado.cnpj)) continue;
    const valor = valorParaGravar(campo, editado[campo]);
    if (valor === null) delete saida[chave];
    else saida[chave] = valor;
    if (CAMPOS_QUE_DEFINEM_A_AUTORIA.includes(campo)) mudouAutoria = true;
  }

  if (mudouAutoria) {
    const temDiagnostico = CAMPOS_QUE_DEFINEM_A_AUTORIA.some(
      (campo) => typeof saida[CHAVES_DO_DIAGNOSTICO[campo]] === "string",
    );
    if (temDiagnostico) {
      saida[CHAVES_DO_DIAGNOSTICO.por] = autor;
      saida[CHAVES_DO_DIAGNOSTICO.em] = agora.toISOString();
    } else {
      delete saida[CHAVES_DO_DIAGNOSTICO.por];
      delete saida[CHAVES_DO_DIAGNOSTICO.em];
    }
  }
  return saida;
}

/**
 * O segmento com que o contato NASCE pela prospecção: a categoria do Google
 * Maps (ou da planilha). Só para contato novo — a ficha que já existe não é
 * tocada, pela mesma decisão dos links (spec 26 §7.1).
 *
 * `chavesDaOrganizacao` são as chaves dos campos de CONTATO que a organização
 * declarou nos funis (`defsDoPadraoDaOrg(..., "contato")`). Se uma delas é
 * `segmento`, o campo é DELA, com o tipo, as opções e o padrão que ela
 * escolheu: a categoria do Maps não entra. Sem isto, um campo `segmento` com
 * padrão (`^(Varejo|Serviços)$`) recusava a criação do contato com 422, e a
 * primeira mensagem da campanha não saía para ninguém.
 */
export function segmentoDoContatoNovo(
  categoria: string | null | undefined,
  chavesDaOrganizacao: Iterable<string> = [],
): Record<string, string> {
  for (const chave of chavesDaOrganizacao) {
    if (chave === CHAVES_DO_DIAGNOSTICO.segmento) return {};
  }
  // A categoria vem de terceiro e pode passar do teto: cortar é melhor que perder.
  const cortada = (categoria ?? "").trim().slice(0, TETO_DO_DIAGNOSTICO.segmento);
  const lido = diagnosticoSchema.shape.segmento.safeParse(cortada);
  return lido.success && lido.data ? { [CHAVES_DO_DIAGNOSTICO.segmento]: lido.data } : {};
}

/**
 * Quem EDITA a aba Diagnóstico; os demais só leem. Atendente (`agent`) ou
 * acima, fora do suporte só-leitura e com o contato não anonimizado — o mesmo
 * piso do `PATCH /api/v1/contacts/:id` (`requireRole("agent")`,
 * `requireSupportWrite`, 403 do anonimizado). A API é a cerca do dado; esta é
 * a da tela: sem ela, quem só lê veria o formulário e levaria 403 ao salvar.
 */
export function podeEditarDiagnostico(
  contato: { is_anonymized?: boolean | null },
  usuario: { support?: { access_mode?: string | null } | null },
  papel: string | null | undefined,
): boolean {
  if (contato.is_anonymized) return false;
  if (usuario.support?.access_mode === "support_readonly") return false;
  const rank = papel ? (ROLE_RANK[papel as Role] ?? 0) : 0;
  return rank >= ROLE_RANK.agent;
}

export interface EdicaoDaAba {
  inicial: TextosDoDiagnostico;
  editado: TextosDoDiagnostico;
  linksIniciais: LinksDoContato;
  linksEditados: LinksDoContato;
  autor: string;
  agora?: Date;
}

/**
 * O corpo do PATCH da aba: a DIFERENÇA entre o que a tela leu e o que a pessoa
 * deixou no formulário, aplicada sobre o `custom_fields` RELIDO na hora de
 * salvar (`relido`), e não sobre a cópia de quando a aba abriu.
 *
 * O PATCH substitui o objeto inteiro e não confere versão. Partir da cópia
 * antiga desfazia em silêncio o que outro caminho gravou nesse meio-tempo (o
 * "Completar fichas" da campanha, uma proposta de dado aprovada, o Editar
 * contato em outra aba). Relendo antes e tocando só nas chaves que a pessoa
 * mudou, o que ela não tocou fica como está no servidor. Na MESMA chave, vale
 * a gravação desta pessoa, a mais recente.
 *
 * O que isto NÃO fecha: entre a releitura e o PATCH sobra uma ida e volta à
 * API. Uma gravação que caia exatamente nesse intervalo ainda é desfeita.
 * Fechar de vez exige merge no servidor (uma função no molde de
 * `fn_lead_anotar_campos`) ou conferência de versão no PATCH.
 */
export function gravacaoDaAba(
  relido: Record<string, unknown> | null | undefined,
  edicao: EdicaoDaAba,
): Record<string, unknown> {
  const comLinks = aplicarLinksAlterados(relido, edicao.linksIniciais, edicao.linksEditados);
  return aplicarDiagnostico(comLinks, edicao.inicial, edicao.editado, edicao.autor, edicao.agora);
}
