/**
 * O RÓTULO DA OPÇÃO NO LUGAR DO CÓDIGO (#3605).
 *
 * ─── O defeito que este arquivo fecha ──────────────────────────────────────
 *
 * Um campo de LISTA (`select`, `multiselect`, `searchable_select`) grava no card
 * o `value` CANÔNICO da opção — `paris-franca`, e não "Paris (França)". É o
 * certo para filtrar e relatar: o `value` não muda de grafia. Mas o renderizador
 * de template devolvia esse valor CRU, e o cliente recebia "Sua viagem para
 * paris-franca está chegando". A reserva da variável (`{{destino|"a definir"}}`,
 * 1.94) não cobre isto: ela só entra quando o valor está VAZIO.
 *
 * ─── O que mora aqui ───────────────────────────────────────────────────────
 *
 * O mapa `chave do campo → opções` que o `renderTemplate` precisa para traduzir
 * valor em rótulo, e o carregador que o põe no `context` das automações. Não é
 * um segundo renderizador: quem troca a marcação continua sendo
 * `lib/automation/template.ts`, um só, para automação, resposta rápida e
 * follow-up.
 *
 * ─── AS TRÊS RÉGUAS (e por que são estas) ──────────────────────────────────
 *
 * 1. O SEPARADOR da múltipla escolha é `", "` — o MESMO que o domínio já usa em
 *    `valorLegivel` (lib/leads/compras-do-contato.ts) e no atalho
 *    `{{campo}}` de lista (`campoPersonalizadoDoLead`). Inventar outro (`" / "`,
 *    `"; "`) faria a mesma lista sair diferente na ficha e na mensagem.
 * 2. VALOR SEM RÓTULO SAI COMO O VALOR. Opção removida da lista depois de
 *    gravada no negócio é o caso real: apagar o trecho da frase é pior que
 *    mostrar o código, e inventar "—" mente sobre o dado.
 * 3. SEM AS DEFINIÇÕES, NADA MUDA. Contexto que não passou pelo carregador
 *    abaixo (integração antiga, teste isolado) segue renderizando o valor, byte
 *    a byte. Nenhuma mensagem que hoje sai certa passa a sair diferente.
 *
 * ─── A CHAVE NO CONTEXTO TEM HÍFEN, E ISSO É DE PROPÓSITO ──────────────────
 *
 * `MARCACAO` casa `{{[\w.]+}}` — letras, números, sublinhado e ponto. Uma chave
 * `camposDoFunil` seria alcançável por `{{camposDoFunil}}` e imprimiria
 * "[object Object]" na conversa do cliente. Com hífen, o mapa é dado INTERNO:
 * não existe token que o peça, e `resolveField` (condições de regra) também não
 * o alcança.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import type { CustomFieldDef } from "@/lib/schemas/settings";

/**
 * Onde o `context` carrega as definições do funil do negócio.
 *
 * Fora do alfabeto da marcação (`[\w.]`), então `{{campos-do-funil}}` não é um
 * token — ver o cabeçalho.
 */
export const CAMPOS_DO_FUNIL_NO_CONTEXTO = "campos-do-funil";

/**
 * O separador da múltipla escolha. `", "` porque é o que o domínio já usa:
 * `valorLegivel` (lib/leads/compras-do-contato.ts) e o join de
 * `campoPersonalizadoDoLead`.
 */
export const SEPARADOR_DAS_OPCOES = ", ";

/** Uma opção como a lista a guarda — o espelho de `customFieldSchema.options`. */
export interface OpcaoDaLista {
  value: string;
  label: string;
}

/**
 * Pendura no `context` as definições que têm LISTA (as únicas que precisam de
 * tradução). Campo de texto não entra: o mapa fica pequeno e o render não varre
 * o que não usa.
 */
export function anexarCamposDoFunil(
  context: Record<string, unknown>,
  campos: readonly CustomFieldDef[],
): void {
  const comLista = campos.filter((campo) => (campo.options?.length ?? 0) > 0);
  if (comLista.length > 0) context[CAMPOS_DO_FUNIL_NO_CONTEXTO] = comLista;
}

/** As opções declaradas para `chave`, ou `null` quando a chave não é lista. */
export function opcoesDoCampoNoContexto(
  context: Record<string, unknown>,
  chave: string,
): readonly OpcaoDaLista[] | null {
  const campos = context[CAMPOS_DO_FUNIL_NO_CONTEXTO];
  if (!Array.isArray(campos)) return null;
  for (const campo of campos) {
    if (!campo || typeof campo !== "object") continue;
    if ((campo as { key?: unknown }).key !== chave) continue;
    const opcoes = (campo as { options?: unknown }).options;
    if (!Array.isArray(opcoes) || opcoes.length === 0) return null;
    // Definição vinda de JSON cru pode trazer lixo: só entra o par string/string.
    const validas = opcoes.filter(
      (opcao): opcao is OpcaoDaLista =>
        !!opcao &&
        typeof opcao === "object" &&
        typeof (opcao as { value?: unknown }).value === "string" &&
        typeof (opcao as { label?: unknown }).label === "string",
    );
    return validas.length > 0 ? validas : null;
  }
  return null;
}

/**
 * O valor como o CLIENTE deve lê-lo: o rótulo da opção, quando existe.
 *
 * `valor` já resolvido do contexto (nunca a marcação). Lista vira os rótulos
 * unidos por `SEPARADOR_DAS_OPCOES`; item sem opção correspondente sai como o
 * próprio valor. Qualquer coisa que não seja lista (ou chave fora do mapa)
 * volta INTACTA — o render segue com o `String(valor)` de sempre.
 */
export function valorComRotulo(
  context: Record<string, unknown>,
  chave: string,
  valor: unknown,
): unknown {
  const opcoes = opcoesDoCampoNoContexto(context, chave);
  if (!opcoes) {
    // Sem definição (contexto não hidratado), a lista continua saindo legível:
    // era o join do `campoPersonalizadoDoLead` antes desta correção, e nenhuma
    // mensagem que já saía certa pode mudar por causa dela.
    return Array.isArray(valor) ? valor.join(SEPARADOR_DAS_OPCOES) : valor;
  }
  if (Array.isArray(valor)) {
    return valor.map((item) => rotuloDeUmValor(opcoes, item)).join(SEPARADOR_DAS_OPCOES);
  }
  if (typeof valor !== "string") return valor;
  return rotuloDeUmValor(opcoes, valor);
}

/** O rótulo da opção cujo `value` é exatamente `valor`; sem opção, o valor. */
function rotuloDeUmValor(opcoes: readonly OpcaoDaLista[], valor: unknown): string {
  const texto = typeof valor === "string" ? valor : String(valor ?? "");
  // Comparação EXATA: o card guarda o `value` canônico (`valorCanonico`,
  // lib/leads/campos-pesquisaveis.ts). Casar por aproximação aqui traduziria
  // valor que ninguém escolheu.
  return opcoes.find((opcao) => opcao.value === texto)?.label ?? texto;
}

/** O `pipeline_id` e o `custom_fields` que o `context.lead` precisa ter. */
interface LeadDoContexto {
  pipeline_id?: unknown;
  custom_fields?: unknown;
}

/**
 * Põe as definições do funil do negócio no `context` — o passo que falta entre
 * "o card guarda `paris-franca`" e "a mensagem diz Paris".
 *
 * Silencioso por desenho: sem negócio, sem `pipeline_id`, sem campo preenchido
 * ou com a leitura falhando, o `context` fica como estava e o render devolve o
 * valor — o comportamento de antes da correção. Um render que lança por causa
 * de uma leitura de APOIO deixaria a automação sem mandar a mensagem, que é
 * pior que mandar o código.
 */
export async function hidratarCamposDoFunil(
  context: Record<string, unknown>,
  admin: SupabaseClient,
  organizationId: string,
): Promise<void> {
  const lead = context.lead;
  if (!lead || typeof lead !== "object") return;
  const linha = lead as LeadDoContexto;

  const custom = linha.custom_fields;
  if (!custom || typeof custom !== "object" || Array.isArray(custom)) return;
  if (Object.keys(custom as Record<string, unknown>).length === 0) return;

  const pipelineId = typeof linha.pipeline_id === "string" ? linha.pipeline_id : null;
  if (!pipelineId) return;

  const { data } = await admin
    .from("crm_pipelines")
    .select("settings")
    .eq("organization_id", organizationId)
    .eq("id", pipelineId)
    .maybeSingle();

  const settings = (data as { settings?: Record<string, unknown> | null } | null)?.settings ?? null;
  anexarCamposDoFunil(context, camposDoFunil(settings));
}
