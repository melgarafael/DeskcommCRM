---
impacto: nada_mudou
secao: corrigido
titulo: Teste do agente diz quando quem falhou foi o banco, em vez de mandar conferir credencial
---

Quem testava um agente recém-instalado e recebia "Não foi possível executar o teste. Confira modelo, credencial e materiais do agente" ia conferir exatamente isso — e refazia credencial, agente e artigos da base sem resolver nada, porque a causa era outra: o banco não respondia a tempo (`Query read timeout`).

Agora a falha é classificada antes de virar frase na tela. Quando o banco é que não atendeu, a resposta é **502 `preview_banco_indisponivel`** e o texto diz que o banco não respondeu, que **modelo e credencial não têm relação com a falha** e que o motivo exato está no log do app, no marcador `[ai.test]`. Nada de credencial é pedido nesse caso.

Quando a falha é do provedor — chave recusada, modelo fora da lista da empresa, cota, endereço próprio sem chave —, a mensagem continua a de antes, porque aí a orientação está certa. E quando não dá para provar de onde veio o erro, a frase também é a de antes: o sistema não inventa causa para o que não sabe. O erro cru continua indo para o log e para a linha do teste em `ai_agent_runs`, como sempre foi; o que mudou é a tradução para a tela.

Você não precisa mudar nada. Se o teste do agente falhar por instabilidade do banco, a mensagem agora diz isso.
