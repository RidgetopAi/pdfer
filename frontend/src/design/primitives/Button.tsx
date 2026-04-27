import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";

type Variant = "default" | "primary" | "approve" | "reject" | "ghost";
type Size = "default" | "mini";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
}

export function Button({
  variant = "default",
  size = "default",
  icon,
  children,
  className,
  ...rest
}: ButtonProps) {
  const cls = [
    styles.btn,
    variant !== "default" ? styles[variant] : "",
    size === "mini" ? styles.mini : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button className={cls} {...rest}>
      {icon}
      {children}
    </button>
  );
}
