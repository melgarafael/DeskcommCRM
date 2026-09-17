---
impacto: nada_mudou
secao: corrigido
titulo: Arquivo que o sistema não conseguiu ler deixa de virar resposta inventada
---

Quando a leitura de um arquivo enviado pelo cliente falhava de vez — um PDF
escaneado, sem texto de verdade, é o caso mais comum —, o agente recebia apenas
a marca "[documento]". Isso diz que chegou um arquivo e não diz que ninguém
conseguiu abri-lo, e o agente respondia como se soubesse o que havia ali.

Medido numa instalação real: uma cliente mandou um PDF de catálogo, o extrator
de texto falhou, e o assistente respondeu que o material "parece ser de
distribuidora/promocional" — uma afirmação sobre um conteúdo que ele nunca leu.

Agora a falha grava a mesma marca que os outros casos de arquivo ilegível já
gravavam: "não consegui interpretar". Da mensagem seguinte em diante o agente
sabe que houve um arquivo que não deu para ler e avisa, em vez de supor. O
aviso na Central continua aparecendo como antes, com o motivo técnico.

O turno que já tinha respondido não volta atrás — a correção vale do próximo em
diante, que é quando o agente lê o histórico da conversa.
