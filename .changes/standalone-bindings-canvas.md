---
impacto: correcao
secao: corrigido
titulo: A imagem conserva os bindings instalados do canvas no standalone
---
A cópia do pdfjs passa a conservar também os alvos dos links pnpm do canvas e dos seus bindings opcionais instalados no estágio Linux. Evita um pacote visível pelo nome mas quebrado ao resolver a dependência nativa. Não altera arquitetura, lockfile ou toolchain. Crédito: @vagnerrm122.
