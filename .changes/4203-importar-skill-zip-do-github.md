---
impacto: nada_mudou
secao: corrigido
titulo: Importar skill aceita o .zip baixado do GitHub, que vem embrulhado numa pasta
---

O "Download ZIP" do GitHub põe tudo dentro de uma pasta, e a importação recusava
o pacote dizendo que faltava o SKILL.md na raiz, mesmo com o arquivo lá. Agora a
pasta de topo é reconhecida como a raiz do pacote quando é a única com SKILL.md.
Se houver mais de uma, a importação segue recusando e diz quais achou.
Contribuição de @webtecnica.
