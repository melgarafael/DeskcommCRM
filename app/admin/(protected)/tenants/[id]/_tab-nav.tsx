"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/hooks/i18n/useT";

interface TabItem {
  label: string;
  href: string;
  disabled: boolean;
}

interface TabNavProps {
  basePath: string;
  tabs: TabItem[];
}

export function TabNav({ basePath, tabs }: TabNavProps) {
  const t = useT();
  const pathname = usePathname();

  return (
    <div className="flex gap-0 border-b">
      {tabs.map((tab) => {
        const href = basePath + tab.href;
        // Overview matches exactly; others match as prefix
        const isActive = tab.href === ""
          ? pathname === basePath || pathname === basePath + "/"
          : pathname.startsWith(href);

        return (
          <Link
            key={tab.label}
            href={tab.disabled ? "#" : href}
            aria-disabled={tab.disabled}
            className={[
              "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              tab.disabled
                ? "cursor-not-allowed text-muted-foreground border-transparent"
                : isActive
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/40",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {t(tab.label)}
            {tab.disabled && (
              <span className="ml-1.5 text-[10px] font-normal opacity-60">
                {t("em breve")}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
