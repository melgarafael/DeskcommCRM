/**
 * A PORTA QUE TODA ROTA DE VOZ ATRAVESSA ANTES DE FAZER QUALQUER COISA.
 *
 * ═══ POR QUE UMA FUNÇÃO, E NÃO UM `if` EM CADA ROTA ═══
 *
 * São seis rotas em `app/api/v1/voice/**` e cada uma teria de repetir a mesma
 * leitura e a mesma recusa. Repetição de gate é como se perde um: a sétima rota
 * nasce sem ele, ninguém percebe, e a organização que nunca ligou a feature
 * consegue chamar por uma porta lateral.
 *
 * ═══ ONDE ESTA FUNÇÃO É CHAMADA ═══
 *
 * Em toda rota que USA a chamada de voz: parear, iniciar/aceitar/rejeitar/
 * encerrar chamada, trocar SDP, ler histórico, e a ponte de eventos ao decidir
 * se processa o evento de uma organização.
 *
 * E em NENHUMA rota que a desliga. `DELETE /api/v1/voice/sessions` e o PUT de
 * `/api/v1/voice/opt-in` com `enabled:false` não passam por aqui de propósito:
 * exigir a feature ligada para conseguir desligá-la prenderia o aparelho
 * vinculado no dia em que a flag caísse por qualquer motivo. A porta de saída
 * nunca depende do interruptor.
 *
 * ═══ FALHA FECHADA ═══
 *
 * Erro de leitura vira recusa, não liberação. `lerCamadasDaOrg` (guardrails)
 * falha ABERTA porque lá a alternativa é um cliente sem resposta; aqui a
 * alternativa é vincular um aparelho a um número sem consentimento confirmado.
 * O custo de errar para cada lado é que decide, não a simetria entre os dois
 * arquivos.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { estadoDaVoz, instalacaoOfereceVoz, type EscolhaDeVoz } from "@/lib/voice/opt-in";

/**
 * Lê `org_voice_calls.enabled`. `null` = a organização nunca escolheu, e isso é
 * "desligado" (ver o cabeçalho da migration 0234).
 *
 * `throw` em erro de leitura em vez de `null`: os dois virariam recusa aqui,
 * mas só o `throw` distingue "não escolheu" de "não consegui perguntar" para
 * quem lê o log.
 */
export async function lerEscolhaDaOrg(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  organizationId: string,
): Promise<{ escolha: EscolhaDeVoz; riscoAceitoEm: string | null }> {
  const { data, error } = await supabase
    .from("org_voice_calls")
    .select("enabled, risco_aceito_em")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) throw new Error(`org_voice_calls read: ${error.message}`);

  const linha = data as { enabled: boolean; risco_aceito_em: string | null } | null;
  return { escolha: linha?.enabled ?? null, riscoAceitoEm: linha?.risco_aceito_em ?? null };
}

/**
 * `null` = pode seguir. Uma `Response` = a rota devolve isso e para.
 *
 * Os TRÊS códigos são distintos porque pedem ações diferentes de quem lê: 422
 * quando a organização não ligou (um admin dela resolve, na tela); 503
 * `voice_indisponivel_na_instalacao` quando a instalação não oferece o serviço
 * (só quem administra a VPS resolve, e nenhum clique adianta); 503
 * `voice_estado_indeterminado` quando a leitura não voltou. Colapsar num só
 * mandaria parte das pessoas para o lugar errado — e o terceiro é o pior de
 * colapsar, porque "não sei" disfarçado de "está desligada" faz procurar um
 * interruptor quando o problema é o banco.
 */
export async function exigirVozLigada(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  organizationId: string,
  /**
   * `instalacaoOferece` existe para não haver DUAS fontes do mesmo fato.
   *
   * As rotas que chamam esta guarda já resolveram `getWacallsClient()` e já
   * devolveram 503 quando ele é nulo — nesse ponto a instalação **comprovadamente**
   * oferece voz. Reler `env.WACALLS_API_BASE_URL` aqui seria perguntar de novo,
   * por um caminho diferente, e é assim que duas respostas divergem: um teste
   * que dubla o cliente e não dubla o env ganha um 503 de "instalação não
   * oferece" numa rota cujo cliente existe.
   *
   * O default continua sendo o env, para quem chamar sem saber.
   */
  opts: { requestId?: string; instalacaoOferece?: boolean } = {},
): Promise<Response | null> {
  let escolha: EscolhaDeVoz;
  try {
    ({ escolha } = await lerEscolhaDaOrg(supabase, organizationId));
  } catch {
    // FECHADO NA AÇÃO, mas com o código HONESTO. Devolver
    // `voice_desligada_na_organizacao` aqui faria a tela dizer "peça a um
    // administrador para ligar" — conselho errado, porque o que houve foi uma
    // leitura que não voltou. A ação é recusada do mesmo jeito; o que não pode
    // é a recusa AFIRMAR uma causa que ninguém mediu.
    return fail(
      "voice_estado_indeterminado",
      "Não foi possível confirmar se a chamada de voz está ligada nesta organização.",
      503,
      { requestId: opts.requestId },
    );
  }

  const estado = estadoDaVoz(
    escolha,
    opts.instalacaoOferece ?? instalacaoOfereceVoz(env.WACALLS_API_BASE_URL),
  );
  if (estado.ligada) return null;

  if (estado.motivo === "instalacao_nao_oferece") {
    return fail(
      "voice_indisponivel_na_instalacao",
      "A chamada de voz não está disponível neste servidor.",
      503,
      { requestId: opts.requestId },
    );
  }

  return fail(
    "voice_desligada_na_organizacao",
    "A chamada de voz está desligada nesta organização. Um administrador pode ligá-la em Configurações › Segurança.",
    422,
    { requestId: opts.requestId },
  );
}
