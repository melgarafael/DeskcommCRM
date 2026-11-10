/**
 * O MOLDE DE IA DAS EMPRESAS NOVAS — a regra do que se copia, num lugar só.
 *
 * O dono da instalação escolhe UMA empresa como molde
 * (`platform_settings.molde_de_ia_org_id`, migration 9096) e toda empresa que
 * nascer depois disso recebe a mesma escolha de modelo por função. Quem COPIA é
 * o banco, num gatilho de `organizations`: é o único lugar que alcança todos os
 * caminhos de criação ao mesmo tempo — o cadastro (`lib/auth/provision.ts`),
 * Painel › Empresas › Nova, a RPC `fn_create_tenant_with_owner` e o
 * `bootstrap-owner`. Um passo em TypeScript num desses caminhos deixaria os
 * outros três nascendo sem o molde.
 *
 * Este arquivo é a MESMA regra do lado da tela: Recursos opcionais mostra,
 * antes de salvar, quantas funções e quais modelos vão ser copiados. As duas
 * metades têm de concordar, e quem cobra é
 * `tests/invariants/molde-de-ia-empresas-novas.test.ts` — grava no molde uma
 * função por provedor que o sistema conhece e exige que o banco copie
 * exatamente `PROVEDORES_DO_MOLDE`.
 *
 * ── O que se copia ──────────────────────────────────────────────────────────
 *
 * De cada linha de `ai_purpose_bindings` do molde: `purpose`, `provider`,
 * `model_id` e `is_enabled`, com `credential_id` NULO. Nulo quer dizer "use a
 * chave da instalação" (`lib/agent-engine/edge/llm/credentials.ts`), que é como
 * toda empresa nova começa: a chave do molde é dele, e copiar o ponteiro faria a
 * empresa nova gastar na conta de outra. E o padrão da organização
 * (`settings.llm` → `provider` + `default_model`), que vale em toda função sem
 * escolha explícita.
 *
 * ── O que NÃO se copia, e por quê ───────────────────────────────────────────
 *
 *  - linha com `base_url`: o endereço é o gateway próprio do molde, e sem a
 *    chave dele a empresa nova não fala com aquele endereço;
 *  - provedor sem chave da instalação (Google, DeepSeek, Requesty, o
 *    personalizado, a assinatura do ChatGPT, o Jev): com a credencial nula a
 *    função ficaria sem chave nenhuma e falharia na primeira chamada. A lista é
 *    de ENTRADA de propósito — provedor novo só passa a ser copiado quando
 *    alguém declarar que ele tem chave da instalação, que é o lado seguro;
 *  - credenciais, Jev (`settings.jev`), agentes e base de conhecimento: são da
 *    empresa, não da configuração de modelos.
 *
 * Sem `import` de banco nem de `@/lib/env`: o módulo é regra pura, importável
 * pela tela e pelos testes sem arrastar nada.
 */

/**
 * Os provedores que têm chave DA INSTALAÇÃO — os únicos em que uma função
 * copiada com credencial nula continua funcionando na empresa nova.
 *
 * É a mesma lista de `VARIAVEL_DA_CHAVE` em `lib/instalacao/ambiente.ts`
 * (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`); o par é
 * cobrado em `tests/unit/molde-de-ia.test.ts`. O gatilho do banco
 * (`fn_molde_de_ia_na_org_nova` e `fn_llm_do_molde_de_ia`) escreve os mesmos
 * três literais.
 */
export const PROVEDORES_DO_MOLDE = ["anthropic", "openai", "openrouter"] as const;

/** Uma linha de `ai_purpose_bindings` do molde, só com o que a regra lê. */
export interface FuncaoDoMolde {
  readonly purpose: string;
  readonly provider: string;
  readonly model_id: string;
  readonly base_url: string | null;
  readonly is_enabled: boolean;
}

/** O padrão da organização como vem de `settings.llm` — jsonb, então sem garantia de forma. */
export type LlmDoMolde = { readonly provider?: unknown; readonly default_model?: unknown } | null | undefined;

/** Uma empresa que pode servir de molde, como o seletor da tela a mostra. */
export interface EmpresaParaMolde {
  readonly id: string;
  readonly nome: string;
  /** `false` só para o molde em vigor que deixou de estar ativo — ele continua na lista para a tela dizer a verdade. */
  readonly ativa: boolean;
}

export interface PadraoDoMolde {
  readonly provider: string;
  readonly default_model: string;
}

function provedorDoMolde(provider: string): boolean {
  return (PROVEDORES_DO_MOLDE as readonly string[]).includes(provider);
}

/** A função vai para a empresa nova? Mesmo predicado do gatilho (`nullif(btrim(base_url), '') is null`). */
export function funcaoCopiavel(f: FuncaoDoMolde): boolean {
  return (f.base_url ?? "").trim() === "" && provedorDoMolde(f.provider);
}

/** O padrão que a empresa nova recebe do molde, ou `null` quando ela fica com o padrão do produto. */
export function padraoCopiavel(llm: LlmDoMolde): PadraoDoMolde | null {
  if (!llm || typeof llm.provider !== "string" || typeof llm.default_model !== "string") return null;
  if (llm.default_model.trim() === "" || !provedorDoMolde(llm.provider)) return null;
  return { provider: llm.provider, default_model: llm.default_model };
}

export interface ResumoDoMolde {
  /** Quantas funções a empresa nova recebe. */
  readonly funcoes: number;
  /** Quantas o molde tem e ficam de fora (endpoint próprio ou provedor sem chave da instalação). */
  readonly deixadas: number;
  /** Os pares provedor/modelo copiados, com quantas funções usam cada um — mais usados primeiro. */
  readonly modelos: readonly { readonly provider: string; readonly model_id: string; readonly funcoes: number }[];
  readonly padrao: PadraoDoMolde | null;
}

/** O que a tela mostra antes de salvar: o que a próxima empresa vai receber deste molde. */
export function resumirMolde(funcoes: readonly FuncaoDoMolde[], llm: LlmDoMolde): ResumoDoMolde {
  const copiadas = funcoes.filter(funcaoCopiavel);
  const porPar = new Map<string, { provider: string; model_id: string; funcoes: number }>();
  for (const f of copiadas) {
    const chave = `${f.provider}|${f.model_id}`;
    const atual = porPar.get(chave);
    if (atual) atual.funcoes += 1;
    else porPar.set(chave, { provider: f.provider, model_id: f.model_id, funcoes: 1 });
  }
  return {
    funcoes: copiadas.length,
    deixadas: funcoes.length - copiadas.length,
    modelos: [...porPar.values()].sort(
      (a, b) => b.funcoes - a.funcoes || a.provider.localeCompare(b.provider) || a.model_id.localeCompare(b.model_id),
    ),
    padrao: padraoCopiavel(llm),
  };
}
