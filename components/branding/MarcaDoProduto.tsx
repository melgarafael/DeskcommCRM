import { cn } from "@/lib/utils";

type Props = {
  readonly nome: string;
  readonly className?: string;
  readonly decorativo?: boolean;
};

function Marca({ nome, className, decorativo = false, simbolo }: Props & { simbolo: boolean }) {
  return (
    <svg
      viewBox={simbolo ? "790 390 340 305" : "330 350 1116 350"}
      className={cn("shrink-0", className)}
      {...(decorativo ? { "aria-hidden": true } : { role: "img", "aria-label": nome })}
    >
      <image href={simbolo ? "/gianna/simbolo.png" : "/gianna/logo.png"} width="1920" height="1080" />
    </svg>
  );
}

export function SimboloDoProduto(props: Props) {
  return <Marca {...props} simbolo />;
}

export function LogotipoDoProduto(props: Props) {
  return <Marca {...props} simbolo={false} />;
}
