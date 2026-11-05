---
impacto: capacidade_nova
secao: adicionado
titulo: Cada chamada de IA passa a registrar quantos passos teve e de que é feito o pedido
---

Você não precisa fazer nada. A partir desta versão, cada chamada de IA do atendimento grava, além dos totais de tokens e do custo, quantos passos ela teve, quantos tokens de entrada o primeiro passo usou (como o provedor informou) e quanto pesam o texto do sistema, as ferramentas e as mensagens, em caracteres, mais quantas partes de mídia foram junto. Só tamanhos são guardados, nunca o conteúdo: o pedido é identificado por um código (hash) do trecho fixo, que serve para saber se o cache de prompt está sendo reaproveitado. O registro de cada turno do agente passa também a dizer quantas mensagens do histórico entraram na resposta.

Chamadas feitas antes da atualização ficam com esses campos vazios, e uma falha na medição deixa o campo vazio sem afetar a resposta ao cliente.

Para ver de que é feito o pedido de um agente, rode na VPS (só leitura; imprime nomes e números, nunca o texto do prompt):

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps worker \
  node --import tsx scripts/ops-count-prefix.ts --org <id-da-organização> --agent <id-do-agente> --dias 7
```

O comando sobe um contêiner à parte e o apaga ao terminar, sem dividir a memória com o worker que está atendendo.
