import { useBackLayer } from "../hooks/useBackLayer";
import { useSignOut } from "../auth/useSignOut";
import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { ArrowLeft, ArrowUpCircle, ChevronRight, FolderSearch, Monitor, Moon, Sun, X } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type { ConnState } from "../hooks/useInbox";
import { useOutputMode, type OutputMode } from "../OutputModeProvider";
import { useTheme, type Theme } from "../ThemeProvider";
import { useSendShortcut } from "../SendShortcutProvider";
import { useUpdateState } from "../update-state";
import { PushToggle } from "./PushToggle";
import { UpdateSettings } from "./UpdateSettings";
import { RepoSettings } from "./RepoSettings";

const themeLabels: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };
const modeLabels: Record<OutputMode, string> = { compact: "Compact", default: "Default", verbose: "Verbose" };
const modeDescriptions: Record<OutputMode, string> = {
  compact: "Focus on answers. Keep background activity folded.",
  default: "Show answers with a short activity preview.",
  verbose: "Show all recorded activity in the conversation.",
};

// Keep panels mounted while open so navigation preserves edits and scroll positions.
export function SettingsSheet({ conn, open, onOpenChange, onCloseAutoFocus }: {
  conn?: ConnState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const { signingOut, signOut } = useSignOut();
  const { theme, setTheme } = useTheme();
  const { mode, setMode } = useOutputMode();
  const { shortcut, setShortcut } = useSendShortcut();
  const [section, setSection] = useUpdateState("settings:section", "general");
  const title = useRef<HTMLHeadingElement>(null);
  const spacesLink = useRef<HTMLButtonElement>(null);
  const updatesLink = useRef<HTMLButtonElement>(null);
  const previousSection = useRef(section);
  const appearanceId = useId();
  const detailId = useId();
  const shortcutId = useId();
  const home = section === "general";
  useBackLayer(open && !home, () => setSection("general"), 150);

  useLayoutEffect(() => {
    const previous = previousSection.current;
    previousSection.current = section;
    if (!open || previous === section) return;
    if (section === "general") {
      (previous === "spaces" ? spacesLink : updatesLink).current?.focus({ preventScroll: true });
    } else {
      title.current?.focus({ preventScroll: true });
    }
  }, [section, open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} autoFocus>
      <SheetContent className="h-[min(680px,90dvh)] max-h-[90dvh] max-w-[640px]" onCloseAutoFocus={onCloseAutoFocus}>
        <SheetHeader className="shrink-0 gap-0 px-5 pt-1 pb-4">
          <div className="flex min-h-11 items-center gap-2">
            {!home && <Button variant="ghost" size="icon-lg" aria-label="Back to settings" onClick={() => setSection("general")}>
              <ArrowLeft />
            </Button>}
            <SheetTitle asChild className="flex-1 text-[22px] tracking-tight outline-none">
              <h2 ref={title} tabIndex={-1}>{home ? "Settings" : section === "spaces" ? "Spaces" : "Updates"}</h2>
            </SheetTitle>
            <SheetClose asChild><Button variant="ghost" size="icon-lg" aria-label="Close settings"><X /></Button></SheetClose>
          </div>
          <SheetDescription className={home ? "text-[13px]" : "sr-only"}>
            {home ? "Preferences and installation" : section === "spaces" ? "Manage repository discovery on this installation." : "Manage Palmagent updates on this installation."}
          </SheetDescription>
        </SheetHeader>
        <Separator />

        <div hidden={!home} data-slot="settings-scroll" className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-5 pb-2", !home && "hidden")}>
          <div className="flex flex-col gap-6">
            <SettingsGroup label="On this device">
              <FieldGroup className="gap-0 rounded-xl border border-border bg-background/50 px-3.5">
                <Field className="gap-2.5 py-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <FieldLabel id={appearanceId} className="text-sm">Appearance</FieldLabel>
                    <span className="text-xs text-muted-foreground">{themeLabels[theme]}</span>
                  </div>
                  <ToggleGroup type="single" value={theme} aria-labelledby={appearanceId}
                    onValueChange={(value) => value && setTheme(value as Theme)}>
                    <ToggleGroupItem value="system" aria-label="System theme" className="gap-1.5"><Monitor className="size-4" />System</ToggleGroupItem>
                    <ToggleGroupItem value="light" aria-label="Light theme" className="gap-1.5"><Sun className="size-4" />Light</ToggleGroupItem>
                    <ToggleGroupItem value="dark" aria-label="Dark theme" className="gap-1.5"><Moon className="size-4" />Dark</ToggleGroupItem>
                  </ToggleGroup>
                </Field>
                <Separator />
                <Field className="gap-2.5 py-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <FieldLabel id={detailId} className="text-sm">Output detail</FieldLabel>
                    <span className="text-xs text-muted-foreground">{modeLabels[mode]}</span>
                  </div>
                  <ToggleGroup type="single" value={mode} aria-labelledby={detailId} aria-describedby={`${detailId}-description`}
                    onValueChange={(value) => value && setMode(value as OutputMode)}>
                    <ToggleGroupItem value="compact" aria-label="Compact output">Compact</ToggleGroupItem>
                    <ToggleGroupItem value="default" aria-label="Default output">Default</ToggleGroupItem>
                    <ToggleGroupItem value="verbose" aria-label="Verbose output">Verbose</ToggleGroupItem>
                  </ToggleGroup>
                  <FieldDescription id={`${detailId}-description`} className="text-xs">{modeDescriptions[mode]}</FieldDescription>
                </Field>
                <Separator />
                <Field className="gap-2.5 py-3.5">
                  <FieldLabel id={shortcutId} className="text-sm">Send message with</FieldLabel>
                  <ToggleGroup type="single" value={shortcut} aria-labelledby={shortcutId} aria-describedby={`${shortcutId}-description`}
                    onValueChange={(value) => { if (value === "enter" || value === "modifier-enter") setShortcut(value); }}>
                    <ToggleGroupItem value="enter">Enter</ToggleGroupItem>
                    <ToggleGroupItem value="modifier-enter">Cmd/Ctrl + Enter</ToggleGroupItem>
                  </ToggleGroup>
                  <FieldDescription id={`${shortcutId}-description`} className="text-xs">
                    {shortcut === "enter" ? "Shift + Enter adds a new line." : "Enter adds a new line. Cmd + Enter (Mac) or Ctrl + Enter sends."}
                  </FieldDescription>
                </Field>
                <PushToggle className="border-t border-border py-3.5" />
              </FieldGroup>
            </SettingsGroup>

            <SettingsGroup label="Installation">
              <div className="flex flex-col">
                <Button ref={spacesLink} variant="ghost" aria-label="Spaces" onClick={() => setSection("spaces")}
                  className="h-auto min-h-16 justify-start gap-3 whitespace-normal px-1 py-3 text-left hover:bg-accent">
                  <FolderSearch className="text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="text-sm font-medium">Spaces</span><span className="text-xs font-normal text-muted-foreground">Folders to search for repositories</span></span>
                  <ChevronRight className="text-muted-foreground" />
                </Button>
                <Separator />
                <Button ref={updatesLink} variant="ghost" aria-label="Updates" onClick={() => setSection("updates")}
                  className="h-auto min-h-16 justify-start gap-3 whitespace-normal px-1 py-3 text-left hover:bg-accent">
                  <ArrowUpCircle className="text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="text-sm font-medium">Updates</span><span className="text-xs font-normal text-muted-foreground">Version, channel & automatic updates</span></span>
                  <ChevronRight className="text-muted-foreground" />
                </Button>
                {conn && <>
                  <Separator />
                  <div className="flex min-h-11 items-center justify-between gap-3 px-1 py-2">
                    <span className="text-xs text-muted-foreground">Server connection</span>
                    <ConnLabel conn={conn} />
                  </div>
                </>}
              </div>
            </SettingsGroup>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button disabled={signingOut} variant="ghost" className="w-full justify-start px-1 font-medium text-destructive hover:bg-destructive/5">{signingOut ? "Signing out…" : "Sign out"}</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Sign out?</AlertDialogTitle>
                  <AlertDialogDescription>You'll need your passkey to sign back in on this device.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogAction disabled={signingOut} onClick={signOut}>Sign out</AlertDialogAction>
                  <AlertDialogCancel>Stay</AlertDialogCancel>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
        <div hidden={section !== "spaces"} data-slot="settings-scroll" className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-2", section !== "spaces" && "hidden")}>
          {open && <RepoSettings />}
        </div>
        <div hidden={section !== "updates"} data-slot="settings-scroll" className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-2", section !== "updates" && "hidden")}>
          {open && <UpdateSettings />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SettingsGroup({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return <section aria-labelledby={id} className="flex flex-col gap-2">
    <h3 id={id} className="text-xs font-medium text-muted-foreground">{label}</h3>
    {children}
  </section>;
}

function ConnLabel({ conn }: { conn: ConnState }) {
  const label = conn === "open" ? "Live" : conn === "connecting" ? "Connecting…" : "Reconnecting…";
  return <span role="status" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
    <span aria-hidden="true" className={cn("size-1.5 rounded-full", conn === "open" ? "bg-live" : conn === "reconnecting" ? "animate-pulse bg-amber" : "bg-faint")} />
    {label}
  </span>;
}
