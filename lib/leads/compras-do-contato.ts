/**
 * "Últimas compras" do contato (issue #3179).
 *
 * Numa agência de viagens a pergunta mais comum do atendimento é "para onde esse
 * cliente já foi?" — e o produto não respondia: para saber o que um cliente já
 * comprou era preciso abrir o funil e procurar os negócios GANHOS dele. Esta é a
 * regra, pura e sem banco, que transforma os negócios do contato na lista que o
 * painel do Inbox e a ficha desenham.
 *
 * Três decisões que valem ficar escritas:
 *
 *  1. **Compra é negócio GANHO.** O gatilho `fn_crm_lead_close_on_stage` grava
 *     `status='won'` com `closed_at=now()` quando o negócio chega à etapa de
 *     ganho (`app/api/v1/leads/[id]/win/route.ts`, `lib/leads/stage-editing.ts`).
 *     Por isso o filtro é `status==='won'` e a data mostrada é `closed_at` — um
 *     negócio em andamento ou perdido NÃO é compra, e não entra.
 *  2. **Todos os funis.** A lista não filtra por funil: o cliente compra em mais
 *     de um, e a pergunta é sobre o cliente, não sobre o quadro onde ele estava.
 *     A ordenação é pela data do ganho, do mais recente para o mais antigo.
 *  3. **Os campos escolhidos vêm da organização** (`interface_settings.compras_campos`
 *     via `camposDeCompraDaInterface`), lidos dos campos personalizados do
 *     NEGÓCIO. Sem escolha salva, a linha volta ao padrão: só data, título e valor.
 */
import { camposDoFunil, camposPorEscopo, settingsDoEmbed } from "@/lib/leads/campos-do-funil";
import type { CustomFieldDef } from "@/lib/schemas/settings";

/** Um valor de campo personalizado, já legível para a tela. */
export interface CampoDaCompra {
  chave: string;
  rotulo: string;
  valor: string;
}

/** Uma compra — um negócio ganho do contato, como a seção o mostra. */
export interface CompraDoContato {
  id: string;
  pipeline_id: string;
  title: string;
  value_cents: number | null;
  currency: string | null;
  /** Quando o negócio foi ganho (`crm_leads.closed_at`). */
  closed_at: string;
  /** Os campos escolhidos pela organização; vazio = padrão (data, título, valor). */
  campos: CampoDaCompra[];
}

/** A linha crua do `crm_leads` (com o embed do funil) que a rota devolve. */
export interface LeadGanhoRow {
  id: string;
  pipeline_id: string;
  title: string;
  status: string;
  value_cents: number | null;
  currency: string | null;
  closed_at: string | null;
  custom_fields: Record<string, unknown> | null;
  crm_pipelines?: unknown;
}

/**
 * Só os negócios GANHOS, do mais recente para o mais antigo.
 *
 * A ordenação sai daqui e não do banco para a lista pelo servidor e a montada em
 * teste concordarem: `closed_at` nulo (negócio fechado antes do gatilho, ou por
 * caminho que não o gravou) cai no fim, nunca no topo por engano.
 */
export function somenteCompras(rows: readonly LeadGanhoRow[]): LeadGanhoRow[] {
  return rows
    .filter((row) => row.status === "won")
    .sort((a, b) => tempoDe(b.closed_at) - tempoDe(a.closed_at));
}

function tempoDe(iso: string | null): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * O valor do campo personalizado, em uma linha.
 *
 * Ausente vira `null` — quem monta a linha decide se mostra ou esconde, e ninguém
 * inventa travessão aqui. Listas (multiselect) entram separadas por vírgula.
 * Campo de opções (select/multiselect) grava o `value`; a tela mostra o `label`
 * da opção — valor sem opção correspondente (opção removida) segue cru.
 */
export function valorLegivel(
  valor: unknown,
  opcoes: CustomFieldDef["options"] = undefined,
): string | null {
  if (valor == null) return null;
  if (Array.isArray(valor)) {
    const partes = valor.map((v) => valorLegivel(v, opcoes)).filter((v): v is string => !!v);
    return partes.length > 0 ? partes.join(", ") : null;
  }
  if (typeof valor === "boolean") return valor ? "Sim" : "Não";
  if (typeof valor === "number") return String(valor);
  if (typeof valor === "string") {
    const texto = valor.trim();
    if (texto === "") return null;
    return opcoes?.find((opcao) => opcao.value === texto)?.label ?? texto;
  }
  return null;
}

/** As definições de campo do NEGÓCIO no funil, por chave. */
function definicoesDoFunil(embed: unknown): Map<string, CustomFieldDef> {
  const campos: CustomFieldDef[] = camposPorEscopo(camposDoFunil(settingsDoEmbed(embed)), "negocio");
  return new Map(campos.map((campo) => [campo.key, campo]));
}

/**
 * Os campos do NEGÓCIO declarados pelos funis, sem repetir a mesma chave.
 *
 * Recebe as LINHAS de `crm_pipelines` (com `.settings`), não o settings solto: é
 * a forma que a tela de Configurações › Empresa tem em mãos. É a lista que ela
 * oferece para escolher os 2 ou 3 campos da linha da compra — o MESMO leitor que
 * o Kanban usa —, e chave repetida em dois funis aparece uma vez só (a primeira
 * definição manda no rótulo).
 */
export function camposDoNegocioDosFunis(funis: readonly unknown[]): CustomFieldDef[] {
  const porChave = new Map<string, CustomFieldDef>();
  for (const funil of funis) {
    for (const campo of camposPorEscopo(camposDoFunil(settingsDoEmbed(funil)), "negocio")) {
      if (!porChave.has(campo.key)) porChave.set(campo.key, campo);
    }
  }
  return [...porChave.values()];
}

/**
 * Monta a lista da seção a partir das linhas ganhas e das chaves escolhidas.
 *
 * Campo escolhido SEM valor no negócio some da linha: um travessão ao lado de
 * destino e hospedagem leria como cadastro quebrado, não como "não foi
 * preenchido". O rótulo vem da definição do funil do negócio; chave sem
 * definição (campo removido do quadro) usa a própria chave como rótulo.
 */
export function montarCompras(
  rows: readonly LeadGanhoRow[],
  chavesEscolhidas: readonly string[] = [],
): CompraDoContato[] {
  const chaves = chavesEscolhidas.slice(0, 3);
  return somenteCompras(rows).map((row) => {
    const definicoes = definicoesDoFunil(row.crm_pipelines);
    const valores = row.custom_fields ?? {};
    const campos: CampoDaCompra[] = [];
    for (const chave of chaves) {
      const definicao = definicoes.get(chave);
      const valor = valorLegivel(valores[chave], definicao?.options);
      if (valor === null) continue;
      campos.push({ chave, rotulo: definicao?.label ?? chave, valor });
    }
    return {
      id: row.id,
      pipeline_id: row.pipeline_id,
      title: row.title,
      value_cents: row.value_cents,
      currency: row.currency,
      closed_at: row.closed_at ?? "",
      campos,
    };
  });
}
