import { marcaDaSaida } from "@/lib/branding/saida";

/**
 * O logo das telas de ANTES de entrar — resolvido num lugar só.
 *
 * ── Por que um componente, e não um `<img>` em cada tela ──────────────────────
 *
 * São seis telas no grupo `(public)`, e todas são "antes de entrar": quem instala
 * o produto para clientes mostra a marca dele exatamente aí. Um `<img>` por
 * página seriam seis cópias que divergem na primeira vez que alguém mexer numa
 * só — e a que ficaria para trás é sempre a que ninguém abre (recuperação de
 * senha, cadastro de MFA), que é justamente onde o cliente do revendedor aparece
 * sozinho e sem contexto.
 *
 * Este componente nasceu quando o `/login` ganhou o painel dividido e deixou de
 * caber na casca centrada das outras cinco: a alternativa era duplicar a
 * resolução da marca em dois layouts, que é o mesmo defeito com outro nome.
 *
 * ── Por que `marcaDaSaida(null)` ──────────────────────────────────────────────
 *
 * Aqui não existe organização resolvida: `null` é a declaração disso, e a pilha
 * resultante é a mesma do layout raiz (banco acima, `.env` embaixo). Montar a
 * pilha à mão nesta tela faria a fachada anunciar uma precedência que o resto do
 * produto não usa. E `marcaDaSaida` NUNCA lança (ver o cabeçalho dela): uma cor
 * ou um logo mal gravados não podem derrubar a única tela por onde se entra para
 * corrigi-los.
 *
 * O NOME continua saindo de `branding()` dentro de cada página — não é descuido,
 * está medido em `tests/e2e/icone-da-marca.spec.ts:64-77`: aquela spec cruza duas
 * resoluções independentes (o título da aba, que lê o banco, contra o nome escrito
 * na tela, que lê o `.env`). Trocar o texto para este mesmo resolvedor deixaria a
 * spec verde medindo nada.
 */
export async function LogoDaFachada({ className }: { className?: string }) {
  const marca = await marcaDaSaida(null);
  if (!marca.logoUrl) return null;

  return (
    /*
      <img> em vez de next/image pelo mesmo motivo da barra lateral: a URL é de
      quem hospeda e o `next/image` exige allowlist de domínios fechada em BUILD —
      a imagem pré-buildada do self-host recusaria o domínio do operador. Altura
      fixa e largura livre para não distorcer arte de proporção desconhecida.

      O `alt` é o nome DESTA resolução (`marca.nome`), e não o de `branding()`: é a
      legenda da imagem que está ali, e nomeá-la com a marca de outra fonte
      descreveria uma marca que não é a do logo.

      O `data-testid` é lido por `tests/e2e/marca-logo.spec.ts`, que prova que o
      logo da EMPRESA não vaza para cá. Sem ele a spec caía na "primeira <img> da
      página", e uma asserção de negação com seletor largo passa sozinha assim que
      outra imagem entra na tela.
    */
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      data-testid="logo-da-fachada"
      src={marca.logoUrl}
      alt={marca.nome}
      className={className ?? "h-10 w-auto max-w-[12rem] object-contain"}
    />
  );
}
