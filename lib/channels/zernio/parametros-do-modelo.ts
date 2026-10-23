/**
 * OS VALORES DE UM MODELO, NO FORMATO QUE O PARCEIRO ACEITA.
 *
 * O envio de modelo pelo parceiro (`POST /v1/inbox/conversations`) não recebe o
 * `components[]` da plataforma: recebe três campos, cada um com uma regra.
 *
 *   - `templateParams` — UMA lista plana, na ordem: variáveis de texto do
 *     cabeçalho, depois as do corpo, depois um valor por botão de link dinâmico
 *     (na ordem dos botões). Vale para `{{1}}` e para `{{nome}}`: nos nomeados,
 *     os valores preenchem os nomes na ordem em que aparecem.
 *   - `headerMedia` — `{type, link}` para trocar a imagem/vídeo/documento do
 *     cabeçalho NESTE envio. Sem ele, o parceiro manda a mídia de exemplo que a
 *     plataforma aprovou.
 *   - `templateButtonParams` — `{index, subType, value}` para botão que leva valor
 *     próprio (cupom de copiar).
 *
 * Fonte: https://docs.zernio.com/messages/create-inbox-conversation (lida em
 * 15/10/2026). Até aqui o adapter mandava só as chaves numéricas do corpo: a
 * variável do cabeçalho, a imagem trocada e o sufixo do link do botão se
 * perdiam sem aviso, e um modelo NOMEADO saía sem nenhum valor.
 *
 * A ordem vem do CONTRATO (a definição aprovada), nunca da ordem das chaves do
 * objeto: com os nomeados não há número para ordenar, e ordem inventada manda o
 * valor certo para o lugar errado. Sem contrato (modelo que não está no
 * espelho), sobra a regra antiga — só as chaves numéricas, em ordem numérica.
 *
 * Puro e sem I/O.
 */
import { slotKey } from "@/lib/channels/meta/build-components";
import type { ParamSlot, TemplateContract } from "@/lib/channels/meta/template-contract";

export type MidiaDoCabecalho = { type: "image" | "video" | "document"; link: string };

export interface ParametrosDoParceiro {
  templateParams: string[];
  headerMedia?: MidiaDoCabecalho;
  templateButtonParams?: { index: number; subType: "url" | "copy_code"; value: string }[];
}

const MIDIA = new Set(["image", "video", "document"]);

function grupo(slot: ParamSlot): number {
  switch (slot.address.kind) {
    case "header":
      return 0;
    case "body":
      return 1;
    case "button":
      return 2;
    default:
      return 3;
  }
}

function indiceDoBotao(slot: ParamSlot): number {
  return slot.address.kind === "button" ? slot.address.index : 0;
}

export function parametrosDoParceiro(
  contrato: TemplateContract | null,
  values: Record<string, string>,
): ParametrosDoParceiro {
  if (contrato === null) {
    return {
      templateParams: Object.keys(values)
        .filter((k) => /^\d+$/.test(k))
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => values[k] ?? ""),
    };
  }

  // Ordem estável dentro do grupo: a do contrato, que é a ordem de aparição.
  const ordenados = contrato.slots
    .map((slot, posicao) => ({ slot, posicao }))
    .sort(
      (a, b) =>
        grupo(a.slot) - grupo(b.slot) ||
        indiceDoBotao(a.slot) - indiceDoBotao(b.slot) ||
        a.posicao - b.posicao,
    )
    .map((x) => x.slot);

  const templateParams: string[] = [];
  const templateButtonParams: NonNullable<ParametrosDoParceiro["templateButtonParams"]> = [];
  let headerMedia: MidiaDoCabecalho | undefined;

  for (const slot of ordenados) {
    // Carrossel tem campo próprio no parceiro (`templateCards`) e não entra aqui.
    if (slot.address.kind === "card") continue;
    const valor = (values[slotKey(slot.address, slot.key)] ?? "").trim();

    if (slot.address.kind === "header" && MIDIA.has(slot.expects)) {
      // Sem link, o parceiro usa a mídia de exemplo aprovada — não é erro.
      if (valor) headerMedia = { type: slot.expects as MidiaDoCabecalho["type"], link: valor };
      continue;
    }
    if (slot.address.kind === "button" && slot.expects === "coupon_code") {
      if (valor) templateButtonParams.push({ index: slot.address.index, subType: "copy_code", value: valor });
      continue;
    }
    // Texto do cabeçalho, do corpo e sufixo de link dinâmico: lista plana.
    templateParams.push(valor);
  }

  return {
    templateParams,
    ...(headerMedia ? { headerMedia } : {}),
    ...(templateButtonParams.length > 0 ? { templateButtonParams } : {}),
  };
}
