---
impacto: nada_mudou
secao: corrigido
titulo: A catraca do host da Graph passa a reconhecer as formas em que ele é escrito à mão
---

O host da Graph já tinha um lugar só no código, e uma catraca que reprovava o literal em qualquer outro arquivo de produção — mas ela reconhecia uma forma só: `https://` logo depois de uma aspa. As outras duas formas do mesmo endereço passavam verdes, e são justamente as que o código escreve: o endereço protocolo-relativo, que é como um template monta a URL quando o esquema vem de variável, e o host sozinho numa string, que é a forma de allowlist e de comparação de `hostname`. A varredura também não olhava `components/`, `hooks/`, `workers/` nem os `.mjs` de `scripts/`.

Agora ela olha o domínio, e não a URL inteira, e separa código de comentário pelo parser do TypeScript — comentário que cita o endereço continua sem reprovar, e JSDoc deixou de ser falso positivo. A varredura cobre as seis raízes de produção e os `.mjs`. A régua da versão passou a usar a mesma função de "tirar comentário", em vez de manter a sua cópia. Nenhuma mudança de comportamento para quem usa: é cerca de teste. Nada a fazer na VPS.
