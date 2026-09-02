---
impacto: nada_mudou
secao: corrigido
titulo: O endereço interno do seu servidor deixa de aparecer na página pública de saúde
---

O sistema tem um endereço público que responde se ele está de pé — usado por
monitoramento e pelo suporte. Ele já era cuidadoso: escondia de quem não tem a
chave interna o endereço da conexão do WhatsApp e do serviço de fila, porque
esse endereço é justamente o que alguém precisaria para tentar bater na porta
deles.

O cuidado tinha um furo. Quando o arquivo de configuração ficava com o endereço
numa forma inválida — sem o `https://` na frente, ou com aspas sobrando, que são
os dois erros mais comuns de quem instala —, a mensagem técnica da falha vinha
com o endereço dentro, e essa mensagem **saía por inteiro** para qualquer pessoa
que abrisse a página. O sistema fechava a porta da frente e deixava a mesma
informação na janela do lado.

Agora quem não tem a chave interna vê apenas que a consulta falhou, e **por quê**:
se não achou o servidor, se foi recusado, se demorou demais, se a
credencial não passou. Isso é o que serve para monitorar. O texto técnico
completo continua saindo inteiro para quem tem a chave, que é quem precisa dele
para consertar.

Para quem opera, nada muda: nenhuma configuração nova, nenhum passo de
atualização. Se você tinha algum alerta lendo o texto da mensagem de erro, ele
passa a ler o motivo em vez do texto.

O achado é de @prevprocesso-maker, que percebeu o furo instalando o sistema para
um cliente.
