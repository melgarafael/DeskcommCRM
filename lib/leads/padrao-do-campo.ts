/**
 * O PADRÃO DO CAMPO (#2730) — `padrao` (regex) + `mensagem_padrao`, a MESMA
 * régua nos TRÊS pontos que a issue pede: formulário, API e gravação pela IA.
 *
 * ─── Por que a conta é UMA ──────────────────────────────────────────────────
 *
 * Se cada porta fizer sua própria `new RegExp(...).test(...)`, elas divergem
 * no dia em que alguém decidir o que vale para valor em branco, para regex
 * quebrada ou para número. Aqui moram as decisões; lá fora só se chama:
 *
 *   - `components/contacts/CustomFieldsEditor` → mostra a MENSAGEM DO CAMPO;
 *   - `app/api/v1/contacts/_handler` e `app/api/v1/leads/_handler` → 422;
 *   - `lib/mcp/conferencia-de-campos` → o campo sai da escrita da IA e volta
 *     como erro de ensino, perguntando de novo ao cliente.
 *
 * ─── As quatro decisões, e por quê ──────────────────────────────────────────
 *
 *  1. **Sem `padrao`, nada muda.** Ausência é o campo livre de sempre, byte a
 *     byte — é o que torna a régua aditiva para toda base existente.
 *  2. **Valor em branco continua livre.** Obrigatoriedade é OUTRA régua
 *     (`obrigatorio_em`, #1536). Exigir formato num campo opcional faria o
 *     formulário obrigatoriamente preenchido sem ninguém ter pedido.
 *  3. **Regex inválida (ou em branco) FECHA.** `new RegExp("")` e um `^(`
 *     pela metade são exatamente o "aceita tudo silencioso" que a issue
 *     descarta: aqui eles viram `padrao_invalido`, com frase própria — o campo
 *     fica bloqueado até a correção, nunca aprovando qualquer coisa e nunca
 *     lançando em cima do form.
 *  4. **Não é texto, a porta fecha.** Objeto e lista não cumprem formato de
 *     texto; recusar é o único desfecho que não é "deixa passar porque não
 *     deu para testar".
 *
 * Quem quiser saber o que o USUÁRIO vê é `mensagemDaRecusa`: a `mensagem_padrao`
 * do campo (dado, traduzido pelo dono) quando existe, a frase genérica
 * (traduzida pelos três catálogos) quando não existe, e a de CONFIGURAÇÃO
 * quebrada quando o padrão nem compila.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";

/** O que uma definição de campo precisa ter para esta régua existir. */
export interface DefComPadrao {
  key: string;
  label?: string;
  type?: string;
  /** O regex do campo, como string — a grafia do `pipeline.settings.fields`. */
  padrao?: string;
  /** A frase que o DONO escreveu para quem digitar fora do formato. */
  mensagem_padrao?: string;
}

export type MotivoDoPadrao = "fora_do_padrao" | "padrao_invalido";

export type VereditoDoPadrao = { ok: true } | { ok: false; motivo: MotivoDoPadrao };

/** Quando o campo não tem `mensagem_padrao` — a chave é o texto, nos 3 catálogos. */
export const MENSAGEM_DE_FORA_DO_PADRAO = "Valor fora do formato esperado para este campo.";
/** Configuração quebrada: a frase fala do PADRÃO, não do valor digitado. */
export const MENSAGEM_DE_PADRAO_INVALIDO =
  "Padrão inválido configurado neste campo: a gravação está bloqueada até a correção.";

/** O texto com que a régua enxerga o valor. `null` = não é texto (fecha). */
function textoParaValidar(valor: unknown): string | null {
  if (typeof valor === "string") return valor;
  if (typeof valor === "number" || typeof valor === "boolean") return String(valor);
  return null;
}

/**
 * O veredito de UM campo contra UM valor. Nunca lança: regex quebrada vira
 * motivo, não exceção — quem chama é um form em render, uma rota e o turno da
 * IA, e nenhum dos três pode morrer por um `^(` pela metade na configuração.
 */
export function validaPadraoDoCampo(def: DefComPadrao, valor: unknown): VereditoDoPadrao {
  const bruto = def.padrao;
  // 1. Ausência é o campo livre de sempre.
  if (bruto === undefined || bruto === null) return { ok: true };
  // 3. Presente e inválido (não-string, em branco, regex quebrada) FECHA.
  if (typeof bruto !== "string" || bruto.trim() === "")
    return { ok: false, motivo: "padrao_invalido" };
  let re: RegExp;
  try {
    re = new RegExp(bruto);
  } catch {
    return { ok: false, motivo: "padrao_invalido" };
  }
  // 2. Sem valor não há formato a cumprir — obrigatoriedade é outra régua.
  if (valor === undefined || valor === null) return { ok: true };
  const texto = textoParaValidar(valor);
  // 4. Não é texto: formato de texto não se cumpre com estrutura.
  if (texto === null) return { ok: false, motivo: "fora_do_padrao" };
  if (texto.trim() === "") return { ok: true };
  return re.test(texto) ? { ok: true } : { ok: false, motivo: "fora_do_padrao" };
}

export interface RecusaDePadrao {
  /** A chave em `custom_fields`. */
  campo: string;
  /** O rótulo do campo; sem leitura, a própria chave. */
  rotulo: string;
  motivo: MotivoDoPadrao;
  /** A `mensagem_padrao` configurada, quando há — a frase que o usuário vê. */
  mensagemPadrao?: string;
}

/**
 * O lote: quais das chaves QUE ESTÃO SENDO ESCRITAS caem fora do padrão.
 *
 * Só se avalia o que a escrita traz — `custom_fields` de um PATCH carrega o
 * que mudou, e julgar o resto seria recusar valor que nem está sendo gravado.
 * Chave sem definição, ou definição sem `padrao`, passa: é o campo livre.
 *
 * Quando o MESMO campo tem padrão em mais de um funil (só acontece em
 * organização com mais de um, para a mesma chave), o valor tem de casar TODOS
 * — o contato é um só, e ele aparece nos dois funis.
 */
export function recusasDePadrao(
  defs: readonly DefComPadrao[],
  valores: Record<string, unknown> | undefined | null,
): RecusaDePadrao[] {
  if (!valores || defs.length === 0) return [];
  const porChave = new Map<string, DefComPadrao[]>();
  for (const def of defs) {
    const lista = porChave.get(def.key);
    if (lista) lista.push(def);
    else porChave.set(def.key, [def]);
  }
  const recusas: RecusaDePadrao[] = [];
  for (const [chave, valor] of Object.entries(valores)) {
    const candidatos = porChave.get(chave);
    if (!candidatos) continue;
    for (const def of candidatos) {
      const veredito = validaPadraoDoCampo(def, valor);
      if (veredito.ok) continue;
      recusas.push({
        campo: chave,
        rotulo: def.label ?? chave,
        motivo: veredito.motivo,
        ...(def.mensagem_padrao ? { mensagemPadrao: def.mensagem_padrao } : {}),
      });
      break;
    }
  }
  return recusas;
}

/** O tradutor de quem chama: `t()` na tela, `traduzir(…, idioma)` na API. */
export type TraduzMensagem = (texto: string) => string;

const semTraducao: TraduzMensagem = (texto) => texto;

/**
 * A frase que o usuário vê: a `mensagem_padrao` do CAMPO quando existe, a
 * genérica quando não existe, e a de CONFIGURAÇÃO quebrada quando o padrão nem
 * compila — esta nunca empresta a frase de formato, porque o problema ali não
 * é o valor digitado.
 */
export function mensagemDaRecusa(
  recusa: RecusaDePadrao,
  traduz: TraduzMensagem = semTraducao,
): string {
  const crua =
    recusa.motivo === "padrao_invalido"
      ? MENSAGEM_DE_PADRAO_INVALIDO
      : (recusa.mensagemPadrao ?? MENSAGEM_DE_FORA_DO_PADRAO);
  return traduz(crua);
}

/**
 * A mesma frase, direto de UM campo contra UM valor — é o que o formulário
 * pede (um campo por vez); a API e a IA trabalham em lote com `recusasDePadrao`.
 */
export function mensagemDoCampo(
  def: DefComPadrao,
  valor: unknown,
  traduz: TraduzMensagem = semTraducao,
): string | null {
  const veredito = validaPadraoDoCampo(def, valor);
  if (veredito.ok) return null;
  return mensagemDaRecusa(
    {
      campo: def.key,
      rotulo: def.label ?? def.key,
      motivo: veredito.motivo,
      ...(def.mensagem_padrao ? { mensagemPadrao: def.mensagem_padrao } : {}),
    },
    traduz,
  );
}

/** As definições de um `settings` de funil — `null` quando a leitura falhou. */
export function defsDoPadraoDoFunil(settings: unknown): DefComPadrao[] {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return [];
  return camposDoFunil(settings as Record<string, unknown>);
}

/**
 * As definições de TODOS os funis da organização, na ordem de criação.
 *
 * O CONTATO não tem funil próprio: a tela lê o funil padrão
 * (`useDefaultPipeline`) e o servidor, que não sabe qual é, pergunta a todos.
 * Falha de leitura devolve lista vazia — fail-open do resto da casa
 * (`settingsDoFunil` faz o mesmo): sem definição não há o que cobrar, e a
 * escrita segue como hoje em vez de a rota cair.
 */
export async function defsDoPadraoDaOrg(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<DefComPadrao[]> {
  try {
    const { data, error } = await supabase
      .from("crm_pipelines")
      .select("settings")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true });
    if (error || !Array.isArray(data)) return [];
    return (data as Array<{ settings?: unknown }>).flatMap((linha) =>
      defsDoPadraoDoFunil(linha?.settings),
    );
  } catch {
    return [];
  }
}

/**
 * A recusa virando o ERRO DA API: 422, código que nomeia a causa, e a frase
 * já traduzida para o idioma do contexto — a mesma chave do dicionário que a
 * tela usa, porque uma mensagem de erro trocada de idioma é meio erro.
 */
export function erroDePadrao(
  recusas: readonly RecusaDePadrao[],
  requestId: string,
  idioma: Idioma = "pt-BR",
): ApiError {
  const primeira = recusas[0];
  const codigo =
    primeira?.motivo === "padrao_invalido"
      ? "custom_field_pattern_invalid"
      : "custom_field_pattern_mismatch";
  const mensagem = traduzir(
    primeira ? mensagemDaRecusa(primeira) : MENSAGEM_DE_FORA_DO_PADRAO,
    idioma,
  );
  return new ApiError(
    422,
    codigo,
    { recusas: recusas.map((r) => ({ campo: r.campo, motivo: r.motivo })) },
    requestId,
    mensagem,
  );
}
