---
impacto: nada_mudou
secao: corrigido
titulo: O teto de tamanho dos uploads vale também para envio sem tamanho declarado
---

As rotas que recebem arquivo (mídia de conversa e de nota, fotos e áudio do
catálogo, mídia de resposta rápida, sons dos avisos, logo, anexo de negócio,
material do agente e as importações de planilha, skill, fluxo, modelo de
proposta e respostas rápidas) passam a ler o corpo por um único caminho, que
conta os bytes enquanto lê e para no primeiro byte além do teto (413). Envio
sem `Content-Length` (em partes, atrás de proxy, HTTP/2) segue aceito, com o
teto garantido pela contagem; `Content-Length` inválido responde 400.

Nada muda para quem usa pelas telas: navegador e `curl -F` sempre declaram o
tamanho. A importação de planilha da prospecção passa a responder 413, em vez
de 422, quando o envio declarado passa do teto.
