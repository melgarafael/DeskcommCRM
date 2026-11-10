/**
 * As chaves de instalação que pertencem a um CANAL — e por que elas moram aqui.
 *
 * O painel de configuração (`lib/instalacao/catalogo.ts`) precisa mostrar ao dono
 * da VPS o estado das credenciais do transporte de WhatsApp, porque é uma das
 * primeiras coisas que ele confere quando o atendimento para. Mas o NOME dessas
 * variáveis é o nome do provider, e a doutrina `restricao-de-canal` proíbe
 * nomear provider fora de `lib/channels/` — com razão: espalhar o nome pelo
 * código é o que torna impossível trocar de transporte depois.
 *
 * A saída não é abrir exceção no lint (a lista de lá é dívida em extinção, não
 * anistia): é deixar estas entradas DENTRO da fronteira que já tem o direito de
 * nomear o provider, e o catálogo as importa como dados. Quem lê o catálogo
 * continua sem nomear ninguém; quem nomeia é este arquivo, que é de canais.
 */

export interface ChaveDeCanal {
  readonly chave: string;
  readonly rotulo: string;
  readonly explicacao: string;
  /** Presente = só se troca no arquivo de instalação (`diagnostico`). Ausente = a tela edita. */
  readonly comoTrocar?: string;
}

/**
 * Nenhuma delas é editável pela tela, e o motivo é físico, não de recorte: cada
 * uma tem um PAR do outro lado — o contêiner do transporte guarda a versão
 * embaralhada da mesma senha. Trocar só de um lado deixa os dois falando senhas
 * diferentes e derruba o WhatsApp. A troca é no arquivo de instalação, seguida
 * de reinício dos dois.
 */
export const CHAVES_DE_CANAL_DA_INSTALACAO: readonly ChaveDeCanal[] = [
  {
    chave: "WAHA_API_KEY",
    rotulo: "Senha de acesso ao WhatsApp",
    explicacao:
      "A senha que o sistema usa para falar com o programa que conecta o WhatsApp.",
    comoTrocar:
      "Esta senha tem um par do outro lado: o programa do WhatsApp guarda a versão embaralhada dela. Trocar só aqui deixaria os dois falando senhas diferentes e o WhatsApp cairia. A troca é no arquivo de instalação, seguida de reinício dos dois programas.",
  },
  {
    chave: "WAHA_HMAC_SECRET",
    rotulo: "Senha de conferência das mensagens recebidas",
    explicacao:
      "Garante que as mensagens que chegam vieram mesmo do WhatsApp, e não de um impostor.",
    comoTrocar:
      "Mesma situação da senha de acesso: o programa do WhatsApp guarda a outra metade. Os dois trocam juntos, no arquivo de instalação.",
  },
  {
    // Editável pela tela: quem lê é `chaveDaInstalacao()` (lib/channels/zernio/
    // credentials.ts), pelo resolvedor, a cada chamada — não há par em outro
    // contêiner. Vazia, a conexão por um clique some da tela de Conexões.
    chave: "ZERNIO_PLATFORM_API_KEY",
    rotulo: "Chave da conta da instalação no provedor parceiro",
    explicacao:
      "Com ela, cada empresa conecta o número oficial do WhatsApp com um clique, sem ter conta no provedor. Os números ficam na conta da instalação e entram na fatura dela.",
  },
] as const;
