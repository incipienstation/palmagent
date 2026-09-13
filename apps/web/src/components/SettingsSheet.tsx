import { type ReactNode, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "../api";
import type { ConnState } from "../hooks/useInbox";
import { useOutputMode, type OutputMode } from "../OutputModeProvider";
import { useTheme, type Theme } from "../ThemeProvider";
import { PushToggle } from "./PushToggle";
import { UpdateSettings } from "./UpdateSettings";

async function signOut() {
  try {
    await api.auth.logout();
  } finally {
    // Reload from the cached shell; AuthGate re-checks /api/auth/me → login screen.
    window.location.reload();
  }
}

// The single overflow surface for the root screens: collapses the 4 old Inbox
// header buttons + ConnPill into one gear. Opened from AppBar's gear button
// (passed as `children`, used as the SheetTrigger).
export function SettingsSheet({ children, conn }: { children: ReactNode; conn?: ConnState }) {
  const { theme, setTheme } = useTheme();
  const { mode, setMode } = useOutputMode();
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent className="max-h-[90dvh]">
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription className="sr-only">App preferences and account</SheetDescription>
        </SheetHeader>

        <div data-slot="settings-scroll" className="flex min-h-0 flex-col overflow-y-auto overscroll-contain px-4 pb-2">
          {/* Appearance — the theme toggle's home. */}
          <SettingRow label="Appearance">
            <ToggleGroup
              type="single"
              value={theme}
              // Keep the Radix Select-style "" guard: ignore the empty-string
              // deselect so a segment is always active.
              onValueChange={(v) => v && setTheme(v as Theme)}
              className="w-auto"
            >
              <ToggleGroupItem value="system" aria-label="System theme" className="gap-1.5 px-3">
                <Monitor className="size-4" />
                System
              </ToggleGroupItem>
              <ToggleGroupItem value="light" aria-label="Light theme" className="gap-1.5 px-3">
                <Sun className="size-4" />
                Light
              </ToggleGroupItem>
              <ToggleGroupItem value="dark" aria-label="Dark theme" className="gap-1.5 px-3">
                <Moon className="size-4" />
                Dark
              </ToggleGroupItem>
            </ToggleGroup>
          </SettingRow>

          <Separator />

          {/* Output detail — how much agent machinery (tool calls/results/status)
              the event log shows. Prose, questions, result + errors always show. */}
          <SettingRow label="Detail">
            <ToggleGroup
              type="single"
              value={mode}
              // Same empty-string deselect guard as Appearance: keep one active.
              onValueChange={(v) => v && setMode(v as OutputMode)}
              className="w-auto"
            >
              <ToggleGroupItem value="compact" aria-label="Compact output" className="px-3">
                Compact
              </ToggleGroupItem>
              <ToggleGroupItem value="default" aria-label="Default output" className="px-3">
                Default
              </ToggleGroupItem>
              <ToggleGroupItem value="verbose" aria-label="Verbose output" className="px-3">
                Verbose
              </ToggleGroupItem>
            </ToggleGroup>
          </SettingRow>

          <Separator />

          {/* Notifications — PushToggle as a full-width Switch row. */}
          <PushToggle />

          <Separator />

          {/* Connection — read-only SSE state. */}
          {conn && (
            <>
              <div className="flex min-h-[44px] items-center justify-between gap-3 py-2">
                <span className="text-[15px] text-foreground">Connection</span>
                <ConnLabel conn={conn} />
              </div>
              <Separator />
            </>
          )}

          {open && <UpdateSettings />}
          <Separator />

          {/* Account — sign out, behind an AlertDialog confirm. */}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button
                type="button"
                aria-label="Sign out"
                className="flex min-h-[44px] items-center py-2 text-left text-[15px] font-medium text-destructive outline-none active:opacity-70"
              >
                Sign out
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Sign out?</AlertDialogTitle>
                <AlertDialogDescription>
                  You'll need your passkey to sign back in on this device.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogAction onClick={signOut}>Sign out</AlertDialogAction>
                <AlertDialogCancel>Stay</AlertDialogCancel>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[44px] flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2">
      <span className="text-[15px] text-foreground">{label}</span>
      {children}
    </div>
  );
}

function ConnLabel({ conn }: { conn: ConnState }) {
  const label = conn === "open" ? "live" : conn === "connecting" ? "connecting…" : "reconnecting…";
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <span
        className={
          conn === "open"
            ? "size-2 rounded-full bg-live"
            : conn === "reconnecting"
              ? "size-2 animate-pulse rounded-full bg-amber"
              : "size-2 rounded-full bg-faint"
        }
      />
      {label}
    </span>
  );
}
