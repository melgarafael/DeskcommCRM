/**
 * AS VARIÁVEIS DE UM MODELO APROVADO, QUANDO QUEM ENVIA É UM FLUXO.
 *
 * ─── O buraco ───────────────────────────────────────────────────────────────
 *
 * O passo "modelo de mensagem" de um fluxo só mandava modelo SEM variável: o
 * motor não tinha de onde tirar o valor de `{{1}}` e recusava o passo. Para uma
 * loja, isso obrigava a um modelo por produto ("Recebemos seu pedido del
 * Cafeteira…", "…da Lavadora…") e a um ramo do fluxo por modelo — com dez produtos,
 * dez aprovações na plataforma e dez ramos. O dado que faltava já estava no
 * CRM: o nome do contato e os campos do negócio (o produto, o preço, a cidade
 * que o formulário mandou).
 *
 * ─── O contrato ─────────────────────────────────────────────────────────────
 *
 * O passo guarda, por variável (`slotKey`: `"1"`, `"2"` no corpo; `"header:1"`
 * no cabeçalho), DE ONDE sai o valor — nunca o valor. Quem resolve é o envio,
 * na hora de mandar: um passo que sai três horas depois usa o dado de agora.
 *
 * ─── O que não sai ──────────────────────────────────────────────────────────
 *
 * Variável sem origem configurada, ou cuja origem está vazia neste contato, NÃO
 * vira parâmetro em branco: o passo é recusado com o motivo, como já era com
 * qualquer variável. Mandar `Olá !` ou o marcador cru ao cliente é pior do que
 * não mandar. Variável que não é texto (imagem do cabeçalho, sufixo de link de
 * botão) também é recusada: contato e negócio não têm de onde tirar uma imagem.
 *
 * Puro e sem I/O: o editor, o motor e o worker importam daqui.
 */
import { z } from "zod";

import { slotKey } from "./build-components";
import type { ParamSlot, TemplateContract } from "./template-contract";

/** De onde sai o valor de UMA variável. */
export const fonteDeVariavelSchema = z.discriminatedUnion("kind", [
  /** O nome do contato como a tela mostra (nunca um identificador técnico). */
  z.strictObject({ kind: z.literal("contact_name") }),
  /** Só a primeira palavra do nome — "Olá Maria!" em vez de "Olá Maria José Pereira!". */
  z.strictObject({ kind: z.literal("contact_first_name") }),
  /** Um campo do negócio mais recente do contato (`crm_leads.custom_fields[key]`). */
  z.strictObject({
    kind: z.literal("lead_custom"),
    key: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z][a-z0-9_]*$/i, "Use letras, números e underscore"),
  }),
]);
export type FonteDeVariavel = z.infer<typeof fonteDeVariavelSchema>;

/** `slotKey` → fonte. Chave nunca é valor: o valor é resolvido na hora do envio. */
export const variaveisDoModeloSchema = z.record(z.string().min(1).max(40), fonteDeVariavelSchema);
export type VariaveisDoModelo = z.infer<typeof variaveisDoModeloSchema>;

/** O que o envio sabe do contato na hora de mandar. */
export interface DadosParaVariaveis {
  /** `nomeDoContato` — já sem identificador técnico; `null` quando não há nome. */
  nomeDoContato: string | null;
  /** `custom_fields` do negócio mais recente do contato. */
  camposDoNegocio: Record<string, unknown>;
}

/** Variável que um fluxo consegue preencher: texto, no corpo ou no cabeçalho. */
export function variavelPreenchivelPeloFluxo(slot: ParamSlot): boolean {
  return (
    slot.expects === "text" && (slot.address.kind === "body" || slot.address.kind === "header")
  );
}

/**
 * A plataforma recusa parâmetro com quebra de linha, tabulação ou mais de quatro
 * espaços seguidos — o valor vem do formulário de quem quer que seja.
 */
export function valorParaParametro(bruto: string): string {
  return bruto.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Nome de GENTE, para saudar. A tela aceita telefone formatado como rótulo do
 * contato (`nomeDoContato`), e a entrada por formulário grava o telefone no nome
 * quando o nome não veio — "Olá +5511987654321!" é pior que não mandar.
 */
function nomeParaSaudar(nome: string | null): string | null {
  return nome !== null && /\p{L}/u.test(nome) ? nome : null;
}

/** O valor bruto de uma origem para este contato — `null` quando ela está vazia. A campanha reusa. */
export function valorDaFonte(fonte: FonteDeVariavel, dados: DadosParaVariaveis): string | null {
  switch (fonte.kind) {
    case "contact_name":
      return nomeParaSaudar(dados.nomeDoContato);
    case "contact_first_name":
      return nomeParaSaudar(dados.nomeDoContato)?.trim().split(/\s+/)[0] ?? null;
    case "lead_custom": {
      const v = dados.camposDoNegocio[fonte.key];
      if (typeof v === "string") return v;
      if (typeof v === "number" && Number.isFinite(v)) return String(v);
      return null;
    }
  }
}

/** Para o motivo de recusa, que aparece na linha do tempo da inscrição. */
export function descreverFonte(fonte: FonteDeVariavel): string {
  switch (fonte.kind) {
    case "contact_name":
      return "nome do contato";
    case "contact_first_name":
      return "primeiro nome do contato";
    case "lead_custom":
      return `campo "${fonte.key}" do negócio`;
  }
}

function rotuloDaVariavel(slot: ParamSlot): string {
  return slot.address.kind === "header" ? `{{${slot.key}}} do cabeçalho` : `{{${slot.key}}}`;
}

export type ResolucaoDasVariaveis =
  { ok: true; values: Record<string, string> } | { ok: false; problemas: string[] };

/**
 * Os valores de TODAS as variáveis do contrato, ou a lista do que impede o envio.
 * Modelo sem variável devolve `{ ok: true, values: {} }` — o caso de sempre.
 */
export function resolverVariaveisDoModelo(
  contrato: TemplateContract,
  variaveis: VariaveisDoModelo | undefined,
  dados: DadosParaVariaveis,
): ResolucaoDasVariaveis {
  const values: Record<string, string> = {};
  const problemas: string[] = [];
  for (const slot of contrato.slots) {
    const rotulo = rotuloDaVariavel(slot);
    if (!variavelPreenchivelPeloFluxo(slot)) {
      problemas.push(`${rotulo} não é texto, e o fluxo só preenche texto`);
      continue;
    }
    const chave = slotKey(slot.address, slot.key);
    const fonte = variaveis?.[chave];
    if (!fonte) {
      problemas.push(`${rotulo} sem origem escolhida no passo`);
      continue;
    }
    const bruto = valorDaFonte(fonte, dados);
    const valor = bruto === null ? "" : valorParaParametro(bruto);
    if (!valor) {
      problemas.push(`${rotulo} vazio neste contato (${descreverFonte(fonte)})`);
      continue;
    }
    values[chave] = valor;
  }
  return problemas.length > 0 ? { ok: false, problemas } : { ok: true, values };
}
