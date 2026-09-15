---
impacto: capacidade_nova
secao: adicionado
titulo: O canal oficial passa a registrar o próprio webhook na Meta
---
Conectar o canal oficial deixava metade do caminho para o operador: o CRM gravava a credencial validada e o canal ficava ENVIANDO e sem RECEBER até alguém abrir o painel da Meta, colar a URL de callback e marcar os campos — por número, e sem que a tela do CRM dissesse isso em lugar algum. Quem não sabia não via erro nenhum: as respostas do cliente simplesmente não chegavam e a janela de 24 horas nunca abria. Agora, ao conectar, a instalação inscreve o app na WABA e aponta o webhook daquele número para o endereço dela mesma (a inscrição primeiro: sem ela a Meta não entrega nada), guardando o desfecho na sessão — a tela mostra "webhook pendente" com o motivo que a Meta deu e um botão de tentar de novo, sem desconectar e reconectar o canal. Falhar nesse passo NÃO desfaz a conexão: o canal continua enviando, e o que falta é a entrega. O par número/WABA passa a ser conferido junto da credencial (número de uma conta com id de outra gravava uma sessão que envia e cujo webhook nunca chega), e o endereço público da instalação, que era calculado em três rotas com o mesmo código, passa a ter um dono só.

Crédito: @webtecnica.
