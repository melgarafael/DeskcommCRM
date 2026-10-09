---
impacto: nada_mudou
secao: corrigido
titulo: O arquivo de dados que o titular recebe ao pedir acesso é montado em partes e usa cerca de um terço da memória de antes
---

O arquivo de dados (`data.json`) do pedido de acesso do titular era montado inteiro
na memória. Num processo de medição na VPS de testes, com 100 mil mensagens, esse
trecho usava 612 MB, acima dos 512 MB do worker, e passou a usar 198 MB. Agora ele é
escrito em partes, direto no envio. O conteúdo do arquivo é exatamente o mesmo, byte
a byte, no Brasil e fora dele. Se a leitura das mensagens falhar no meio, o arquivo
passa a listar as mensagens em `secoes_no_limite`, que é o aviso de que pode haver
mais registros do que os entregues. Antes, o arquivo saía incompleto sem aviso. A
lista de mensagens ainda é lida inteira antes do envio; com volumes bem maiores a
memória volta a crescer, e isso segue na issue #2576. Nada precisa ser feito ao
atualizar. Contribuição de @webtecnica (#2651), a partir da issue #2576.
