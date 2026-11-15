---
impacto: nada_mudou
secao: corrigido
titulo: A IA não grava mais campo personalizado que o funil não declara
---

O agente podia inventar a chave de um campo personalizado — `valor_do_plano`,
por exemplo — e o valor era aceito sem aviso. Ele entrava no negócio sem casar
com campo nenhum do funil: não aparecia na ficha, não entrava em relatório e
ninguém ficava sabendo que o dado tinha se perdido. Agora, no atendimento, a
chamada é recusada e a IA recebe de volta a lista das chaves que o funil
declara, com o nome que o dono deu a cada uma, para corrigir na mesma hora. O
que ela mandar com uma chave válida grava como sempre gravou.

Se os campos do funil não puderem ser lidos naquele instante, a ferramenta não
recusa nada: grava como antes e avisa que as chaves não foram conferidas. Quem
escreve pela API, por automação ou pela tela não passa por essa conferência e
continua igual.
