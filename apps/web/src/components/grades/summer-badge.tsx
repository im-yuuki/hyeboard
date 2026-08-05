import { Badge } from "@/components/ui/badge";
import { useLocale } from "@/lib/i18n";

export function SummerBadge() {
  const { t } = useLocale();
  return <Badge className="shrink-0 border border-border bg-background text-foreground">{t.grades.summerTerm}</Badge>;
}
