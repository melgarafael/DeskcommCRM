"use client";

/**
 * ONDE O TEXTO DO CLIENTE É PROCESSADO — a linha que responde a pergunta que o
 * contrato do operador faz e que a tela não respondia (#4519).
 *
 * O dado vem do CATÁLOGO (`lib/ai/pontos/provedores.ts`), nunca digitado aqui:
 * país é informação que muda com contrato e com política de fornecedor, e tela
 * não é lugar de manter dado que envelhece. O que este arquivo mantém é só a
 * forma de dizer — e as respostas que NÃO são país.
 *
 * ## O catálogo fala em CÓDIGO; a tela, em NOME
 *
 * `pais` é `PaisDoProvedor` — `"US"`, `"CN"`, `"UE"`, `"operador"`,
 * `"desconhecido"` — porque a cláusula 9 do documento do operador
 * (`lib/legal/operador.ts`) lê esse vocabulário fechado e o imprime em português
 * jurídico. Traduzir aqui, com o MESMO mapa que a cláusula usa (`NOME_DO_PAIS`,
 * exportado do catálogo), é o que impede as duas superfícies de dizerem coisas
 * diferentes sobre o mesmo provedor.
 *
 * ## Por que "não sei" aparece em vez de sumir
 *
 * Um provedor sem país declarado não é um caso vazio: é uma resposta, e a
 * resposta honesta é "o provedor não declara". Esconder a linha faria a tela
 * parecer completa e o operador concluir que o texto não sai do país — que é
 * exatamente a conclusão errada que a cláusula de transferência do contrato
 * existe para evitar. Mesma coisa com o endpoint próprio: o endereço é de quem
 * opera, o CRM não sabe onde ele fica, e dizer isso é melhor que calar.
 *
 * ## Valor fora do vocabulário não é país
 *
 * Código que não está em `NOME_DO_PAIS` — o texto livre que o campo aceitava
 * antes do #4520, ou dado torto de outro consumidor — cai em `desconhecido` e a
 * tela diz o motivo. Defesa em profundidade: o teste de catálogo
 * (`tests/unit/provedor-declara-pais.test.ts`) já reprova país fora do
 * vocabulário no DADO; aqui é a segunda metade, para o que chega por JSON de
 * rota sem passar pelo tipo.
 *
 * A proveniência (`fonteDoPais`) é POR PROVEDOR: quando existe, vira link e
 * data. Quando não existe, a declaração é a do catálogo, datada em
 * `CONSULTA_DOS_PAISES_EM` e impressa pela cláusula 9 — esta linha não inventa
 * fonte nem repete uma data que não é dela.
 */
import { useT } from "@/hooks/i18n/useT";
import { NOME_DO_PAIS } from "@/lib/ai/pontos/provedores";

export interface ProvedorComPais {
  /**
   * Código do catálogo (`PaisDoProvedor`). Tipado como `string` de propósito: o
   * valor chega de JSON de rota, e é `situacaoDoTexto` que prova se ele está no
   * vocabulário — em vez de confiar no que o consumidor declarou.
   */
  pais: string;
  /** Proveniência por provedor; `null` = declaração do catálogo (ver o cabeçalho). */
  fonteDoPais: { url: string; consultadoEm: string } | null;
}

export type SituacaoDoTexto = "declarado" | "operador" | "desconhecido" | "endereco_proprio";

/** ISO (`2026-11-12`) vira `12/11/2026` sem passar por locale: o render do servidor e o do cliente precisam dar o mesmo texto. */
export function dataDaConsulta(iso: string): string {
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return partes ? `${partes[3]}/${partes[2]}/${partes[1]}` : iso;
}

/** O nome do país, ou `null` quando o código não é do vocabulário. */
export function nomeDoPais(pais: string): string | null {
  return Object.prototype.hasOwnProperty.call(NOME_DO_PAIS, pais)
    ? NOME_DO_PAIS[pais as keyof typeof NOME_DO_PAIS]
    : null;
}

/**
 * A ordem importa: endpoint próprio vence o catálogo (quem escolheu o endereço
 * sabe onde ele fica, o catálogo não), e valor fora do vocabulário nunca é
 * "declarado".
 */
export function situacaoDoTexto(
  provedor: ProvedorComPais,
  enderecoProprio: string | null,
): SituacaoDoTexto {
  if (enderecoProprio) return "endereco_proprio";
  if (provedor.pais === "operador") return "operador";
  if (nomeDoPais(provedor.pais)) return "declarado";
  return "desconhecido";
}

interface Props {
  provedor: ProvedorComPais;
  /**
   * Endereço próprio gravado/escolhido no ponto. Presente = o destino é do
   * operador: a linha diz isso em vez de repetir o país do catálogo.
   */
  enderecoProprio?: string | null;
  className?: string;
}

export function OndeOTextoEProcessado({ provedor, enderecoProprio = null, className }: Props) {
  const t = useT();
  const situacao = situacaoDoTexto(provedor, enderecoProprio);
  const nome = nomeDoPais(provedor.pais);

  return (
    <p
      className={`text-xs text-muted-foreground${className ? ` ${className}` : ""}`}
      data-testid="onde-o-texto-e-processado"
      data-situacao={situacao}
    >
      <span className="font-medium">{t("Onde o texto é processado:")}</span>{" "}
      {situacao === "declarado" && nome ? (
        <>
          <span>{nome}</span>
          {provedor.fonteDoPais && (
            <>
              {" · "}
              <a
                className="underline underline-offset-4"
                href={provedor.fonteDoPais.url}
                target="_blank"
                rel="noreferrer"
              >
                {t("fonte: política do provedor")}
              </a>
              <span>
                {", "}
                {t("consultada em")} {dataDaConsulta(provedor.fonteDoPais.consultadoEm)}
              </span>
            </>
          )}
        </>
      ) : situacao === "operador" ? (
        <span>{t("Neste servidor — nada sai da instalação")}</span>
      ) : situacao === "endereco_proprio" ? (
        <span>{t("Endereço definido por você — o CRM não sabe onde ele fica")}</span>
      ) : (
        <span>{t("O provedor não declara o país; consulte a política dele")}</span>
      )}
    </p>
  );
}
