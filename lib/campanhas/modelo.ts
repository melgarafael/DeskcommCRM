/**
 * CAMPANHA COM MODELO APROVADO — de onde sai cada variável, e o valor de cada
 * contato (issue #1330, fatia 4; migration 0710).
 *
 * ─── Por que existe ─────────────────────────────────────────────────────────
 *
 * Número oficial só aceita texto livre para quem escreveu nas últimas 24 horas,
 * e campanha fala com quem não escreveu. O corpo da campanha oficial é um modelo
 * aprovado, e a campanha guarda, por variável (`slotKey`: `"1"` no corpo,
 * `"header:1"` no cabeçalho, `"button0:1"` no link do botão), DE ONDE sai o
 * valor — nunca o valor. A preparação resolve contato a contato e congela o
 * resultado no destinatário (`campaign_recipients.variables.modelo`), como o
 * texto livre congela `rendered_body`.
 *
 * ─── A mesma régua do fluxo de follow-up ────────────────────────────────────
 *
 * As origens são as de `lib/channels/meta/variaveis-do-fluxo.ts` (nome, primeiro
 * nome, campo do negócio mais recente) mais uma que só a campanha precisa:
 * TEXTO FIXO — o mesmo para todos ("20% de desconto", o link da imagem do
 * cabeçalho, o sufixo do link do botão). Variável vazia neste contato não vira
 * parâmetro em branco: a pessoa sai da lista com `variavel_ausente`, como no
 * texto livre. Mandar "Olá !" é pior do que não mandar.
 *
 * Puro e sem I/O: a tela, a rota e a preparação importam daqui.
 */
import { z } from "zod";

import { slotKey } from "@/lib/channels/meta/build-components";
import { renderTemplateBody } from "@/lib/channels/meta/render-template";
import type { ParamSlot, TemplateContract } from "@/lib/channels/meta/template-contract";
import {
  descreverFonte,
  fonteDeVariavelSchema,
  valorDaFonte as valorDaFonteDoFluxo,
  valorParaParametro,
  type DadosParaVariaveis,
} from "@/lib/channels/meta/variaveis-do-fluxo";

/** Texto fixo, igual para todos os destinatários. */
const fonteFixaSchema = z.strictObject({
  kind: z.literal("fixed"),
  value: z.string().trim().min(1, "Escreva o texto fixo").max(1000),
});

export const fonteDaCampanhaSchema = z.discriminatedUnion("kind", [
  ...fonteDeVariavelSchema.options,
  fonteFixaSchema,
]);
export type FonteDaCampanha = z.infer<typeof fonteDaCampanhaSchema>;

/** `slotKey` → origem. Chave nunca é valor. */
export const variaveisDaCampanhaSchema = z.record(z.string().min(1).max(40), fonteDaCampanhaSchema);
export type VariaveisDaCampanha = z.infer<typeof variaveisDaCampanhaSchema>;

const MIDIA = new Set(["image", "video", "document"]);

/** O tipo de valor que a variável espera, do ponto de vista de quem escolhe a origem. */
export type TipoDaVariavel = "texto" | "midia" | "sufixo_de_link" | "cupom" | "nao_suportada";

export function tipoDaVariavel(slot: ParamSlot): TipoDaVariavel {
  if (slot.address.kind === "card") return "nao_suportada";
  if (MIDIA.has(slot.expects)) return "midia";
  if (slot.expects === "url_suffix") return "sufixo_de_link";
  if (slot.expects === "coupon_code") return "cupom";
  if (slot.expects === "text") return "texto";
  // Moeda e data/hora: a plataforma pede objeto próprio, e nem contato nem
  // negócio têm de onde tirar um.
  return "nao_suportada";
}

/** As origens que fazem sentido para a variável — a tela só oferece estas. */
export function origensPermitidas(slot: ParamSlot): FonteDaCampanha["kind"][] {
  switch (tipoDaVariavel(slot)) {
    case "texto":
      return ["contact_first_name", "contact_name", "lead_custom", "fixed"];
    case "sufixo_de_link":
    case "cupom":
      return ["lead_custom", "fixed"];
    case "midia":
      return ["fixed"];
    case "nao_suportada":
      return [];
  }
}

function ehLinkPublico(valor: string): boolean {
  try {
    const u = new URL(valor);
    return u.protocol === "https:" && u.hostname.length > 0;
  } catch {
    return false;
  }
}

/** Como a variável aparece numa frase para quem opera: `{{1}}`, `{{1}} do cabeçalho`… */
export function rotuloDaVariavel(slot: ParamSlot): string {
  switch (slot.address.kind) {
    case "header":
      return MIDIA.has(slot.expects) ? "a mídia do cabeçalho" : `{{${slot.key}}} do cabeçalho`;
    case "button":
      return `{{${slot.key}}} do botão ${slot.address.index + 1}`;
    case "card":
      return `{{${slot.key}}} do cartão ${slot.address.cardIndex + 1}`;
    default:
      return `{{${slot.key}}}`;
  }
}

/**
 * O que impede SALVAR o mapa — conferido antes de qualquer contato: variável sem
 * origem, origem que não serve para o tipo, texto fixo de mídia que não é link
 * público. Vazio = o mapa serve.
 */
export function problemasDoMapa(contrato: TemplateContract, variaveis: VariaveisDaCampanha): string[] {
  const problemas: string[] = [];
  for (const slot of contrato.slots) {
    const rotulo = rotuloDaVariavel(slot);
    const permitidas = origensPermitidas(slot);
    if (permitidas.length === 0) {
      problemas.push(`${rotulo}: este tipo de variável ainda não pode ser preenchido por campanha`);
      continue;
    }
    const fonte = variaveis[slotKey(slot.address, slot.key)];
    if (!fonte) {
      problemas.push(`${rotulo}: escolha de onde sai o valor`);
      continue;
    }
    if (!permitidas.includes(fonte.kind)) {
      problemas.push(`${rotulo}: esta origem não serve para este tipo de variável`);
      continue;
    }
    if (tipoDaVariavel(slot) === "midia" && fonte.kind === "fixed" && !ehLinkPublico(fonte.value)) {
      problemas.push(`${rotulo}: use um link público que comece com https://`);
    }
  }
  return problemas;
}

function valorDaFonte(fonte: FonteDaCampanha, dados: DadosParaVariaveis): string | null {
  // As outras três são exatamente as do fluxo — mesma regra de nome de gente.
  return fonte.kind === "fixed" ? fonte.value : valorDaFonteDoFluxo(fonte, dados);
}

function descrever(fonte: FonteDaCampanha): string {
  return fonte.kind === "fixed" ? "texto fixo" : descreverFonte(fonte);
}

export type ResolucaoDaCampanha =
  | { ok: true; values: Record<string, string> }
  | { ok: false; problemas: string[] };

/**
 * Os valores de TODAS as variáveis para ESTE contato, ou o que impede o envio.
 * Modelo sem variável devolve `{ ok: true, values: {} }`.
 */
export function resolverValoresDaCampanha(
  contrato: TemplateContract,
  variaveis: VariaveisDaCampanha,
  dados: DadosParaVariaveis,
): ResolucaoDaCampanha {
  const values: Record<string, string> = {};
  const problemas: string[] = [];
  for (const slot of contrato.slots) {
    const rotulo = rotuloDaVariavel(slot);
    const chave = slotKey(slot.address, slot.key);
    const fonte = variaveis[chave];
    if (!fonte || !origensPermitidas(slot).includes(fonte.kind)) {
      problemas.push(`${rotulo} sem origem válida`);
      continue;
    }
    const bruto = valorDaFonte(fonte, dados);
    // Mídia é link: não passa pela limpeza de espaços (que cortaria em 200).
    const valor =
      bruto === null ? "" : tipoDaVariavel(slot) === "midia" ? bruto.trim() : valorParaParametro(bruto);
    if (!valor) {
      problemas.push(`${rotulo} vazio neste contato (${descrever(fonte)})`);
      continue;
    }
    values[chave] = valor;
  }
  return problemas.length > 0 ? { ok: false, problemas } : { ok: true, values };
}

/** As chaves de campo do negócio que o mapa lê — a consulta só puxa `custom_fields` quando há alguma. */
export function camposDoNegocioUsados(variaveis: VariaveisDaCampanha): string[] {
  return [
    ...new Set(
      Object.values(variaveis)
        .filter((f): f is Extract<FonteDaCampanha, { kind: "lead_custom" }> => f.kind === "lead_custom")
        .map((f) => f.key),
    ),
  ];
}

/**
 * O texto que fica na conversa: cabeçalho + corpo com os valores DESTE contato.
 * É o que o agente lê no histórico quando o cliente responde — o marcador cru
 * (`{{1}}`) faria ele responder sem saber o que foi oferecido.
 */
export function textoDoModeloParaAConversa(
  definicao: { name: string; language: string; parameterFormat?: string | null; components: unknown },
  values: Record<string, string>,
): string {
  return renderTemplateBody(definicao.components, values, {
    name: definicao.name,
    language: definicao.language,
    ...(definicao.parameterFormat ? { parameterFormat: definicao.parameterFormat } : {}),
  });
}

/** O que muda no pedido de envio entre texto livre e modelo — o resto é igual. */
export type ConteudoDoEnvio =
  | { type: "text"; body: string }
  | {
      type: "template";
      body: string;
      template_name: string;
      template_language: string;
      template_values: Record<string, string>;
    };
