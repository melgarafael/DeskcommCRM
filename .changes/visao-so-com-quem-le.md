---
impacto: capacidade_nova
secao: adicionado
titulo: Cada agente escolhe se vê as fotos que o cliente envia, e a foto só passa pela visão da IA quando alguém vai ler a descrição
---

Toda foto recebida passava pela visão da IA, que escreve uma descrição para os agentes e as integrações. Cada descrição é uma chamada paga a um modelo com visão, e numa empresa sem nenhuma IA nem integração ninguém a lia: o atendente vê a própria foto na conversa.

A tela do agente ganhou a opção «Ver as fotos que o cliente envia». Ela vem ligada, e é o que todo agente que já existe tem, então nada muda para quem não mexer. Desligada, o agente sabe que chegou uma foto do cliente, mas não vê o que ela mostra, e pode pedir ao cliente que conte; nas respostas que ele escreve, a descrição não entra nem quando outro agente da empresa a pediu, e isso vale também quando a equipe pergunta sobre um caso dele. As etapas internas do follow-up (classificar o contato, escolher a hora, conferir as respostas do roteiro) ainda leem a descrição quando outro leitor a pediu. As fotos que a empresa envia continuam aparecendo para ele como antes. O PDF não muda: o texto dele continua sendo tirado no próprio servidor, sem chamada a modelo. O histórico de versões mostra a troca.

A foto agora só é descrita quando a empresa tem quem queira ler: um agente com a opção ligada, um token de API, uma conexão de anúncio, o modo externo, a venda pelo canal, uma inscrição de follow-up sem agente ou um caso aberto cujo agente saiu do ar (a pergunta da equipe sobre o caso é respondida pela IA padrão da empresa, que vê as fotos). Sem nenhum deles, a foto é guardada sem descrição. Quando aparece quem a leia, ela é descrita: o agente que vai responder a conversa espera a descrição antes do primeiro turno (também quando um roteador entrega a conversa a um agente que vê, mesmo que o agente do número esteja com a opção desligada), e uma varredura de 5 em 5 minutos descreve as fotos dos últimos 7 dias para quem lê fora da conversa. Nessas empresas, o PDF da conversa mostra `[image]` para foto sem legenda.

Isso vale pela variável `MEDIA_VISION_WITHOUT_READER`, que vem em `defer`. Para voltar a descrever toda foto, como antes, use `always`; com ela, a varredura também descreve as fotos que ficaram para trás, de qualquer data.

A atualização acrescenta uma coluna às versões de agente, ligada em toda versão existente.
