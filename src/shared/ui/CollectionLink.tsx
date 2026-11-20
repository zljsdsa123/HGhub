import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";
import { IChevR } from "./icons";
import { Button } from "./ios/controls";

type CollectionLinkProps = Omit<ComponentProps<typeof Button>, "children" | "title"> & {
  icon: ReactNode;
  title: string;
};

/** Shared shortcut card; text may wrap without changing the column widths. */
export function CollectionLink({ icon, title, className, ...props }: CollectionLinkProps) {
  return <Button {...props} aria-label={props["aria-label"] ?? title}
    className={cn("ios-collection-link flex w-full min-w-0 min-h-[60px] items-center gap-3 px-3.5 py-3 text-left pressable", className)}>
    <span aria-hidden="true" className="ios-collection-icon w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0">{icon}</span>
    <span className="ios-collection-copy flex-1 min-w-0 flex items-center [overflow-wrap:anywhere]">
      <span className="ios-collection-title block text-[14.5px] font-semibold leading-snug text-on">{title}</span>
    </span>
    <IChevR aria-hidden="true" size={15} className="ios-collection-chevron text-mut shrink-0" />
  </Button>;
}

export function CollectionLinks({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("ios-collection-links grid grid-cols-2 gap-2.5 min-w-0", className)}>{children}</div>;
}
