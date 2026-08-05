import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

export type AcademicTermSectionProps = {
  id: string;
  label: ReactNode;
  headingLevel?: "h2" | "h3" | "h4";
  metrics?: ReactNode;
  derivedLabel: string;
  includesSummerLabel?: string;
  includesSummer?: boolean;
  action?: ReactNode;
  children: ReactNode;
};

export function AcademicTermSection({
  id, label, headingLevel: Tag = "h2", metrics, derivedLabel,
  includesSummerLabel, includesSummer, action, children,
}: AcademicTermSectionProps) {
  return (
    <section aria-labelledby={id} data-testid="term-summary" className="space-y-2">
      <header data-testid="academic-term-header" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-border py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Tag id={id} className="text-base font-semibold">{label}</Tag>
          {includesSummer && includesSummerLabel ? <Badge className="border border-border bg-background text-foreground">{includesSummerLabel}</Badge> : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Badge className="border border-border bg-muted text-foreground" title={derivedLabel}>{derivedLabel}</Badge>
          {metrics}
        </div>
        {action ? <div className="ml-auto">{action}</div> : null}
      </header>
      {children}
    </section>
  );
}
