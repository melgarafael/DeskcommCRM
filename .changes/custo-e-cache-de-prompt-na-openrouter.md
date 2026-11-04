---
impacto: capacidade_nova
secao: alterado
titulo: O custo das chamadas pela OpenRouter passa a ser o que a OpenRouter cobrou, e o cache de prompt dos Claude fica ligado
---

Nas chamadas de IA pela OpenRouter, a tela de Uso e o teto de gasto passam a contar o valor que a própria OpenRouter cobrou em cada resposta, e não mais uma estimativa pela nossa tabela de preços. A tabela não reconhecia alguns nomes de modelo Claude da OpenRouter. Com o cache ligado, ela também cobraria toda gravação de cache pela tarifa mais cara. Quando a OpenRouter não informa o valor, ou quando o endereço configurado é um gateway próprio, a conta segue pela tabela, como antes.

O cache de prompt nos modelos Claude pela OpenRouter fica ligado por padrão: a parte fixa da conversa do agente fica guardada na OpenRouter e cada resposta custa menos. Ele só age nos modelos Claude pela OpenRouter oficial; os demais provedores e modelos não mudam. Para desligar, ponha `OPENROUTER_PROMPT_CACHE=off` no `.env` e reinicie o worker — faça isso se a OpenRouter recusar pedidos com erro 400 citando `cache_control`.

Você não precisa fazer nada para atualizar.
