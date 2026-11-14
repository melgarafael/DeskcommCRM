---
impacto: nada_mudou
secao: corrigido
titulo: O sino de avisos e o cartão de proposta deixam de pedir a tela antes do clique
---

O `<Link>` do Next.js prefetcha sozinho todo destino que entra na viewport, e cada prefetch é um render RSC inteiro (`proxy.ts` + `loadAuthUser` + as consultas do layout de `/app`) para devolver a casca de uma rota `force-dynamic`. O sino do header fica em toda tela de `/app`, e o cartão de proposta nova nasce já na tela: os dois pediam `/app/ai/inbox` (ou o destino da proposta) ao montar, sem ninguém ter pedido a tela.

Agora os dois pedem por INTENÇÃO — ponteiro e foco, os dois sinais que antecedem o clique —, pelo mesmo gancho do menu (`hooks/navigation/prefetchPorIntencao.ts`). Quem só passa o olho pela tela não gera render nenhum; quem vai clicar continua entrando pelo caminho rápido. O contador do sino e o cartão que aparece quando chega proposta nova continuam exatamente como eram: o que saiu foi o pedido antecipado da tela, não o dado que a pessoa vê.

Crédito: @webtecnica.
