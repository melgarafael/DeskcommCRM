---
impacto: capacidade_nova
secao: corrigido
titulo: A conexão do WhatsApp ganha uma opção de guardar o histórico do número, desligada por padrão
---

Quem conecta um número ao CRM podia ver o canal descartar o passado do aparelho: a sessão nascia só com o filtro de conversas, e o padrão do motor é não guardar nada — 3 conversas e 1 MB no número medido, contra 825 conversas e 57 MB quando o acervo é pedido. Agora a tela de conexões oferece a opção "Guardar o histórico anterior à vinculação" por conexão, **desligada por padrão**, e quando ela está ligada o corpo de criação da sessão pede o acervo ao canal (`noweb.store` com `enabled` e `fullSync`). O que passa a ficar guardado é o histórico do número, no servidor do canal, ocupando disco fora do alcance da anonimização do CRM — ela limpa o banco do CRM, não o do canal (acompanhado em #2320). O histórico anterior (cerca de 1 ano) só vem quando a opção está ligada NA vinculação; num número que já estava pareado, ligar guarda daqui em diante.

Ligar tem custo declarado: `fullSync` baixa o histórico ANTERIOR à vinculação, então a vinculação de um número movimentado faz o canal gastar tempo, CPU e disco para trazer o passado (o contêiner do canal tem teto de 1.280 MB na instalação padrão). Quem não quiser esse custo deixa a opção desligada, que é o estado de todo canal novo.

**Ligar ou desligar depois de pareado:** a opção é gravada e aplicada na sessão que já existe (a config é atualizada em cima da que já está lá, preservando filtro e webhooks), sem QR novo, e a conexão reinicia por alguns segundos. Ligar num número já pareado guarda daqui em diante — o histórico anterior só chega numa vinculação nova, como a própria #999 registra e a documentação do motor confirma. Desligar num número já pareado pode apagar o que o canal já guardou ("Do not change the values after you scanned QR, it can lead to the loss of the chat history"), e a tela avisa. A reconexão de quem nunca mexeu na opção não toca no que o canal já guarda.

O que NÃO muda: ligar o acervo não faz conversa antiga aparecer no inbox do CRM, que ainda não lê o histórico de volta do canal; o inbox continua recebendo do jeito de sempre, e esta leitura é assunto de outra issue. Instalações atualizadas não mudam nada sozinhas — quem já tem número pareado continua com o que tem, porque a opção nasce desligada e só uma conexão ligada por quem opera pede o acervo.

Contribuição de @webtecnica (#999).
