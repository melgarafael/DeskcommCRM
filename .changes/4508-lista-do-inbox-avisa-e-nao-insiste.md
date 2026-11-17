---
impacto: nada_mudou
secao: corrigido
titulo: Inbox avisa quando a lista não pôde ser atualizada e não insiste sozinho contra a API fora
---

No Inbox, quando a API REST demora ou falha, a lista de conversas que já estava na tela continua ali — e agora há um aviso fixo no topo dizendo qual foi a falha (tempo esgotado, servidor fora, sessão expirada) e que as conversas seguem salvas, com o botão "Tentar novamente" que relê sem recarregar a página. Antes, uma falha depois da lista carregada deixava as conversas na tela sem nenhum aviso, e a única pista era um toast que sumia.

A caixa vazia só aparece quando a leitura respondeu e não há conversa nenhuma: se a resposta anterior era vazia e a seguinte falhou, a tela diz que não conseguiu ler — não afirma que não há conversas.

Com a API fora, a conferência automática da lista passa a esperar cada vez mais entre uma tentativa e a seguinte (45 s, 90 s, 180 s e até 5 min), em vez de bater a cada 45 s para sempre, e não abre uma nova enquanto a anterior não voltou.
