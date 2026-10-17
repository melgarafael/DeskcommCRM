---
impacto: capacidade_nova
secao: adicionado
titulo: Campo personalizado do tipo lista pesquisável
---

Os campos do funil ganham o tipo "lista pesquisável", para listas longas como destino, cidade ou especialidade, que antes viravam texto livre com seis grafias diferentes. Na ficha do negócio, a pessoa digita e escolhe uma opção; a busca ignora maiúsculas, acento e espaço, e casa também por apelido ("mcz" acha "Maceió (AL)"). O que é gravado é sempre o valor padrão da opção (`maceio-al`), nunca a grafia digitada, então filtros e relatórios voltam a bater. Um valor que não está na lista é recusado na ficha, com um aviso, a menos que o funil tenha ligado "permitir valor novo". As opções podem ser importadas em lote por CSV, uma por linha no formato `value,label,apelidos` (apelidos separados por `;`), sem duplicar o que já existe; editar a lista à mão depois preserva o valor e os apelidos de cada opção importada. Por enquanto a regra vale na ficha; agente, MCP e API ainda gravam o valor como vier. Nenhuma mudança de banco.

Contribuição de @webtecnica (refs #2521).
