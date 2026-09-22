"use client";

/**
 * O bloco de ESTADO — o que satisfaz o invariante 6 do Sistema Vivo.
 *
 * Uma feature de marca que só tem campos é indistinguível de uma que nunca foi
 * instalada no dia em que ela degrada: o operador vê a cor do produto, conclui
 * que o campo não funciona e vai embora. Este bloco existe para que TODO estado
 * do sistema tenha uma frase na tela:
 *
 *   - de onde veio cada campo (o `.env` ou esta tela — `seeded_from_env`);
 *   - quanto contraste a cor de fato entrega, medido, com veredito;
 *   - o que o sistema ajustou por conta própria, e por quê;
 *   - se a marca PAROU de ser aplicada — `fallback_at`, o alarme que
 *     `registrarEstadoDaMarca` acende no caminho de render e apaga sozinho
 *     quando a resolução volta a passar.
 *
 * ── O que aqui é AO VIVO e o que é o que está GRAVADO ─────────────────────────
 *
 * Contraste e ajustes descrevem a cor que está NO CAMPO — é assim que a pessoa
 * decide antes de salvar. Origem e alarme descrevem o que está GRAVADO no banco,
 * porque essas duas só mudam depois de salvar. Os títulos dizem qual é qual: um
 * bloco que mistura as duas leituras é como se ensina alguém a não confiar na
 * tela.
 */

import type { Marca, TokensDoTema } from "@/lib/branding/contraste";
import { Card } from "@/components/ui/card";

import { motivosDoFallback, type Aviso, type Tom } from "@/lib/branding/linguagem";
import { useT } from "@/hooks/i18n/useT";

const CLASSE_DO_TOM: Record<Tom, string> = {
  informativo: "text-text-muted",
  atencao: "text-warning-fg",
  problema: "text-error-fg",
};

interface Props {
  /** De qual camada veio cada campo GRAVADO (`banco`, `env` ou `padrao`). */
  readonly origens: { readonly nome: string; readonly logoUrl: string; readonly cor: string };
  /** `false` quando a linha do banco é só uma cópia do arquivo de instalação. */
  readonly definidoNestaTela: boolean;
  /** Já formatado no servidor — data formatada no cliente diverge do HTML servido. */
  readonly fallbackEm: string | null;
  readonly fallbackMotivo: string | null;
  /** A derivação da cor que está NO CAMPO. `null` = campo vazio ou cor inválida. */
  readonly derivada: Marca | null;
  readonly avisos: readonly Aviso[];
  /** `false` quando a serialização recusaria esta cor — ela não chegaria à tela. */
  readonly seriaAplicada: boolean;
}

/**
 * O par que interessa a quem lê: o texto escrito EM CIMA da cor dos botões.
 *
 * `--color-accent-fg` é calculado (preto ou branco, o que ler melhor), então
 * este número responde à única pergunta que a pessoa tem sobre a própria cor —
 * "dá para ler o que está escrito no botão?". Os outros pares medidos (bordas,
 * contorno de foco) não têm frase própria: quando algum deles reprova, o motor
 * emite `accent_sem_contraste_possivel` e a lista de ajustes já o diz.
 */
function contrasteDoTexto(tokens: TokensDoTema) {
  return tokens.pares.find((p) => p.papel === "--color-accent-fg") ?? null;
}

function LinhaDeContraste({ rotulo, tokens }: { rotulo: string; tokens: TokensDoTema }) {
  const t = useT();
  const par = contrasteDoTexto(tokens);
  if (!par) return null;
  return (
    <li className="flex flex-wrap items-baseline gap-x-2">
      <span className="text-text-muted">{rotulo}:</span>
      <span className="font-mono text-text">{par.razao.toFixed(1).replace(".", ",")}:1</span>
      <span className={par.passa ? "text-success-fg" : "text-error-fg"}>
        {par.passa ? t("passa em AA") : t("abaixo do mínimo AA")}
      </span>
    </li>
  );
}

function origemEmPortugues(
  origem: string,
  definidoNestaTela: boolean,
  t: (texto: string) => string = (texto) => texto,
): string {
  // `banco` com `seeded_from_env` ligado NÃO é escolha de ninguém: é o valor do
  // arquivo de instalação copiado para a tabela na primeira leitura. Chamar isso
  // de "definido nesta tela" faria a origem mentir logo na instalação nova.
  if (origem === "banco") {
    return definidoNestaTela
      ? t("definido nesta tela")
      : t("veio do arquivo de instalação do servidor");
  }
  if (origem === "env") return t("veio do arquivo de instalação do servidor");
  return t("padrão do sistema");
}

function LinhaDeOrigem({ campo, valor }: { campo: string; valor: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border py-2 last:border-b-0">
      <span className="text-sm text-text">{campo}</span>
      <span className="text-sm text-text-muted">{valor}</span>
    </div>
  );
}

export function EstadoDaMarca({
  origens,
  definidoNestaTela,
  fallbackEm,
  fallbackMotivo,
  derivada,
  avisos,
  seriaAplicada,
}: Props) {
  const t = useT();
  return (
    <section className="space-y-4" aria-labelledby="estado-da-marca">
      <div>
        <h2 id="estado-da-marca" className="text-base font-medium tracking-tight text-text">
          {t("Como está agora")}
        </h2>
        <p className="text-sm text-text-muted">
          {t("O que o sistema está usando, o que ele mediu e o que ele ajustou sozinho.")}
        </p>
      </div>

      {/* A moldura usa `border-error` puro, e não `border-error-fg/30` como duas
          telas vizinhas fazem: MEDIDO no CSS gerado do build, o modificador de
          opacidade sobre uma cor vinda de `var()` não produz regra nenhuma no
          Tailwind 3.4 — aquelas telas estão sem borda e ninguém percebeu. Um
          alarme não é o lugar de repetir esse erro. */}
      {fallbackEm ? (
        <Card className="border-error bg-error-bg p-4">
          <p className="text-sm font-semibold text-error-fg">
            {t("A sua marca não está sendo aplicada.")}
          </p>
          <p className="mt-1 text-sm text-text">
            {t("Desde")} {fallbackEm} {t("o sistema voltou a usar as cores padrão dele.")}
          </p>
          <ul className="mt-2 space-y-1">
            {motivosDoFallback(fallbackMotivo).map((aviso) => (
              <li key={aviso.texto} className="text-sm text-text-muted">
                {t(aviso.texto)}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm text-text-muted">
            {t("Salvar uma cor válida aqui apaga este alerta.")}
          </p>
        </Card>
      ) : null}

      <Card className="p-4">
        <h3 className="text-sm font-medium text-text">{t("De onde vem cada coisa")}</h3>
        <div className="mt-2">
          <LinhaDeOrigem
            campo={t("Nome do sistema")}
            valor={origemEmPortugues(origens.nome, definidoNestaTela, t)}
          />
          <LinhaDeOrigem
            campo={t("Logo")}
            valor={origemEmPortugues(origens.logoUrl, definidoNestaTela, t)}
          />
          <LinhaDeOrigem
            campo={t("Cor")}
            valor={origemEmPortugues(origens.cor, definidoNestaTela, t)}
          />
        </div>
        <p className="mt-3 text-xs text-text-muted">
          {t(
            "O logo ainda é trocado no arquivo de instalação do servidor. Esta tela mostra de onde ele vem para que o valor não pareça ter sumido.",
          )}
        </p>
      </Card>

      {derivada ? (
        <Card className="p-4">
          <h3 className="text-sm font-medium text-text">{t("O texto em cima dos botões")}</h3>
          <p className="mt-1 text-xs text-text-muted">
            {t(
              "Quanto maior o número, mais fácil de ler. AA é o mínimo recomendado internacionalmente para texto.",
            )}
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            <LinhaDeContraste rotulo={t("No modo claro")} tokens={derivada.claro} />
            <LinhaDeContraste rotulo={t("No modo escuro")} tokens={derivada.escuro} />
          </ul>

          <h3 className="mt-5 text-sm font-medium text-text">{t("O que o sistema ajustou")}</h3>
          {/* O caso "nada mudou" NÃO diz "sua cor é usada exatamente como você
              escolheu": no modo escuro o produto usa um tom mais claro da
              escala por desenho, e a frase absoluta seria desmentida pela
              própria tira logo acima. */}
          {avisos.length === 0 ? (
            <p className="mt-1 text-sm text-text-muted">
              {t("Nada foi ajustado — a escala acima mostra onde a sua cor entra.")}
            </p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {avisos.map((aviso) => (
                <li key={aviso.texto} className={`text-sm ${CLASSE_DO_TOM[aviso.tom]}`}>
                  {t(aviso.texto)}
                </li>
              ))}
            </ul>
          )}

          {!seriaAplicada ? (
            <p className="mt-3 text-sm text-error-fg">
              {t(
                "Do jeito que está, esta cor não chegaria à tela: o sistema continuaria com as cores padrão dele.",
              )}
            </p>
          ) : null}
        </Card>
      ) : null}
    </section>
  );
}
