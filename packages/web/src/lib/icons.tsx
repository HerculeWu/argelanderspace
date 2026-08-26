import { icons, type LucideProps } from "lucide-react";

// The ArgelanderSpace design references icons by lucide's kebab-case name
// (e.g. "panel-left-open"). lucide-react exports them PascalCased, so we
// translate once here and keep the design's ergonomic `<Icon name=… />` API.
function toPascal(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join("");
}

export function Icon({
  name,
  cls = "ico",
  ...rest
}: { name: string; cls?: string } & Omit<LucideProps, "ref">) {
  const Cmp = (icons as Record<string, React.ComponentType<LucideProps>>)[toPascal(name)] || icons.Circle;
  // size/stroke are driven by the .ico/.ico-sm/.ico-lg CSS classes, matching
  // the design system; we only pass the class through.
  return <Cmp className={cls} {...rest} />;
}
