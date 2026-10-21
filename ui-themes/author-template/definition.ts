import { uiThemePackageSchema } from "@/lib/ui-themes/contracts";
import styles from "./theme.module.css";

/** Copy this directory under your own id. This example is not an installed catalog entry. */
export const exampleTheme = uiThemePackageSchema.parse({
  apiVersion: 1,
  id: "author-example",
  title: "Exemplo de autoria",
  description:
    "Uma variação didática de tipografia que herda os componentes e a composição do host.",
  version: "1.0.0",
  optionsVersion: 1,
  options: [
    {
      key: "global.heading",
      label: "Destaque dos títulos",
      type: "enum",
      default: "regular",
      choices: [
        { value: "regular", label: "Regular" },
        { value: "emphasis", label: "Ênfase" },
      ],
    },
  ],
  areas: {
    inbox: {
      contractVersion: 1,
      configuration: {},
      regions: {
        header: {
          className: styles.header,
          variants: { "global.heading": { regular: styles.regular, emphasis: styles.emphasis } },
        },
      },
    },
  },
});
