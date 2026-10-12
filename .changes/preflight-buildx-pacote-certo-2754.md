---
impacto: nada_mudou
secao: corrigido
titulo: O aviso de buildx ausente do update manda instalar o pacote que esta VPS tem
---

Quando o plugin buildx do Docker falta, a atualização para antes de mexer em qualquer coisa e explica o motivo. Até aqui ela mandava instalar sempre o pacote `docker-buildx-plugin`, que só existe no repositório oficial do Docker. Numa VPS com o Docker do próprio Ubuntu, o apt respondia que o pacote não existe. Agora o aviso consulta o índice do apt desta VPS e cita o nome que ela encontra: `docker-buildx-plugin` quando o repositório do Docker está ligado, `docker-buildx` quando só o Ubuntu oferece o plugin. Sem nenhum dos dois no índice, o aviso cita os dois nomes, com a origem de cada um.

Você não precisa fazer nada.

Contribuição de @webtecnica (#2763), a partir da issue #2754.
