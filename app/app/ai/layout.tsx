import { AiSectionTabs } from "./_components/AiSectionTabs";

export default function AiLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <AiSectionTabs />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
