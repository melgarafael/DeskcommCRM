---
impacto: nada_mudou
secao: corrigido
titulo: O teste do kit "instalar sem chave de IA" para de reprovar por acaso (intermitência da #1570)
---

O caso `instalar SEM chave de IA — a tela final avisa` (`hostgator-setup-kit/test-validators.sh`,
integração da #670) reprovou o `verify-parte (3)` com intermitência, no run 35948236372, com
`✗ a tela final não avisa que a IA ainda não atende` — e o mesmo SHA passou na reexecução.

A causa não era chave de IA no ambiente: o CI não exporta nenhuma, e a suíte já zera as quatro
no topo desde o #1599. Era o cano das asserções. A suíte roda com `set -o pipefail`, e as
asserções liam a saída com `printf '%s' "$saida" | grep -q '...'`. O `grep -q` sai assim que
acha a frase; se o `printf` ainda está escrevendo, ele leva SIGPIPE (status 141), o `pipefail`
derruba o pipeline e o `!` lê isso como "a frase não está lá".

Medido num `ubuntu:24.04` com bash 5.2 e 1 CPU, sobre a saída real do próprio caso: pelo cano,
taxas baixas e variáveis de falso vermelho (de 1 a 6 em 6000, conforme a asserção), todas com
status `141/0`; com here-string (`grep -q '...' <<<"$saida"`), zero em 6000.

O conserto troca as 45 asserções `printf '%s' "$var" | grep -q` do arquivo por here-string —
sem cano, não há quem leve SIGPIPE — e mantém a medição na tela final (depois de
"Instalação concluída"). Ficam também as duas melhorias do PR original: o `install.sh` desse
caso recebe as quatro chaves de IA zeradas no próprio `env` da chamada (defesa extra), e,
quando o caso reprova, ele imprime as últimas linhas da saída para o diagnóstico nascer de dado.

Refs #1570.
Contribuição de @webtecnica (#2033), construído sobre o diagnóstico e a hermetização dele.
