---
impacto: capacidade_nova
secao: adicionado
titulo: A fila ganha cor, e o card do setor mostra (e edita) quem atende nela
---

A aba **Setores** cadastrava nome e descrição, e o número de atendentes era um contador mudo: para descobrir quem estava numa fila era preciso ir à aba Atendimento, e para tirar alguém dela era preciso editar a pessoa inteira — sem ver as outras filas que ela atende.

Agora cada setor tem **cor** e um **card com os membros**:

- a cor sai da mesma paleta medida das etiquetas (oito tons, separados a olho nu e sob daltonismo) e o texto do chip é escolhido pela régua de contraste do produto — nunca por quem pinta;
- **setor sem cor continua idêntico ao que era**: a cor é opcional, e "sem cor" apaga a escolha em vez de inventar um padrão;
- dentro do card aparecem os nomes de quem atende aquela fila, com **remover** ao lado de cada um e **“+ Adicionar pessoa”** para incluir alguém que ainda não está nela;
- adicionar e remover mexem só naquela fila: as outras filas da pessoa ficam como estão.

A escrita continua sendo a rota que já existia (`PUT /api/v1/attendants/sector/{user_id}`), que exige gerente ou administrador — quem não gerencia a equipe vê a lista, mas não muda nada.

Contribuição de @webtecnica (#3876).
