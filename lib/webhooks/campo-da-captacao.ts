/**
 * Cadastrar, a partir de uma captação, um campo que o formulário mandou.
 *
 * O webhook grava tudo que o formulário manda em `custom_fields` do lead, pela
 * chave crua (`servico`). O que dá nome, tipo e lugar na tela a esse valor é a
 * DEFINIÇÃO em `crm_pipelines.settings.fields[]` (Configurações › Funis) — a mesma
 * fonte que o card do lead, o Kanban e as mensagens já leem. Este módulo só
 * decide COMO acrescentar uma definição a partir do que chegou; quem grava é a
 * server action `updatePipelineConfig`, que valida papel, organização e schema.
 *
 * Puro, sem I/O.
 */
import { customFieldSchema, type CustomFieldDef } from "@/lib/schemas/settings";

/**
 * Os tipos oferecidos na captação. `select` e `multiselect` ficam de fora de
 * propósito: pedem a lista de opções, e uma captação só sabe o valor escolhido,
 * não as alternativas. Quem quer lista fechada cadastra em Configurações › Funis.
 */
export const TIPOS_CADASTRAVEIS_DA_CAPTACAO = [
  "text",
  "textarea",
  "number",
  "date",
  "email",
  "phone",
  "url",
  "boolean",
] as const satisfies readonly CustomFieldDef["type"][];

export type TipoCadastravel = (typeof TIPOS_CADASTRAVEIS_DA_CAPTACAO)[number];

/** O mesmo limite de `pipelineConfigPatchSchema.fields`. */
export const MAX_CAMPOS_DO_FUNIL = 50;

/** A chave vira `key` da definição, e `customFieldSchema` só aceita isto. */
export function chaveCadastravel(chave: string): boolean {
  return customFieldSchema.shape.key.safeParse(chave).success;
}

/** `servico_desejado` → `Servico desejado`: ponto de partida, a pessoa corrige. */
export function rotuloSugerido(chave: string): string {
  const texto = chave.replace(/^_+/, "").replace(/[_-]+/g, " ").trim();
  return texto ? texto.charAt(0).toUpperCase() + texto.slice(1) : chave;
}

/** O tipo que o VALOR sugere. Só sugere: o formulário nunca declara tipo no webhook genérico. */
export function tipoSugerido(valor: unknown): TipoCadastravel {
  if (typeof valor === "boolean") return "boolean";
  if (typeof valor === "number") return "number";
  if (typeof valor !== "string") return "text";
  const v = valor.trim();
  if (v === "true" || v === "false") return "boolean";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "email";
  if (/^https?:\/\/\S+$/i.test(v)) return "url";
  if (/^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(v)) return "date";
  const digitos = v.replace(/\D/g, "");
  if (/^\+?[\d\s().-]+$/.test(v) && digitos.length >= 8) return "phone";
  if (/^-?\d+(?:[.,]\d+)?$/.test(v)) return "number";
  if (v.length > 80 || v.includes("\n")) return "textarea";
  return "text";
}

export type ResultadoDoNovoCampo =
  | { ok: true; fields: CustomFieldDef[] }
  | { ok: false; motivo: "chave_invalida" | "ja_cadastrado" | "limite" | "rotulo_vazio" };

/**
 * A lista que `updatePipelineConfig` deve gravar: as definições que já existiam,
 * na ordem, mais a nova no fim. `fields` é regravado INTEIRO pela server action,
 * então `atuais` precisa ser a leitura mais fresca possível.
 */
export function comNovoCampo(
  atuais: CustomFieldDef[],
  chave: string,
  rotulo: string,
  tipo: TipoCadastravel,
): ResultadoDoNovoCampo {
  if (!chaveCadastravel(chave)) return { ok: false, motivo: "chave_invalida" };
  const label = rotulo.trim().slice(0, 80);
  if (!label) return { ok: false, motivo: "rotulo_vazio" };
  if (atuais.some((c) => c.key === chave)) return { ok: false, motivo: "ja_cadastrado" };
  if (atuais.length >= MAX_CAMPOS_DO_FUNIL) return { ok: false, motivo: "limite" };
  return { ok: true, fields: [...atuais, { key: chave, label, type: tipo }] };
}
