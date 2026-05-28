type Variant = "green" | "red" | "yellow" | "gray" | "blue" | "amber" | "purple" | "cyan";

const styles: Record<Variant, string> = {
  green: "bg-green-100 text-green-800",
  red: "bg-red-100 text-red-800",
  yellow: "bg-yellow-100 text-yellow-800",
  gray: "bg-gray-100 text-gray-800",
  blue: "bg-blue-100 text-blue-800",
  amber: "bg-amber-100 text-amber-800",
  purple: "bg-purple-100 text-purple-800",
  cyan: "bg-cyan-100 text-cyan-800",
};

export function Badge({ variant, color, children }: { variant?: Variant; color?: string; children: React.ReactNode }) {
  const v = (variant || color || "gray") as Variant;
  const style = styles[v] || styles.gray;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}>
      {children}
    </span>
  );
}
