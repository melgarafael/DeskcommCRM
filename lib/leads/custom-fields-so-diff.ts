/**
 * Só as chaves de `custom_fields` que a pessoa realmente alterou (issue #2132).
 *
 * POR QUE ISTO EXISTE: a ficha do dossiê (`LeadFieldsForm`) e o painel do CRM na
 * inbox (`CRMSidePanel`) guardavam o objeto carregado ao abrir e reenviavam ele
 * INTEIRO a cada salvamento. O servidor soma o que chega com o que já está
 * gravado (`{ ...prev, ...input.custom_fields }` no PATCH), então quem salva por
 * último devolve ao valor velho tudo o que outra pessoa — ou o assistente (MCP
 * `crm_update_lead`) — mudou enquanto a ficha estava aberta. Sem erro nenhum:
 * o salvamento dá certo e o campo volta.
 *
 * Mandar só o DIFF fecha a janela sem mexer em contrato nenhum do lado de lá: o
 * merge continua sendo do servidor, e a chave que ninguém tocou simplesmente não
 * viaja.
 *
 * LIMPEZA NÃO PODE SER ENGOLIDA: apagar um valor preenchido chega como `""`
 * (texto, data, select) ou `null` (número) — os dois são VALOR, não ausência, e
 * entram no diff. `undefined`, que o JSON não carrega, vira `null` justamente
 * para a limpeza não sumir no caminho até o banco.
 *
 * Função pura de propósito: é ela que o teste unitário ensaia, e os dois
 * componentes são só quem a chama.
 */
export function soChavesAlteradas(
  carregado: Record<string, unknown> | null | undefined,
  atual: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const antes = carregado ?? {};
  const agora = atual ?? {};
  const saida: Record<string, unknown> = {};
  for (const chave of Object.keys(agora)) {
    const valor = agora[chave];
    if (igual(antes[chave], valor)) continue;
    // `undefined` não sobrevive ao JSON: sairia do payload sem nunca chegar.
    // `null` é o "sem valor" do jsonb — a limpeza chega.
    saida[chave] = valor === undefined ? null : valor;
  }
  return saida;
}

/** `null` e `undefined` são o mesmo estado aqui: "não preenchido". */
function ausente(v: unknown): boolean {
  return v === null || v === undefined;
}

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Igualdade profunda do que cabe num `custom_fields` (jsonb): escalares,
 * arrays (multiselect), objetos. Sem `JSON.stringify`: a ordem das CHAVES de um
 * objeto não é valor, e mandar de novo por causa da ordem seria reimportar o
 * defeito deste arquivo.
 */
function igual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (ausente(a) && ausente(b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => igual(item, b[i]));
  }
  if (ehObjeto(a) && ehObjeto(b)) {
    const chaves = Object.keys(a);
    if (chaves.length !== Object.keys(b).length) return false;
    return chaves.every((k) => k in b && igual(a[k], b[k]));
  }
  return false;
}
