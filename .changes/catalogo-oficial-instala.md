---
impacto: nada_mudou
secao: corrigido
titulo: Instalar uma extensão do catálogo oficial volta a funcionar
---

Quem administra a instalação não conseguia instalar nenhuma das extensões do catálogo oficial: o pedido falhava com "pacote adulterado" e deixava a preparação pendurada na tela, mesmo com o arquivo intacto. A causa estava na conferência final, que comparava o pacote com a entrada do catálogo exigindo que tudo o que sobra de um lado existisse no outro — e a entrada do catálogo ganhou, numa versão anterior, cinco informações que são só de vitrine (nome de exibição do autor, site, repositório, etiquetas e data de publicação). O pacote nunca pode trazê-las, então a comparação dava diferença em toda instalação.

Agora a conferência compara exatamente as informações que o catálogo anuncia sobre o pacote — autor, nome, versão, licença, compatibilidade, apresentação e permissões. Informação nova de vitrine deixa de impedir a instalação, e a proteção continua a mesma: pacote cujo autor, versão ou permissões não batem com o que o catálogo anuncia continua recusado, e nada além das treze informações previstas é aceito dentro do pacote.

Não exige nenhuma ação no servidor. Preparações que ficaram paradas podem ser retomadas ou canceladas na própria tela.
