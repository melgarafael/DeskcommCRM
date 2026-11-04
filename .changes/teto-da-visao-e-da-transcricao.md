---
impacto: nada_mudou
secao: corrigido
titulo: Descrição de foto e transcrição pelo modelo da organização não são mais recusadas por crédito baixo na OpenRouter
---

A descrição de foto e a transcrição de áudio pelo modelo da organização passam a pedir um teto de resposta. A descrição usa o mesmo teto das respostas do agente: o que a organização configurou ou, sem configuração, 4096 tokens. A transcrição usa 8192 tokens. Sem esse teto, uma chave da OpenRouter com pouco crédito recusava a chamada.

A ferramenta de rascunho de proposta (`crm_draft_proposal`) deixa de responder "a mensagem ainda está sendo transcrita" para foto ou figurinha cuja leitura já terminou sem texto.
