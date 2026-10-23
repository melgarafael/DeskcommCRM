# Receita "Conteúdo do WordPress" pela tela — instalação de teste (21/10/2026)

**Tipo:** HISTÓRICA (captura pela tela com Playwright, recortada na área da funcionalidade).

**Contra qual código:** imagem construída a partir do head `6b609f66a` desta branch (a R2 com a `main` da época mesclada), rodando numa VPS com o `baseline.sql` desse commit. Banco do outro lado: um WordPress de teste (MySQL 8) com ACF e JetEngine, dados fictícios — imóveis do ACF (tipo `imovel`), imóveis do JetEngine no modo padrão (tipo `imovel_jet`) e veículos do ACF (tipo `veiculo`), cada um com taxonomias de verdade (bairro/cidade hierárquicos, tipo, finalidade, marca, combustível).

| Arquivo | O que prova |
|---|---|
| `01-previa-imoveis-acf.png` | Modelo "Imóveis" aplicado com um clique; a prévia traz 5 imóveis do ACF com bairro, cidade, tipo e finalidade vindos das CATEGORIAS do WordPress. |
| `02-previa-imoveis-jetengine.png` | A mesma receita lê o JetEngine (modo padrão): só o tipo de post e os nomes das categorias trocados na tela. Os imóveis marcados como vendidos ficam de fora. |
| `03-previa-veiculos-montada-a-mao.png` | Outro nicho, montado à mão (Em branco): 4 veículos — exatamente os publicados e disponíveis no banco; o rascunho e o vendido não aparecem. |

**Não medido pela tela:** o agente consultando a receita numa conversa (a ferramenta usa a mesma montagem da prévia, coberta pelo teste contra MySQL 8 de `tests/mysql/receita-wordpress-conteudo.test.ts`).
