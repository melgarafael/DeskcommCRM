---
impacto: nada_mudou     # nada_mudou | capacidade_nova | exige_acao
secao: corrigido        # adicionado | alterado | corrigido
titulo: Erro de PDF no acervo de conhecimento para de acusar o arquivo errado
---

Toda falha ao ler um PDF no acervo de conhecimento — qualquer uma —
aparecia como "Se ele for só imagens escaneadas, não há letra nenhuma
para ler", mesmo quando o PDF tinha texto selecionável e o problema era
outro (por exemplo, uma dependência nativa ausente na instalação). A
mensagem específica que `extractPdfText` já produzia para cada causa
era descartada e trocada por essa frase única em
`lib/ai/rag/ingest/documento.ts`, então quem enviava um PDF perfeitamente
legível recebia uma explicação que apontava para o próprio arquivo como
culpado. Agora a causa relatada é a causa real.
