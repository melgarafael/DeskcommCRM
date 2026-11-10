import type { CustomFieldDef } from "@/lib/schemas/settings";

/**
 * O RÓTULO de cada tipo de campo personalizado — FONTE ÚNICA (issue #3095).
 *
 * O mesmo tipo aparecia com dois nomes: a captação por webhook dizia "Texto",
 * "Link" e "Sim/Não", e os Funis diziam "Texto curto", "Link (URL)" e
 * "Sim ou não". Quem cadastrava pela captação e depois abria o campo em
 * Configurações › Funis tinha a impressão de serem dois tipos diferentes.
 *
 * O `type` gravado continua sendo o NOME TÉCNICO (`text`, `multiselect`,
 * `searchable_select`…) — é o que o schema e a API leem. O que muda é só o que
 * a pessoa lê, e agora as duas telas leem daqui.
 *
 * `Record<CustomFieldDef["type"], string>` de propósito: tipo novo no schema sem
 * rótulo aqui passa a reprovar no typecheck, em vez de voltar cru à tela. Onde o
 * rótulo já é chave do dicionário, a MESMA chave é reutilizada — nada de entrada
 * duplicada.
 */
export const ROTULOS_DO_TIPO: Record<CustomFieldDef["type"], string> = {
  text: "Texto curto",
  textarea: "Texto longo",
  number: "Número",
  currency: "Moeda (BRL)",
  date: "Data",
  select: "Lista de uma escolha",
  multiselect: "Lista de várias escolhas",
  searchable_select: "Lista pesquisável",
  boolean: "Sim ou não",
  email: "E-mail",
  phone: "Telefone",
  url: "Link (URL)",
  file: "Arquivo",
};

/**
 * O rótulo já traduzido, para as telas.
 *
 * Recebe o `t()` de fora para o mapa continuar puro (sem hook) e para o teste
 * provar que a MESMA chave chega ao dicionário nas duas telas.
 *
 * `moeda` é a da organização (`organizations.currency`): o campo de moeda
 * escreve e lê o valor nela (`lib/leads/campo-de-moeda.ts`), e o tipo diz qual é
 * — « Moeda (EUR) » numa empresa em euro. Sem ela, o rótulo de antes.
 */
export function rotuloDoTipo(tipo: CustomFieldDef["type"], t: (texto: string) => string, moeda?: string): string {
  if (tipo === "currency" && moeda) return `${t("Moeda")} (${moeda})`;
  return t(ROTULOS_DO_TIPO[tipo]);
}
