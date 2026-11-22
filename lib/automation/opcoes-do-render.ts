/**
 * O IDIOMA E O FUSO que o render usa para formatar uma data (#4339).
 *
 * ─── Por que isto mora no CONTEXTO, e não num parâmetro ─────────────────────
 *
 * `renderTemplate` é função PURA: o mesmo código atende automação, resposta
 * pronta e follow-up. Quem sabe o idioma e o fuso da empresa é quem monta o
 * contexto (`buildContext`, `contextoDoContato`), que já fala com o banco. Passar
 * isso por parâmetro exigiria tocar em CADA chamador — inclusive os que estão
 * sob PR aberto e não podem ser editados nesta entrega — e o chamador esquecido
 * formataria a data no idioma errado, em silêncio.
 *
 * ─── Por que a chave é `__render` ──────────────────────────────────────────
 *
 * Porque ela NÃO é vocabulário. Duas underscores marcam o que é interno, e o
 * nome não colide com contato, negócio nem campo personalizado (que são
 * `[a-z_]`). O render lê daqui; nenhuma mensagem escreve daqui.
 *
 * Sem a chave (contexto montado à mão, teste, integrador), o padrão é o do
 * produto: português e `America/Sao_Paulo` — o mesmo que a instalação já usa.
 */
import type { OpcoesDaData } from "@/lib/i18n/data-na-mensagem";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { FUSO_PADRAO, fusoUtilizavel } from "@/lib/tempo/fusos";

/** A chave reservada do render. Não é variável de mensagem. */
export const CHAVE_DAS_OPCOES_DO_RENDER = "__render";

export const OPCOES_DO_RENDER_PADRAO: OpcoesDaData = { idioma: IDIOMA_PADRAO, fuso: FUSO_PADRAO };

/**
 * Grava idioma/fuso da organização no contexto do render.
 *
 * Campo ausente ou torto (`organizations.locale` é texto livre) não derruba a
 * mensagem: cai no padrão. Fuso inválido é o caso que MAIS importa aqui —
 * `Intl` lança `RangeError` nele, e um acento no campo derrubaria o envio.
 */
export function anexarOpcoesDoRender(
  contexto: Record<string, unknown>,
  opcoes: { idioma?: string | null; fuso?: string | null },
): Record<string, unknown> {
  contexto[CHAVE_DAS_OPCOES_DO_RENDER] = {
    idioma: opcoes.idioma?.trim() || IDIOMA_PADRAO,
    fuso: fusoUtilizavel(opcoes.fuso),
  } satisfies OpcoesDaData;
  return contexto;
}

/** O que o contexto traz — ou o padrão do produto. */
export function opcoesDoRender(contexto: Record<string, unknown>): OpcoesDaData {
  const bruto = contexto[CHAVE_DAS_OPCOES_DO_RENDER];
  if (!bruto || typeof bruto !== "object") return OPCOES_DO_RENDER_PADRAO;
  const { idioma, fuso } = bruto as Partial<OpcoesDaData>;
  return {
    idioma: typeof idioma === "string" && idioma.trim() !== "" ? idioma : IDIOMA_PADRAO,
    fuso: fusoUtilizavel(typeof fuso === "string" ? fuso : null),
  };
}
