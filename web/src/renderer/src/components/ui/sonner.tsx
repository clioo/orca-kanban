// MIT Copyright (c) 2026 Lovecast Inc. Ported from Orca's
// src/renderer/src/components/ui/sonner.tsx (theme-aware Toaster with the
// source's position, offsets, icons and CSS variables; adapter: this repo
// has no zustand app store, so the theme is read from the `.dark` class
// that App's applyThemeToRoot toggles on documentElement, observed for
// live theme switches).
import { useSyncExternalStore } from "react";
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

function getThemeSnapshot(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

function subscribeThemeChange(notify: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

const Toaster = ({ ...props }: ToasterProps) => {
  const dark = useSyncExternalStore(
    subscribeThemeChange,
    getThemeSnapshot,
    () => false,
  );

  return (
    <Sonner
      theme={dark ? "dark" : "light"}
      position="bottom-right"
      // Why: Orca has persistent bottom chrome, so bottom-right toasts need
      // breathing room above the status bar instead of sitting on its edge.
      // mobileOffset keeps that clearance below Sonner's 600px breakpoint
      // (narrow/resized windows and the web client), which otherwise reverts
      // to Sonner's default 16px and lets toasts crowd the status bar again.
      offset={{ bottom: "calc(2.5rem + env(safe-area-inset-bottom, 0px))" }}
      mobileOffset={{
        bottom: "calc(2.5rem + env(safe-area-inset-bottom, 0px))",
      }}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          "--width": "min(26rem, calc(100vw - 2rem))",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
