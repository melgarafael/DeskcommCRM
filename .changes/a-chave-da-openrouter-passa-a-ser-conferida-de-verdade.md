---
impacto: nada_mudou
secao: corrigido
titulo: A chave da OpenRouter passa a ser conferida de verdade antes de a tela dizer que está validada
---

Ao cadastrar uma chave da OpenRouter em **Agente de IA › Credenciais**, o sistema conferia
a chave contra o catálogo de modelos do provedor — um endereço que responde a
qualquer um, com chave errada ou sem chave nenhuma. Na prática, qualquer texto
colado ali era gravado como credencial validada, e o cartão passava a mostrar
"Validada" com o final da chave ao lado.

O erro só aparecia depois, na primeira mensagem que o agente tentava responder,
e aparecia como "User not found." — um texto que não fala em chave nem em
credencial. Quem procurava a causa olhava o modelo, o provedor, o próprio
atendimento; a tela, enquanto isso, afirmava que a peça quebrada estava boa.

Agora a prova é feita contra o endereço que exige a credencial. O catálogo
continua sendo lido em seguida, porque é dele que sai a lista de modelos que a
tela mostra — ali ele é dado, não prova. E catálogo fora do ar não recusa mais
uma chave que já provou ser válida: seria trocar um erro de credencial por um de
indisponibilidade, e mandar quem opera caçar defeito na chave certa.

Uma ressalva sobre em que versão isto entrou: a correção já está no ar desde a
**1.13.0**. O que chega atrasado é esta nota — a mudança foi publicada sem ela,
e por isso não apareceu na lista daquela versão.

Chave boa continua sendo aceita do mesmo jeito, e não há passo de atualização.
A única coisa que vale conferir é o que foi cadastrado antes: se a sua chave da
OpenRouter é anterior à 1.13.0 e o atendimento falha sem motivo aparente, abra
**Agente de IA › Credenciais** e use o botão de revalidar — as setas em círculo, no
cartão da credencial. A resposta que ele dá agora é real.

Isto veio da contribuição de **@Elevstudio-Dev**.
