---
impacto: nada_mudou
secao: corrigido
titulo: O aviso em vermelho passa a aparecer na agenda, nas comandas, no faturamento e nos relatórios
---

Onze telas escreviam o vermelho de erro com um nome de token que não existia: `text-danger`, `bg-danger/5`, `border-danger`. O Tailwind 4 gera utilitário a partir das chaves declaradas no tema do `app/globals.css`, e esse nome nunca esteve lá — a cor da mesma família se chama `destructive`. O resultado não era erro de build nem de console: a classe simplesmente não gerava regra nenhuma desde que essas linhas foram escritas, e o texto herdava a cor da página enquanto o fundo ficava transparente.

Agora essas mensagens usam o token que existe e pintam no vermelho de erro do tema (o mesmo de `text-destructive`): erro de carregamento na agenda, nas comandas, no faturamento, nos honorários e nos relatórios de vendas e de rankings; a borda do campo de convidado com endereço inválido; o quadro de aviso da remoção de negócios no kanban; e a mensagem de modelo de atalho recusado na configuração de funis.

Nada muda para quem já roda a atualização: nenhum token novo, nenhum nome novo de cor, nenhuma migration. O que passa a existir é uma guarda de teste que lê as classes de cor do código e exige que cada uma fale com uma família de token real — é ela que impede o próximo nome inventado de chegar à tela sem cor. (Contribuição de @webtecnica, #5184.)
