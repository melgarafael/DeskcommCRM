/**
 * A marca da ORGANIZAÇÃO — de onde ela sai do jsonb e como a pilha é montada.
 *
 * Este é o único módulo que sabe que a marca do cliente final mora em
 * `organizations.settings.branding`. O resolvedor (`resolve.ts`) continua puro:
 * recebe camadas e não sabe de onde vieram; a leitura da linha da instalação
 * continua em `instalacao.ts`. Um lugar por fonte.
 *
 * ── Por que a pilha é montada AQUI, e num lugar só ────────────────────────────
 *
 * `app/layout.tsx:43-46` já registrou o motivo com a fase seguinte no horizonte:
 * "duas montagens divergiriam no dia em que a fase seguinte acrescentar a camada
 * da organização, e a divergência apareceria como título da aba com uma marca e
 * cor com outra". Esta É a fase seguinte. Os consumidores — o layout de `/app`, a
 * prévia ao vivo da tela de marca — chamam esta função em vez de repetir a ordem
 * das camadas, porque a ordem é a regra do produto, não detalhe de cada tela.
 *
 * ── Por que ela não vai buscar nada ───────────────────────────────────────────
 *
 * Recebe `settings`, a linha da instalação e o ambiente já lidos. O layout de
 * `/app` JÁ carrega `settings` no mesmo round-trip do admin client em que checa
 * `onboarded_at`/`status`, então a camada nova custa ZERO consulta. Uma função
 * que fosse ao banco por conta própria acrescentaria uma ida por render e
 * esconderia esse custo de quem a chamasse.
 *
 * ── Por que NUNCA lança ───────────────────────────────────────────────────────
 *
 * Mesma razão do resolvedor: isto roda no layout que embrulha `/app` inteiro.
 * Uma exceção aqui não deixa a marca feia — deixa todas as telas do tenant em
 * 500, inclusive a tela onde o admin corrigiria o valor que quebrou. `settings`
 * é jsonb livre: pode ter `branding` como string, número ou lista (escrita
 * manual, versão futura, migração pela metade), e nenhuma dessas formas pode
 * derrubar o produto. Não é engolir erro — a cor recusada sai como `motivos`
 * dentro de `MarcaResolvida`, que é o que a tela mostra ao admin.
 */

import { REGUA_DO_PRODUTO } from "./regua-do-produto";
import {
  camadaDaInstalacao,
  camadaDaOrganizacao,
  camadaDoAmbiente,
  resolverMarca,
  type LinhaDaInstalacao,
  type MarcaDaOrganizacao,
  type MarcaResolvida,
} from "./resolve";

/** O que o `.env` tem a dizer sobre marca — a mesma forma que `lib/env` expõe. */
export type AmbienteDaMarca = {
  APP_NAME?: string;
  APP_LOGO_URL?: string;
  APP_ACCENT_HEX?: string;
};

function texto(valor: unknown): string | null {
  return typeof valor === "string" ? valor : null;
}

/**
 * Lê `settings.branding` sem confiar em nada.
 *
 * `null` significa "esta organização não fala de marca" — e é diferente de
 * `{ app_name: null, accent_hex: null }`, que significaria "ela declarou e
 * mandou vazio". A distinção importa porque a segunda forma faria a camada
 * declarar `cor` e o resolvedor emitir `cor_ausente` em toda organização que
 * nunca abriu a tela.
 *
 * Campo de tipo errado (número, objeto, lista onde se espera string) vira `null`
 * em vez de descer para a derivação: `envelopeDeSemente` monta o envelope a
 * partir do que receber, e um `semente_hex` não-string produziria um
 * `envelope_malformado` que aponta para o campo errado no diagnóstico.
 */
export function marcaDaOrganizacaoDeSettings(settings: unknown): MarcaDaOrganizacao | null {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return null;
  const bruto = (settings as Record<string, unknown>).branding;
  if (typeof bruto !== "object" || bruto === null || Array.isArray(bruto)) return null;
  const envelope = bruto as Record<string, unknown>;
  return {
    app_name: texto(envelope.app_name),
    accent_hex: texto(envelope.accent_hex),
    // Caminho no bucket, nunca URL — quem grava é `fn_definir_logo_da_organizacao`
    // (migration 0158), que assevera o prefixo contra o `organization_id` DENTRO
    // do banco. `texto()` pelo mesmo motivo dos outros dois: um `logo_path` que
    // não fosse string desceria para `logoDaCamada` e viraria uma URL montada a
    // partir de um objeto.
    logo_path: texto(envelope.logo_path),
    ...(texto(envelope.logo_dark_path) ? { logo_dark_path: texto(envelope.logo_dark_path) } : {}),
  };
}

/**
 * A pilha inteira: ORGANIZAÇÃO acima, instalação no meio, `.env` embaixo.
 *
 * Precedência POR CAMPO (`primeiroDefinido`, em `resolve.ts`): a organização que
 * definiu só a cor continua com o nome E o logo do revendedor. Desde a onda do
 * upload, a camada da organização TAMBÉM fala de logo — e continua sendo por
 * campo: `logo_path` ausente desce para a instalação, não a apaga.
 */
export function resolverMarcaDaOrganizacao(
  settings: unknown,
  linha: LinhaDaInstalacao | null,
  ambiente: AmbienteDaMarca,
): MarcaResolvida {
  return resolverMarca(
    [
      camadaDaOrganizacao(marcaDaOrganizacaoDeSettings(settings)),
      camadaDaInstalacao(linha),
      camadaDoAmbiente(ambiente),
    ],
    REGUA_DO_PRODUTO,
  );
}
