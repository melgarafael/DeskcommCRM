/**
 * Os planos que o cadastro público enxerga, e a regra de quando ele exige um.
 *
 * É o espelho, no servidor, de `fn_trial_na_criacao_da_org` (migration 0679):
 * sem plano escolhido, a empresa nasce no plano padrão; sem padrão, o gatilho
 * recusa com `plano_obrigatorio` — EXCETO quando o revendedor não tem plano
 * NENHUM (nem padrão, nem oferecido): aí a empresa nasce isenta, como antes da
 * 0679 (decisão do dono, doc 146, opção B). Os dois lados têm de usar o mesmo
 * critério: se a tela deixasse passar o que o gatilho recusa, a conta nasceria
 * no GoTrue sem organização.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { moduloLigado } from "@/lib/instalacao/modulos";

export interface PlanoDoCadastro {
  id: string;
  nome: string;
  preco_cents: number;
  /** A moeda do plano (migration 9332). */
  moeda: string;
  intervalo: string;
  trial_dias: number;
}

export interface PlanosDoCadastro {
  padraoId: string | null;
  oferecidos: PlanoDoCadastro[];
}

/** `null` quando a leitura falhou: quem decide uma AÇÃO trata como recusa. */
export async function lerPlanosDoCadastro(admin: SupabaseClient): Promise<PlanosDoCadastro | null> {
  const [oferecidos, padrao] = await Promise.all([
    admin
      .from("cobranca_planos")
      .select("id, nome, preco_cents, moeda, intervalo, trial_dias")
      .is("arquivado_em", null)
      .eq("oferecido_ao_cliente", true)
      .order("preco_cents"),
    admin
      .from("cobranca_planos")
      .select("id")
      .is("arquivado_em", null)
      .eq("padrao_no_cadastro", true)
      .maybeSingle(),
  ]);
  if (oferecidos.error || padrao.error) return null;
  return {
    padraoId: padrao.data?.id ?? null,
    oferecidos: oferecidos.data ?? [],
  };
}

/** Cadastro SEM plano escolhido é recusado? O mesmo critério do gatilho. */
export function cadastroExigeEscolhaDePlano(planos: PlanosDoCadastro): boolean {
  return planos.padraoId === null && planos.oferecidos.length > 0;
}

export interface CadastroNaTela {
  oferecidos: PlanoDoCadastro[];
  padraoId: string | null;
  /** O cadastro sem escolha seria recusado: o Google some e o seletor é obrigatório. */
  exigeEscolha: boolean;
}

/**
 * O que as telas de cadastro (`/signup`, `/get-started`) mostram. Cobrança
 * desligada, ou leitura que falha: nada — a tela não esconde nem exige coisa
 * alguma, e quem recusa é a action (e, por baixo dela, o gatilho).
 */
export async function lerCadastroNaTela(admin: SupabaseClient): Promise<CadastroNaTela> {
  const nada: CadastroNaTela = { oferecidos: [], padraoId: null, exigeEscolha: false };
  if (!(await moduloLigado(admin, "cobranca"))) return nada;
  const lidos = await lerPlanosDoCadastro(admin);
  if (!lidos) return nada;
  return { ...lidos, exigeEscolha: cadastroExigeEscolhaDePlano(lidos) };
}

/** O plano que o seletor já traz marcado: o padrão, quando ele está entre os oferecidos. */
export function planoInicialDoSeletor(oferecidos: readonly PlanoDoCadastro[], padraoId: string | null): string | undefined {
  return oferecidos.find((p) => p.id === padraoId)?.id ?? oferecidos[0]?.id;
}

/**
 * A moeda que o link do cadastro pede (migration 9332). Uma instalação que vende
 * em real, dólar e euro não mostra os três juntos: o site manda `?moeda=USD`, ou
 * um `?plano=` cuja moeda decide. Sem pedido válido, nada se filtra — é o
 * comportamento de sempre, e a instalação que só tem real não muda.
 *
 * Só ESCONDE da tela: quem decide se a escolha vale é a action (e o gatilho),
 * com a lista inteira. Pedido que esvaziaria a lista também não filtra.
 */
export function planosNaMoedaDoLink(
  oferecidos: readonly PlanoDoCadastro[],
  link: { moeda?: string | string[]; plano?: string | string[] },
): PlanoDoCadastro[] {
  const primeiro = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const pedida = primeiro(link.moeda)?.trim().toUpperCase();
  const doPlano = oferecidos.find((p) => p.id === primeiro(link.plano))?.moeda;
  const moeda = pedida && oferecidos.some((p) => p.moeda === pedida) ? pedida : doPlano;
  if (!moeda) return [...oferecidos];
  return oferecidos.filter((p) => p.moeda === moeda);
}
