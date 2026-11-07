---
impacto: capacidade_nova
secao: adicionado
titulo: Automação por comentário no Instagram com palavra-chave
---

Antes, o comentário de um post não entrava no CRM: o webhook do canal social só lia evento de mensagem, e o comentário era descartado com resposta 200 — nenhuma automação podia disparar por ele.

Agora o comentário é gravado (post, autor, texto, contato) e nasce o gatilho **Comentou uma palavra-chave num post do Instagram**. A regra escolhe os posts (vazio = qualquer post do perfil) e as palavras-chave; acento e maiúscula não importam. No resto ela é uma automação comum: manda mensagem, aplica etiqueta, move no funil — as ações que já existiam.

O mesmo comentário entregue duas vezes pelo provedor não dispara duas vezes, e comentário do próprio perfil é ignorado.
