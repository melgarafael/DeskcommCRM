---
impacto: nada_mudou
secao: corrigido
titulo: Ensaio do agente deixa de devolver página 404
---

O botão Executar teste chamava uma rota que o App Router não registrava
(pasta `test`) e mostrava HTML no aviso vermelho. O ensaio passou a
`/dry-run`, um clique dispara no máximo um POST, e erro que não é JSON
vira uma frase curta — sem página HTML, sem nova chamada à IA. Um
catch-all em `/api/[...naoEncontrado]` chegou a responder o POST de
ensaio com 404 JSON; foi removido.
