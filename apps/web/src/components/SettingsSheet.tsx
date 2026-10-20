import { TelemetrySettings } from "./TelemetrySettings";
import { useBackLayer } from "../hooks/useBackLayer";
import { useSignOut } from "../auth/useSignOut";
import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { ArrowLeft, ArrowUpCircle, ChevronRight, FolderSearch, GitBranch, Monitor, Moon, Sun, X } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { FieldContent, FieldLabel } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetClose, SheetBody, SheetContent, SheetHeaderRow, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type { ConnState } from "../hooks/useInbox";
import { useArcadeMode } from "../ArcadeModeProvider";
import { useTheme, type Theme } from "../ThemeProvider";
import { useSendShortcut } from "../SendShortcutProvider";
import { useShakeToDictate } from "../ShakeToDictateProvider";
import { useUpdateState } from "../update-state";
import { SettingsCard, SettingsField, SettingsPanel } from "./SettingsLayout";
import { PushToggle } from "./PushToggle";
import { UpdateSettings } from "./UpdateSettings";
import { SpaceSettings } from "./SpaceSettings";
import { RepoSettings } from "./RepoSettings";

// Keep panels mounted while open so navigation preserves edits and scroll positions.
export function SettingsSheet({ conn, open, onOpenChange, onCloseAutoFocus }: {
  conn?: ConnState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const { signingOut, signOut } = useSignOut();
  const { theme, setTheme } = useTheme();
  const { enabled: arcadeMode, setEnabled: setArcadeMode } = useArcadeMode();
  const { shortcut, setShortcut } = useSendShortcut();
  const shake = useShakeToDictate();
  const [section, setSection] = useUpdateState("settings:section", "general");
  const title = useRef<HTMLHeadingElement>(null);
  const searchPathsLink = useRef<HTMLButtonElement>(null);
  const spaceSettingsLink = useRef<HTMLButtonElement>(null);
  const updatesLink = useRef<HTMLButtonElement>(null);
  const previousSection = useRef(section);
  const appearanceId = useId();
  const shortcutId = useId();
  const arcadeId = useId();
  const shakeId = useId();
  const shakeDescriptionId = `${shakeId}-description`;
  const shakeErrorId = `${shakeId}-error`;
  const home = section === "general";
  useBackLayer(open && !home, () => setSection("general"), 150);

  useLayoutEffect(() => {
    const previous = previousSection.current;
    previousSection.current = section;
    if (!open || previous === section) return;
    if (section === "general") {
      (previous === "spaces" ? searchPathsLink : previous === "base-branches" ? spaceSettingsLink : updatesLink).current?.focus({ preventScroll: true });
    } else {
      title.current?.focus({ preventScroll: true });
    }
  }, [section, open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} autoFocus>
      <SheetContent showClose={false} size="panel" className="max-w-lg" onCloseAutoFocus={onCloseAutoFocus}>
        <SheetHeader>
          <SheetHeaderRow>
            {!home && <Button variant="ghost" size="icon-lg" aria-label="Back to settings" onClick={() => setSection("general")}>
              <ArrowLeft />
            </Button>}
            <SheetTitle asChild className="outline-none">
              <h2 ref={title} tabIndex={-1}>{home ? "Settings" : section === "spaces" ? "Repository search paths" : section === "base-branches" ? "Space settings" : "Updates"}</h2>
            </SheetTitle>
            <SheetClose asChild><Button variant="ghost" size="icon-lg" aria-label="Close settings"><X /></Button></SheetClose>
          </SheetHeaderRow>
          <SheetDescription className="sr-only">
            {home ? "Preferences and installation" : section === "spaces" ? "Manage folders searched for repositories on this installation." : section === "base-branches" ? "Manage base branches for new tasks and routines." : "Manage Palmagent updates on this installation."}
          </SheetDescription>
        </SheetHeader>

        <SheetBody hidden={!home} data-slot="settings-scroll" className={cn(!home && "hidden")}>
          <SettingsPanel aria-label="General settings">
            <SettingsGroup label="On this device">
              <SettingsCard>
                <SettingsField>
                  <FieldLabel variant="setting" id={appearanceId}>Appearance</FieldLabel>
                  <ToggleGroup type="single" value={theme} aria-labelledby={appearanceId} className="w-auto shrink-0"
                    onValueChange={(value) => value && setTheme(value as Theme)}>
                    <ToggleGroupItem value="system" aria-label="System theme" title="System theme" className="w-11"><Monitor className="size-4" /></ToggleGroupItem>
                    <ToggleGroupItem value="light" aria-label="Light theme" title="Light theme" className="w-11"><Sun className="size-4" /></ToggleGroupItem>
                    <ToggleGroupItem value="dark" aria-label="Dark theme" title="Dark theme" className="w-11"><Moon className="size-4" /></ToggleGroupItem>
                  </ToggleGroup>
                </SettingsField>
                <Separator />
                <SettingsField>
                  <FieldLabel variant="setting" id={shortcutId}>Send <span className="sr-only">message </span>with</FieldLabel>
                  <ToggleGroup type="single" value={shortcut} aria-labelledby={shortcutId} className="w-auto shrink-0 whitespace-nowrap"
                    onValueChange={(value) => { if (value === "enter" || value === "modifier-enter") setShortcut(value); }}>
                    <ToggleGroupItem value="enter" className="px-2">Enter</ToggleGroupItem>
                    <ToggleGroupItem value="modifier-enter" className="px-2">Cmd/Ctrl + Enter</ToggleGroupItem>
                  </ToggleGroup>
                </SettingsField>
                <PushToggle />
              </SettingsCard>
            </SettingsGroup>

            <SettingsGroup label="Experimental">
              <SettingsCard>
                <SettingsField>
                  <FieldContent>
                    <FieldLabel variant="setting" htmlFor={arcadeId}>Arcade mode</FieldLabel>
                    <p id={`${arcadeId}-description`} className="text-xs text-muted-foreground">Auto-open games</p>
                  </FieldContent>
                  <Switch id={arcadeId} checked={arcadeMode} onCheckedChange={setArcadeMode} aria-describedby={`${arcadeId}-description`} />
                </SettingsField>
                <Separator />
                <SettingsField>
                  <FieldContent>
                    <FieldLabel variant="setting" htmlFor={shakeId}>Shake to dictate</FieldLabel>
                    <p id={shakeDescriptionId} className="text-xs text-muted-foreground">
                      Motion and mic permission required. In a conversation, shake to toggle; audio is used only while dictating.
                    </p>
                    {shake.error && <p id={shakeErrorId} role="status" className="text-xs text-destructive">{shake.error}</p>}
                  </FieldContent>
                  <Switch id={shakeId} checked={shake.enabled} disabled={shake.status === "requesting"}
                    onCheckedChange={value => { void shake.setEnabled(value); }}
                    aria-describedby={shake.error ? `${shakeDescriptionId} ${shakeErrorId}` : shakeDescriptionId}
                    aria-busy={shake.status === "requesting"} />
                </SettingsField>
              </SettingsCard>
            </SettingsGroup>

            <SettingsGroup label="Performance">
              <TelemetrySettings />
            </SettingsGroup>

            <SettingsGroup label="Installation">
              <div className="flex flex-col">
                <Button ref={spaceSettingsLink} variant="ghost" aria-label="Space settings" onClick={() => setSection("base-branches")}
                  className="h-auto min-h-12 justify-start gap-3 whitespace-normal px-1 py-2 text-left">
                  <GitBranch data-icon="inline-start" />
                  <span className="min-w-0 flex-1">Space settings</span>
                  <ChevronRight data-icon="inline-end" />
                </Button>
                <Separator />
                <Button ref={searchPathsLink} variant="ghost" aria-label="Repository search paths" onClick={() => setSection("spaces")}
                  className="h-auto min-h-12 justify-start gap-3 whitespace-normal px-1 py-2 text-left">
                  <FolderSearch data-icon="inline-start" />
                  <span className="min-w-0 flex-1">Repository search paths</span>
                  <ChevronRight data-icon="inline-end" />
                </Button>
                <Separator />
                <Button ref={updatesLink} variant="ghost" aria-label="Updates" onClick={() => setSection("updates")}
                  className="h-auto min-h-12 justify-start gap-3 whitespace-normal px-1 py-2 text-left">
                  <ArrowUpCircle data-icon="inline-start" />
                  <span className="min-w-0 flex-1">Updates</span>
                  <ChevronRight data-icon="inline-end" />
                </Button>
              </div>
            </SettingsGroup>

            <div className="flex items-center justify-between gap-3">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button disabled={signingOut} variant="ghost" className="justify-start px-1">{signingOut ? "Signing out…" : "Sign out"}</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Sign out?</AlertDialogTitle>
                    <AlertDialogDescription>You'll need your passkey to sign back in on this device.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Stay</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" disabled={signingOut} onClick={signOut}>Sign out</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              {conn && <ConnLabel conn={conn} />}
            </div>
          </SettingsPanel>
        </SheetBody>
        <SheetBody hidden={section !== "spaces"} data-slot="settings-scroll" className={cn(section !== "spaces" && "hidden")}>
          {open && <RepoSettings />}
        </SheetBody>
        <SheetBody hidden={section !== "base-branches"} data-slot="settings-scroll" className={cn(section !== "base-branches" && "hidden")}>
          {open && <SpaceSettings />}
        </SheetBody>
        <SheetBody hidden={section !== "updates"} data-slot="settings-scroll" className={cn(section !== "updates" && "hidden")}>
          {open && <UpdateSettings />}
        </SheetBody>
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
