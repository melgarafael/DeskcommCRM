/**
 * O TRADUTOR ÚNICO DO ERRO DE BANCO PARA A FRASE DO OPERADOR (#3747).
 *
 * ─── O defeito que este arquivo fecha ────────────────────────────────────────
 *
 * As telas de `/admin` (e as irmãs com `loadAuthUser`) faziam
 * `return { ok: false, error: error.message }`: o texto do Postgres ia inteiro
 * para o toast. Não é linguagem de operador — já rendeu relato de suporte com
 * `new row for relation "platform_branding" violates check constraint
 * "platform_branding_accent_hex"`, que nomeia constraint, relação e coluna para
 * quem só queria salvar uma cor. É a mesma classe que a #2804 fechou em
 * `lib/email/config.ts` (o `saveSmtpConfig`), e o desenho é o mesmo: o cru vai
 * para o `logger.error`, onde alguém consegue agir sobre ele; a tela recebe a
 * frase do campo.
 *
 * ─── Por que um mapeador ÚNICO, e não uma frase por action ──────────────────
 *
 * Doze actions com doze `if (error) return …` é exatamente como o vazamento
 * voltou três vezes. Aqui o caminho é um só:
 *
 *   if (error) return respostaParaOperador(error, { contexto: "…", idioma });
 *
 * e o que decide a frase é o CÓDIGO (`23514`) e a CONSTRAINT
 * (`platform_branding_accent_hex`), nunca o texto — texto do Postgres muda com
 * a versão do servidor e com o idioma do `lc_messages`.
 *
 * ─── A frase genérica mora no DICIONÁRIO, não aqui ──────────────────────────
 *
 * `FRASES` são CHAVES de `lib/i18n/dicionario.ts` — a chave é o próprio texto
 * em português, e `traduzir()` resolve o espanhol. Texto solto numa action não
 * passa por tradutor nenhum: ficaria em português numa instalação em espanhol e
 * fora do alcance das cercas de i18n. O teste vizinho
 * (`tests/unit/erros-para-operador.test.ts`) cobra `es` para toda frase daqui,
 * então frase nova sem tradução reprova.
 */
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";

/**
 * O pedaço de erro do Supabase/Postgrest que este mapeador lê.
 *
 * Todos os campos são opcionais porque nem todo caminho devolve o mesmo corpo:
 * `auth.updateUser` devolve `{ message }` sem `code`, e uma falha de rede
 * devolve `{}`. O mapeador nunca lança — quem chama está no `if (error)`.
 */
export interface ErroDoBanco {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

/**
 * As frases, por CHAVE do dicionário. A ordem aqui é a ordem de precedência em
 * `mensagemParaOperador`: constraint nomeada vence código genérico.
 */
export const FRASES = {
  /** Reaproveitada: já existia no dicionário para o mesmo desfecho. */
  generica: "Não foi possível salvar. Tente de novo.",
  sem_permissao: "Sua conta não tem permissão para salvar esta configuração.",
  repetido: "Já existe um registro com esses dados.",
  referencia: "O registro referenciado não existe mais. Atualize a página.",
  obrigatorio: "Falta um campo obrigatório. Preencha e salve de novo.",
  valor_invalido: "Um dos valores enviados não é aceito pelo servidor.",
  espera: "A gravação demorou mais que o esperado e nada foi salvo. Tente de novo.",
  cor_da_marca: "A cor da marca precisa ser um hexadecimal de seis dígitos, como #1a2b3c.",
  caminho_do_logo: "O caminho do logo não é aceito. Envie a imagem de novo.",
  sessao: "Sua sessão expirou. Entre de novo.",
  mfa: "Confirme a verificação em duas etapas.",
} as const;

export type FraseDoOperador = (typeof FRASES)[keyof typeof FRASES];

/**
 * CONSTRAINT → frase. A busca é por `if` encadeado, e NÃO por tabela indexada:
 * a cerca `i18n-espanhol-cobre-a-tela` (que varre `lib/` também) reprova
 * `traduzir(variavel)` — chave montada em runtime não está em dicionário nenhum
 * e sairia em português para quem escolheu espanhol. Aqui cada `traduzir()`
 * recebe uma chave conhecida em tempo de compilação.
 */
function porConstraint(texto: string, idioma: Idioma): string | null {
  if (texto.includes("platform_branding_accent_hex")) return traduzir(FRASES.cor_da_marca, idioma);
  if (texto.includes("platform_branding_accent_dark_hex")) {
    return traduzir(FRASES.cor_da_marca, idioma);
  }
  if (texto.includes("platform_branding_logo_path")) {
    return traduzir(FRASES.caminho_do_logo, idioma);
  }
  if (texto.includes("platform_branding_logo_dark_path")) {
    return traduzir(FRASES.caminho_do_logo, idioma);
  }
  if (texto.includes("platform_branding_favicon_path")) {
    return traduzir(FRASES.caminho_do_logo, idioma);
  }
  return null;
}

/**
 * SQLSTATE → frase. Os códigos são os que chegam de verdade nestas escritas:
 * `42501` (RLS/papel), `2350x` (integridade), `22P02` (uuid/valor torto) e o
 * trio de disputa (`55P03` prazo do papel, `40P01` deadlock, `40001`
 * serialização) — o mesmo trio que as irmãs `definir*` já traduzem em código.
 */
function porCodigo(code: string | null | undefined, idioma: Idioma): string | null {
  switch (code) {
    case "42501":
      return traduzir(FRASES.sem_permissao, idioma);
    case "23505":
      return traduzir(FRASES.repetido, idioma);
    case "23503":
      return traduzir(FRASES.referencia, idioma);
    case "23502":
      return traduzir(FRASES.obrigatorio, idioma);
    case "23514":
      return traduzir(FRASES.valor_invalido, idioma);
    case "22P02":
      return traduzir(FRASES.valor_invalido, idioma);
    case "55P03":
    case "40001":
    case "40P01":
      return traduzir(FRASES.espera, idioma);
    default:
      return null;
  }
}

/** O `auth.updateUser` devolve erro de sessão sem `code`; o texto é que denuncia. */
function pareceSessaoExpirada(erro: ErroDoBanco): boolean {
  const texto = erro.message ?? "";
  return /jwt expired|invalid (jwt|claim)|session (not found|missing)|refresh.?token/i.test(texto);
}

/**
 * A frase do operador para um erro de banco, já no idioma de quem chamou.
 *
 * NUNCA devolve o texto cru, nem vazio: o pior desfecho aqui é a genérica, que
 * ainda diz o que fazer ("tente de novo") sem nomear constraint nenhuma.
 */
export function mensagemParaOperador(erro: ErroDoBanco | null | undefined, idioma: Idioma = "pt-BR"): string {
  const e = erro ?? {};
  const texto = e.message ?? "";

  // A constraint nomeada vence o código: `23514` é o mesmo SQLSTATE para a cor
  // da marca e para o caminho do logo, e quem errou a cor precisa da frase da
  // cor. O nome só é procurado no texto do Postgres, que vem entre aspas ou
  // depois de "constraint" — comparar por `includes` basta e não depende do
  // dialeto da mensagem.
  const porRegra = porConstraint(texto, idioma);
  if (porRegra) return porRegra;

  // `mfa_required` sobe como `42501` com o nome da exigência no texto (mesmo
  // contrato das RPCs `fn_definir_*`); a frase de MFA é mais útil que a de
  // permissão, e a de permissão seria enganosa — a pessoa PODE, falta o código.
  if (texto.includes("mfa_required")) return traduzir(FRASES.mfa, idioma);

  if (pareceSessaoExpirada(e)) return traduzir(FRASES.sessao, idioma);

  const porSqlstate = porCodigo(e.code, idioma);
  if (porSqlstate) return porSqlstate;

  return traduzir(FRASES.generica, idioma);
}

export interface OpcoesDaResposta {
  /**
   * O que ficou no log. Escrito como constante de módulo no chamador: é a única
   * pista de qual action falhou quando o toast já não carrega o texto do banco.
   */
  contexto: string;
  idioma?: Idioma;
  /** Campos de contexto que já eram logados antes (id da organização, tabela…). */
  campos?: Record<string, unknown>;
}

/**
 * A resposta da action: registra o cru no log e devolve a frase do operador.
 *
 * Existe para o caminho de erro ser UMA linha no chamador. Devolver aqui (em vez
 * de só a mensagem) é o que impede a próxima action de voltar a montar
 * `{ ok: false, error: error.message }` por hábito: o objeto já vem pronto.
 */
export function respostaParaOperador(
  erro: ErroDoBanco | null | undefined,
  opcoes: OpcoesDaResposta,
): { ok: false; error: string } {
  // O cru INTEIRO mora aqui. `detail` carrega a mensagem do Postgres (com
  // constraint e relação) e é o que alguém usa para agir; o toast não.
  logger.error(opcoes.contexto, {
    ...(opcoes.campos ?? {}),
    code: erro?.code ?? null,
    detail: erro?.message ?? null,
    hint: erro?.hint ?? null,
  });
  return { ok: false, error: mensagemParaOperador(erro, opcoes.idioma ?? "pt-BR") };
}
