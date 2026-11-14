---
impacto: nada_mudou
secao: corrigido
titulo: Endereço na mensagem do Inbox vira link clicável, inclusive o www. sem protocolo
---

No Inbox o endereço mandado na conversa — orçamento, check-in, boleto, localização
do hotel — aparecia como texto comum: era preciso selecionar, copiar e colar no
navegador, enquanto no WhatsApp o mesmo endereço já é clicável. Agora `https://…`,
`www.…` e domínio solto com extensão conhecida viram link nas mensagens recebidas
e enviadas, nas legendas das mensagens com mídia, nas notas internas e na citação
de resposta. O link abre em outra aba com `rel="noopener noreferrer"`.

O link é criado por código, a partir de pedaços de texto — nada de montar HTML com
o corpo da mensagem. Só `http:` e `https:` viram âncora: `javascript:`, `data:` e
`file:` continuam texto, e o resto do corpo (espaços, quebras de linha, `<b>`)
sai exatamente como foi escrito. Contribuição de @webtecnica (#4576).
