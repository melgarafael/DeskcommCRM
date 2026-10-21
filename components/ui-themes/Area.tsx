"use client";
import { type ReactNode, type ComponentPropsWithRef } from "react";
import type { UiAreaContract, UiLayout } from "@/lib/ui-themes/contracts";
import { regionClassName, resolveUiArea } from "@/lib/ui-themes/resolve";
import { useUiTheme } from "./Provider";
type HostDivProps = Omit<ComponentPropsWithRef<"div">, "children" | "dangerouslySetInnerHTML"> & {
  [attribute: `data-${string}`]: string | number | boolean | null | undefined;
};

/** Missing or invalid contribution returns the host's complete original composition. */
export function UiThemeArea({
  contract,
  slots,
  fallback,
  rootProps,
  slotProps,
  after,
}: {
  contract: UiAreaContract;
  slots: Readonly<Record<string, ReactNode>>;
  fallback: ReactNode;
  /** Host-owned measurement, realtime attributes and input handlers stay on the layout root. */
  rootProps?: HostDivProps;
  slotProps?: Readonly<Record<string, HostDivProps>>;
  after?: ReactNode;
}) {
  const theme = useUiTheme();
  const contribution = resolveUiArea(theme, contract);
  if (!contribution) return fallback;
  if (!contribution.layout)
    return (
      <div
        data-ui-area={contract.id}
        className={contribution.className}
        style={{ display: "contents" }}
      >
        {fallback}
      </div>
    );
  if (contract.required.some((name) => !Object.hasOwn(slots, name))) return fallback;
  function allSlotsAvailable(node: UiLayout): boolean {
    return node.type === "slot"
      ? Object.hasOwn(slots, node.name)
      : node.children.every(allSlotsAvailable);
  }
  if (!allSlotsAvailable(contribution.layout)) return fallback;
  function render(node: UiLayout, key: string): ReactNode {
    if (node.type === "slot")
      return (
        <div
          {...(key === "root" ? rootProps : {})}
          {...slotProps?.[node.name]}
          key={key}
          data-ui-area={key === "root" ? contract.id : undefined}
          data-ui-region={node.name}
          className={[
            node.className,
            regionClassName(theme, contract, node.name),
            slotProps?.[node.name]?.className,
            key === "root" ? contribution?.className : undefined,
            key === "root" ? rootProps?.className : undefined,
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {slots[node.name]}
          {key === "root" ? after : null}
        </div>
      );
    return (
      <div
        {...(key === "root" ? rootProps : {})}
        key={key}
        data-ui-area={key === "root" ? contract.id : undefined}
        className={[
          node.type === "row"
            ? "flex min-w-0"
            : node.type === "stack"
              ? "flex min-h-0 flex-col"
              : "grid min-h-0 min-w-0",
          node.className,
          key === "root" ? contribution?.className : undefined,
          key === "root" ? rootProps?.className : undefined,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {node.children.map((child, index) => render(child, `${key}-${index}`))}
        {key === "root" ? after : null}
      </div>
    );
  }
  return render(contribution.layout, "root");
}
export function useUiThemeArea(contract: UiAreaContract) {
  const theme = useUiTheme();
  return {
    contribution: resolveUiArea(theme, contract),
    values: theme.values,
    regionClass: (name: string) => regionClassName(theme, contract, name),
  };
}
