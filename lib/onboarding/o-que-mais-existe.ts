/**
 * O que mais existe no sistema, além do que a pessoa acabou de montar.
 *
 * O wizard terminava com um botão que entregava o dono numa caixa de conversas
 * vazia. Ele tinha acabado de montar um funcionário e não fazia ideia de que
 * existe um lugar onde a IA pede ajuda, outro que mostra quem esfriou, outro
 * onde ela propõe as próprias melhorias. Descobrir isso ficava por conta da
 * curiosidade — e a maioria não volta para explorar menu.
 *
 * As frases NÃO são escritas aqui: vêm do registro de navegação, que já as tem
 * em português de dono de negócio e é a mesma fonte que alimenta o menu, o hub
 * e a busca. Uma segunda redação divergiria na primeira vez que alguém mudasse
 * uma das duas.
 *
 * A seleção é curada de propósito. São 34 destinos no produto; despejar todos
 * no fim do wizard seria trocar "não sei o que existe" por "não sei por onde
 * começar".
 */
import { NAV_DESTINATIONS } from "@/lib/navigation/registry";

/**
 * Na ordem em que fazem sentido para quem acabou de montar o funcionário.
 *
 * `comoChamar` existe porque os rótulos do menu ainda são "Inbox", "Kanban",
 * "Follow-ups", "Alertas" — nomes que quem instalou o sistema há dez minutos não
 * reconhece. Aqui a peça é apresentada pelo que ela FAZ. O menu continua com os
 * nomes dele (mudá-los é outra frente, com contrato de teste próprio); o que
 * este arquivo não faz é reescrever a DESCRIÇÃO, que segue vindo do registro.
 */
const CURADORIA: {
  href: string;
  comoChamar: string;
  porQue: string;
  comoFunciona: string[];
}[] = [
  {
    href: "/app/inbox",
    comoChamar: "As conversas",
    porQue: "É aqui que as conversas chegam, com você e ele atendendo lado a lado.",
    comoFunciona: [
      "O cliente manda uma mensagem no WhatsApp",
      "Ele responde sozinho, seguindo as regras da casa que você escreveu",
      "Se você entrar na conversa, ele sai da frente e deixa você atender",
    ],
  },
  {
    href: "/app/kanban",
    comoChamar: "O quadro de clientes",
    porQue: "Cada cliente vira um card, e ele mesmo move o card conforme a conversa anda.",
    comoFunciona: [
      "Cada cliente vira um cartão, na primeira coluna",
      "Conforme a conversa avança, ele move o cartão de coluna sozinho",
      "Você arrasta o cartão na mão quando quiser — o quadro é seu",
    ],
  },
  {
    href: "/app/ai/followups",
    comoChamar: "Voltar a falar com quem sumiu",
    porQue: "Para nenhum cliente sumir no silêncio — ele volta a falar sozinho, na hora certa.",
    // A peça mais técnica do produto, e a que mais assusta quem lê o nome. Os
    // passos abaixo são o comportamento real: `reactivity.ts` reage a mensagem
    // recebida, a pedido de parar e a atendimento humano; `intervencao.ts` é
    // quem dá as quatro formas de mexer no meio do caminho.
    comoFunciona: [
      "O cliente para de responder no meio da conversa",
      "Depois do tempo que você definir, ele manda uma mensagem puxando o assunto",
      "Se o cliente responder, o retorno para na hora — ninguém é perseguido",
      "Se o cliente pedir para parar, ele para e não volta a escrever",
      "E você pode pausar, adiar, pular um passo ou cancelar quando quiser",
    ],
  },
  {
    href: "/app/radar",
    comoChamar: "O que está esfriando",
    porQue: "Quem esfriou e ainda está aberto, para você agir antes de perder.",
    comoFunciona: [
      "Ele observa há quanto tempo cada negócio em aberto não tem resposta",
      "Os que estão esfriando sobem para o topo desta lista",
      "Você decide quem merece um empurrão seu, em vez de descobrir tarde demais",
    ],
  },
  {
    href: "/app/ai/inbox",
    comoChamar: "Quando ele pede ajuda",
    porQue: "Quando ele trava em algo que só uma pessoa resolve, o pedido aparece aqui.",
    comoFunciona: [
      "Ele encontra algo que não pode decidir sozinho — um desconto, uma exceção, um caso estranho",
      "Em vez de inventar, ele para e abre um pedido aqui",
      "Você decide, e ele volta a andar com a sua resposta",
    ],
  },
  {
    // A PORTA DE DESCOBERTA do aviso no WhatsApp (B1 da revisão de UX).
    //
    // A entrada no menu existe, e ela não basta: numa instalação nova a tela de
    // Casos está VAZIA, então um botão lá em cima é invisível justamente no dia
    // em que o recurso precisava já estar ligado — e quase ninguém volta a
    // explorar menu. Aqui a pessoa está sendo conduzida, acabou de montar o
    // funcionário e acabou de ler que ele às vezes trava. É o instante em que
    // "quer ser avisado no seu WhatsApp quando isso acontecer?" faz sentido.
    //
    // Fica DEPOIS de "Quando ele pede ajuda" de propósito: a pergunta só é
    // compreensível depois de a pessoa saber que existe um pedido de ajuda.
    href: "/app/ai/cases/avisos",
    comoChamar: "Ser avisado no seu WhatsApp",
    porQue: "Você não fica com o sistema aberto o dia todo — mas fica com o WhatsApp.",
    // Comportamento real do motor (`lib/escalacao/aviso-ao-suporte.ts`): o aviso
    // sai na ABERTURA do caso, uma vez, e o número escolhido só recebe — o que
    // chegar nele é descartado antes de virar contato. A exceção é a opção
    // "Responder casos por este WhatsApp" (desligada por padrão), que aceita
    // RESPONDER/PERGUNTAR (`lib/escalacao/resposta-whatsapp-ao-caso.ts`).
    comoFunciona: [
      "Você escolhe um número da equipe para receber os avisos",
      "Quando ele trava e abre um pedido de ajuda, chega uma mensagem nesse número, na hora",
      "A mensagem traz o assunto e um link que abre o atendimento — e nunca o telefone do cliente",
      "Responder àquele número não chega ao cliente: ele é só da equipe",
      "Se você ligar a opção, a equipe também orienta a IA respondendo ao aviso com RESPONDER ou PERGUNTAR",
    ],
  },
  {
    href: "/app/ai/proposals",
    comoChamar: "As ideias dele",
    porQue: "Com o tempo ele sugere as próprias melhorias — e você decide se entram.",
    // `apply-proposal.ts`: nada auto-aplica. O clique de aplicar é o gate humano,
    // e o que ele faz é criar uma versão NOVA do agente — a publicada não muda
    // até o ponteiro virar.
    comoFunciona: [
      "Ele acompanha os próprios atendimentos e percebe o que poderia ir melhor",
      "Escreve a sugestão aqui, em português, e espera",
      "Nada muda sozinho: só entra em vigor quando VOCÊ aprovar",
    ],
  },
];

export interface PecaDoSistema {
  href: string;
  /** Como a peça é apresentada a quem acabou de montar o funcionário. */
  comoChamar: string;
  /** O nome que ela tem no menu — para a pessoa reencontrá-la depois. */
  label: string;
  /** A frase do registro — a mesma do menu e da busca. */
  descricao: string;
  /** Por que ela importa para quem acabou de montar o funcionário. */
  porQue: string;
  /**
   * Como a peça funciona, em passos — o "tutorial" que o wizard deve a quem
   * acabou de instalar o sistema.
   *
   * Uma frase basta para dizer que a peça EXISTE; não basta para o follow-up,
   * que é a peça mais técnica do produto e a que mais assusta pelo nome. Quem lê
   * "volta a falar com quem sumiu" sem saber que o retorno PARA quando o cliente
   * responde imagina um robô perseguindo cliente — e desliga a peça que mais
   * recupera venda.
   *
   * ⚠️ CADA PASSO É COMPORTAMENTO REAL, verificado no código que o executa. Um
   * tutorial que promete o que o produto não faz é pior que tutorial nenhum: a
   * pessoa confia, não confere, e descobre com o cliente na linha.
   */
  comoFunciona: string[];
}

export function oQueMaisExiste(): PecaDoSistema[] {
  const porHref = new Map(NAV_DESTINATIONS.map((d) => [d.href as string, d]));
  return CURADORIA.flatMap((c) => {
    const d = porHref.get(c.href);
    // Destino que saiu do registro não vira card órfão apontando para o vazio.
    if (!d) return [];
    return [
      {
        href: c.href,
        comoChamar: c.comoChamar,
        label: d.label,
        descricao: d.description,
        porQue: c.porQue,
        comoFunciona: c.comoFunciona,
      },
    ];
  });
}
