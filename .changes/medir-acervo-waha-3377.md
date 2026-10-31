---
impacto: nada_mudou
secao: adicionado
titulo: "Medição do acervo do WhatsApp: memória e disco com histórico grande"
---

Script `scripts/medir-acervo-waha.ts` (`pnpm medir:acervo-waha`) mede, só
lendo, a memória do contêiner do WAHA, o tamanho do diretório do store, o
número de sessões e de mensagens guardadas, e o crescimento por 1000
mensagens. Consulta que falha não vira contagem zero: o programa sai com
erro e diz o que não mediu. O doc `docs/medir-acervo-waha.md` traz a receita
que roda numa VPS do kit e o que a medida significa para os `mem_limit` do
compose (1280m do `waha`; 768m do `app`, onde roda o importe do histórico).
Nenhuma medição real foi inventada: a tabela do doc segue vazia até alguém
rodar a receita numa instalação com histórico.

Crédito: @webtecnica.
