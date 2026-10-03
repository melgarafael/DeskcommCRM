---
impacto: nada_mudou
secao: corrigido
titulo: Fonte de captação com assinatura só aceita envio que ela consegue conferir
---

Uma fonte de captação com assinatura (HMAC) ligada passa a recusar todo envio
sempre que o segredo dela não puder ser lido nesta instalação — por exemplo,
depois de uma troca da chave de cifra do servidor. Nenhum lead entra por uma
fonte que exige assinatura sem que a assinatura tenha sido conferida.

Se isso acontecer, a tela "Leads recebidos" mostra o envio como "Não entrou",
com o motivo "O segredo de assinatura desta fonte não pôde ser lido nesta
instalação". O caminho é gerar a assinatura de novo no painel da fonte e
atualizar quem envia os dados. Em instalações que nunca trocaram a chave, nada
muda e não é preciso fazer nada.
