---
impacto: nada_mudou
secao: corrigido
titulo: A faixa vazia embaixo do conteúdo sai quando a barra de abas do celular é escondida
---
Quem estreita a janela num celular e depois a alarga sem recarregar a página — celular girado para paisagem, painel lateral do navegador aberto ou modo responsivo do navegador — passa a ter o rodapé de volta ao normal. Antes, a barra de abas que o CSS esconde acima de 768px continuava sendo descontada do fim de toda tela: sobravam 54 px vazios embaixo do conteúdo, e no Inbox e no funil as caixas encolhiam junto. Agora a medição da peça que sai de vista volta a zero, e a faixa reservada volta ao piso de 24 px. Em tela de celular nada muda: a barra continua reservando o que ela mede. Nada a fazer na atualização.
