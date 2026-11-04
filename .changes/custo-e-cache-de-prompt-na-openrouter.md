---
impacto: capacidade_nova
secao: alterado
titulo: O custo das chamadas pela OpenRouter passa a ser o que a OpenRouter cobrou, e o cache de prompt dos Claude pode ser ligado
---

Nas chamadas de IA pela OpenRouter, a tela de Uso e o teto de gasto passam a contar o valor que a própria OpenRouter cobrou em cada resposta, e não mais uma estimativa pela nossa tabela de preços. A tabela não reconhecia alguns nomes de modelo Claude da OpenRouter. Com o cache ligado, ela também cobraria toda gravação de cache pela tarifa mais cara. Quando a OpenRouter não informa o valor, ou quando o endereço configurado é um gateway próprio, a conta segue pela tabela, como antes.

Também dá para ligar o cache de prompt nos modelos Claude pela OpenRouter, com `OPENROUTER_PROMPT_CACHE=on` no `.env` e o worker reiniciado. Com ele, a parte fixa da conversa do agente fica guardada na OpenRouter e cada resposta custa menos. O padrão é desligado, e desligado nada muda no que é enviado. Se a OpenRouter recusar pedidos com erro 400 citando `cache_control`, volte para `off`.

Você não precisa fazer nada para atualizar.
