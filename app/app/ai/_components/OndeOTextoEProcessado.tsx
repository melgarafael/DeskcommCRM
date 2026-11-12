"use client";

/**
 * ONDE O TEXTO DO CLIENTE É PROCESSADO — a linha que responde a pergunta que o
 * contrato do operador faz e que a tela não respondia (#4519).
 *
 * O dado vem do CATÁLOGO (`lib/ai/pontos/provedores.ts`), nunca digitado aqui:
 * país é informação que muda com contrato e com política de fornecedor, e tela
 * não é lugar de manter dado que envelhece. O que este arquivo mantém é só a
 * forma de dizer — e as três respostas que NÃO são país.
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
 * ## País declarado sem fonte não é país
 *
 * Se o catálogo trouxer um país fora de `local`/`desconhecido` e sem
 * `fonteDoPais`, esta linha trata como `desconhecido` e diz o motivo na tela.
 * O teste de catálogo (`tests/unit/provedor-declara-pais.test.ts`) já reprova
 * essa combinação no dado; aqui a defesa é a segunda metade — tela que não
 * repete afirmação sem procedência, mesmo que o dado chegue torto de outro
 * consumidor (o GET da rota entrega o objeto do catálogo inteiro).
 */
import { useT } from "@/hooks/i18n/useT";

export interface ProvedorComPais {
  /** `local` = modelo no servidor do operador; `desconhecido` = o provedor não fixa região. */
  pais: string;
  /** Sem URL e data, o país não vale — ver o cabeçalho. */
  fonteDoPais: { url: string; consultadoEm: string } | null;
}

export type SituacaoDoTexto = "declarado" | "local" | "desconhecido" | "endereco_proprio";

/** ISO (`2026-11-12`) vira `12/11/2026` sem passar por locale: o render do servidor e o do cliente precisam dar o mesmo texto. */
export function dataDaConsulta(iso: string): string {
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return partes ? `${partes[3]}/${partes[2]}/${partes[1]}` : iso;
}

/**
 * A ordem importa: endpoint próprio vence o catálogo (quem escolheu o endereço
 * sabe onde ele fica, o catálogo não), e país sem fonte nunca é "declarado".
 */
export function situacaoDoTexto(
  provedor: ProvedorComPais,
  enderecoProprio: string | null,
): SituacaoDoTexto {
  if (enderecoProprio) return "endereco_proprio";
  if (provedor.pais === "local") return "local";
  // `!fonteDoPais` cobre também `undefined` (objeto vindo de um consumidor que
  // não passou pelo tipo): ausência de fonte nunca vira país declarado.
  if (provedor.pais === "desconhecido" || !provedor.fonteDoPais) return "desconhecido";
  return "declarado";
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

  return (
    <p
      className={`text-xs text-muted-foreground${className ? ` ${className}` : ""}`}
      data-testid="onde-o-texto-e-processado"
      data-situacao={situacao}
    >
      <span className="font-medium">{t("Onde o texto é processado:")}</span>{" "}
      {situacao === "declarado" && provedor.fonteDoPais ? (
        <>
          <span>{provedor.pais}</span>
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
      ) : situacao === "local" ? (
        <span>{t("Neste servidor — nada sai da instalação")}</span>
      ) : situacao === "endereco_proprio" ? (
        <span>{t("Endereço definido por você — o CRM não sabe onde ele fica")}</span>
      ) : (
        <span>{t("O provedor não declara o país; consulte a política dele")}</span>
      )}
    </p>
  );
}
