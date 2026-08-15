import type { ReactNode } from "react";
import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTheme } from "../ThemeProvider";

// A ghost Sun/Moon toggle for the auth screens. The Settings sheet (the theme
// toggle's real home) isn't reachable before sign-in, so auth gets its own
// minimal control. Tapping flips between light and dark explicitly (resolving
// `system` to its current effective value first), so one tap always inverts the
// visible theme.
function AuthThemeToggle() {
  const { resolved, setTheme } = useTheme();
  const next = resolved === "dark" ? "light" : "dark";
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`Switch to ${next} theme`}
      onClick={() => setTheme(next)}
      className="text-faint"
    >
      {resolved === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />}
    </Button>
  );
}

// Shared layout for the passkey login / enroll screens: a centered, phone-width
// column, vertically centered and safe-area padded. Auth is the only thing
// rendered when it shows, so it owns the viewport (no tab bar / header chrome) —
// a top-right ghost theme toggle is the only chrome. The viewport-lock contract
// holds: this fills 100dvh, the document never scrolls.
export function AuthScreen({
  icon,
  title,
  subtitle,
  children,
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="relative flex h-app flex-col bg-background pt-[var(--safe-top)] pb-[calc(24px+var(--safe-bottom))]">
      <div className="absolute end-2 top-[calc(8px+var(--safe-top))]">
        <AuthThemeToggle />
      </div>
      <div className="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center px-6">
        <div className="mb-8 flex flex-col items-center text-center">
          {icon && (
            <div className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              {icon}
            </div>
          )}
          <h1 className="text-[22px] leading-7 font-semibold text-strong">{title}</h1>
          {subtitle && <p className="mt-2 text-[15px] leading-[22px] text-muted-foreground">{subtitle}</p>}
        </div>
        <div className="flex flex-col gap-3">{children}</div>
      </div>
    </div>
  );
}

// Turn a WebAuthn / API failure into a short, human message for the auth screens.
export function authErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "NotAllowedError") return "Cancelled or timed out — try again.";
    if (e.name === "InvalidStateError") return "This device already has a passkey for this app.";
    return e.message || "Something went wrong.";
  }
  return "Something went wrong.";
}
