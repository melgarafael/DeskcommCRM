/**
 * OS MODELOS QUE O PROVEDOR APOSENTOU — o catálogo pode listá-los, a ESCOLHA não.
 *
 * Por que este módulo existe, e não uma migration: `ai_models` é a tabela que a
 * tela oferece, e depreciar uma linha lá é SQL. Mas o defeito da #4925 não é a
 * tela — é a ESCOLHA automática: `escolherModeloEconomico` pega o mais barato do
 * provedor, e os quatro Gemini aposentados (10/40 e 125/1000) eram os mais
 * baratos. Numa instalação com Google, todo ponto de tier econômico
 * (`checkpoint`, `promise_semantic`, …) tomava 404 em TODA chamada, com o
 * fail-open do seam engolindo a causa — o sintoma era custo e latência.
 *
 * O preço deles continua em `pricing.ts` de propósito: id aposentado ainda
 * aparece em instalação antiga e em roteador (`google/gemini-2.5-flash` pela
 * Requesty), e custo NULL calado é o defeito da #3013. O que muda é só quem pode
 * ser ESCOLHIDO.
 *
 * A lista é MEDIÇÃO, não palpite — e o teste (`google-modelos-aposentados`)
 * prende cada linha à resposta que o provedor deu, com data. Modelo volta a ser
 * escolhível apagando a entrada aqui e a fixture do teste junto; sem isso, o
 * repositório volta a apontar para um id que responde 404.
 */

/**
 * Medido em 18/11/2026 com a chave Google real do perfil, em
 * `POST https://generativelanguage.googleapis.com/v1beta/models/<id>:generateContent`
 * com `maxOutputTokens: 1`. Todos responderam **404**:
 *
 *   gemini-2.0-flash ..... "no longer available" (e o `/v1beta/models` já não o lista)
 *   gemini-2.5-flash ..... "no longer available to new users"
 *   gemini-2.5-flash-lite  "no longer available to new users"
 *   gemini-2.5-pro ....... "no longer available to new users"
 *
 * A mensagem do 404 diz para onde o provedor migrou (3.8 Flash, 3.5 Flash-Lite,
 * 3.1 Pro); é de lá que sai o substituto, e não de um id parecido inventado.
 */
const APOSENTADOS_PELO_PROVEDOR: ReadonlySet<string> = new Set([
  "gemini-2.0-flash",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
]);

/**
 * O provedor ainda serve este id? `true` = NÃO sirva como escolha automática.
 *
 * Casa pelo id EXATO e pelo id sem o sufixo de data do vendor (`-20250805`), que
 * é a mesma tolerância de `precoDoModelo`: um snapshot datado de um modelo
 * aposentado também responde 404, e cobrar o preço dele não é motivo para
 * escolhê-lo. Prefixo `provider/` (OpenRouter, Requesty) é recortado pelo mesmo
 * motivo — `google/gemini-2.5-flash` é o mesmo modelo aposentado.
 */
export function modeloAposentadoNoProvedor(model: string): boolean {
  const semPrefixo = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  return (
    APOSENTADOS_PELO_PROVEDOR.has(model) ||
    APOSENTADOS_PELO_PROVEDOR.has(semPrefixo) ||
    APOSENTADOS_PELO_PROVEDOR.has(semPrefixo.replace(/-\d{8}$/, "")) ||
    APOSENTADOS_PELO_PROVEDOR.has(semPrefixo.replace(/-\d{4}-\d{2}-\d{2}$/, ""))
  );
}

/** A lista crua, para o teste comparar com a medição. */
export function modelosAposentadosPeloProvedor(): string[] {
  return [...APOSENTADOS_PELO_PROVEDOR];
}
