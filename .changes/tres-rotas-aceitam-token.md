---
impacto: capacidade_nova
secao: corrigido
titulo: Três rotas que já aceitavam token de integração deixam de ser recusadas antes de chegar a ela
---

Atualizar as fontes de um serviço da agenda, marcar como usado um rascunho sugerido e anexar arquivo a uma
nota interna agora funcionam com o token de integração (`dsk_…`), como as rotas irmãs. Antes, a borda do
sistema recusava o token com 401, embora a rota estivesse pronta para ele. Uma verificação automática passa
a reprovar toda rota que aceite token sem ter a porta aberta na borda. Crédito: @paulolimajr77.
