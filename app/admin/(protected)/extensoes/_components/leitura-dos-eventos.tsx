import { tagDeIdioma } from "@/lib/i18n/datas";
import type { Idioma } from "@/lib/i18n/idiomas";
import { fusoUtilizavel } from "@/lib/tempo/fusos";
import { type AtrasoPorVinculo } from "@/lib/extensions/eventos-do-modulo";

/**
 * A LEITURA DOS AVISOS DE UM MÓDULO CONECTADO, um item por empresa — e as duas réguas que fazem cada
 * item ficar no lugar (#5097).
 *
 * ── 1. O rótulo é do HASH, não da posição ───────────────────────────────────
 *
 * A lista é ordenada por atraso (`lag desc`, `last_read_at nulls first`), então a empresa que acabou
 * de ler desce — e, quando o rótulo era o índice, ela trocava de nome no meio da sessão. Pior entre
 * dois dias: quem acompanha "Empresa 1" em atraso não sabe se é a mesma empresa de ontem.
 *
 * O nome da empresa NÃO pode aparecer: `/admin/extensoes` é a tela da INSTALAÇÃO, e o admin da
 * instalação não deve ver a lista de clientes (é decisão da tela, não falta de dado). O rótulo é,
 * então, o `rotulo` que o banco derivou do id da organização — seis caracteres hexadecimais. Estável,
 * porque o id não muda; e opaco, porque seis hex não devolvem nome nem id.
 *
 * ── 2. O "lido em" é a hora da EMPRESA ──────────────────────────────────────
 *
 * `toLocaleString` sem `timeZone` formata no fuso do PROCESSO — a VPS roda em UTC, e quem administra
 * de São Paulo via a hora três horas à frente. O fuso é o `organizations.timezone` de cada empresa
 * (o mesmo que o resto do app usa para virar o dia); `fusoUtilizavel` degrada para o padrão do
 * produto quando o campo é texto livre inválido, em vez de deixar o `Intl` lançar.
 */

/** `Empresa {n}` — e `{n}` passou a ser o código curto, não o índice da lista. */
export function rotuloDaEmpresa(rotulo: string, t: (s: string) => string): string {
  return t("Empresa {n}").replace("{n}", rotulo);
}

/** O instante da última leitura no fuso da empresa, no idioma de quem lê. */
export function horaDaLeitura(iso: string, idioma: Idioma, fuso: string | null): string {
  return new Date(iso).toLocaleString(tagDeIdioma(idioma), {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: fusoUtilizavel(fuso),
  });
}

export function LeituraDosEventos({
  chave,
  vinculos,
  t,
  idioma,
}: {
  chave: string;
  vinculos: AtrasoPorVinculo[];
  t: (s: string) => string;
  idioma: Idioma;
}) {
  return (
    <div data-testid={`leitura-eventos-${chave}`} className="mt-2 space-y-1 text-xs">
      <p className="font-medium">{t("Leitura dos avisos pelo módulo")}</p>
      {vinculos.map((v, i) => (
        <div key={i} data-testid={`leitura-eventos-${chave}-${i}`} className="text-text-muted">
          <p>
            {rotuloDaEmpresa(v.rotulo, t)} ·{" "}
            {v.lidoEm === null || v.ultimoCursor === null
              ? t("ainda não leu nenhum aviso")
              : `${t("último aviso lido")} #${v.ultimoCursor} · ${t("lido em")} ${horaDaLeitura(v.lidoEm, idioma, v.fuso)}`}
            {" · "}
            {v.atraso === 0
              ? t("em dia")
              : t("{n} aviso(s) por ler").replace("{n}", String(v.atraso))}
            {v.atrasado ? (
              <span
                data-testid={`selo-atrasado-${chave}-${i}`}
                className="ml-2 rounded-md bg-warning-bg px-1.5 py-0.5 font-medium text-warning-fg"
              >
                {t("Atrasado")}
              </span>
            ) : null}
          </p>
          {v.contatosPendentes > 0 ? (
            <p data-testid={`leitura-eventos-lgpd-${chave}-${i}`}>
              {t("Este módulo ainda não apagou os dados de {n} contato(s) anonimizado(s).").replace(
                "{n}",
                String(v.contatosPendentes),
              )}
              {v.atrasado
                ? ` ${t("Faz mais de 24 horas que o módulo não busca os avisos, e a LGPD manda apagar esses dados.")}`
                : ""}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
