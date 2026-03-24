import type { ProjectListDirectoryResult } from "@t3tools/contracts";
import { ArrowLeftIcon, ChevronRightIcon, FolderIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

interface RemoteDirectoryBrowserDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly listing: ProjectListDirectoryResult;
  readonly isLoading: boolean;
  readonly isSubmitting?: boolean;
  readonly onClose: () => void;
  readonly onNavigate: (path: string) => void;
  readonly onPathSubmit?: (path: string) => Promise<void> | void;
  readonly onCreateDirectory?: (name: string) => Promise<void>;
  readonly onUse?: () => void;
  readonly onSubmit?: () => void;
  readonly useLabel?: string;
  readonly submitLabel?: string;
}

export function RemoteDirectoryBrowserDialog(props: RemoteDirectoryBrowserDialogProps) {
  const [pathInput, setPathInput] = useState(props.listing.directoryPath);
  const [newFolderName, setNewFolderName] = useState("");
  const [isCreatingDirectory, setIsCreatingDirectory] = useState(false);
  const [isSubmittingPath, setIsSubmittingPath] = useState(false);

  useEffect(() => {
    setPathInput(props.listing.directoryPath);
  }, [props.listing.directoryPath]);

  return (
    <Dialog open={props.open} onOpenChange={(nextOpen) => !nextOpen && props.onClose()}>
      <DialogPopup className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex size-9 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              onClick={() => {
                if (!props.listing.parentPath) return;
                props.onNavigate(props.listing.parentPath);
              }}
              disabled={props.isLoading || props.listing.parentPath === null}
              aria-label="Browse parent directory"
            >
              <ArrowLeftIcon className="size-4" />
            </button>
            <Input
              value={pathInput}
              onChange={(event) => setPathInput(event.target.value)}
              className="min-w-0 flex-1 font-mono"
              disabled={props.isLoading || isSubmittingPath}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                const nextPath = pathInput.trim();
                if (!nextPath) return;
                const submitPath = props.onPathSubmit ?? props.onNavigate;
                setIsSubmittingPath(true);
                void Promise.resolve(submitPath(nextPath)).finally(() => {
                  setIsSubmittingPath(false);
                });
              }}
            />
            {props.onCreateDirectory ? (
              <Button
                variant="outline"
                className="shrink-0"
                disabled={props.isLoading || isCreatingDirectory || isSubmittingPath}
                onClick={async () => {
                  const trimmedName = newFolderName.trim();
                  if (!trimmedName) {
                    return;
                  }
                  setIsCreatingDirectory(true);
                  try {
                    await props.onCreateDirectory?.(trimmedName);
                    setNewFolderName("");
                  } finally {
                    setIsCreatingDirectory(false);
                  }
                }}
              >
                {isCreatingDirectory ? "Creating..." : "New Folder"}
              </Button>
            ) : null}
          </div>
          {props.onCreateDirectory ? (
            <div className="flex items-center gap-2">
              <Input
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.target.value)}
                placeholder="New folder name"
                disabled={props.isLoading || isCreatingDirectory}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  const trimmedName = newFolderName.trim();
                  if (!trimmedName) return;
                  const createDirectory = props.onCreateDirectory;
                  if (!createDirectory) return;
                  setIsCreatingDirectory(true);
                  void createDirectory(trimmedName)
                    .then(() => setNewFolderName(""))
                    .finally(() => setIsCreatingDirectory(false));
                }}
              />
            </div>
          ) : null}
          <div className="rounded-xl border border-border bg-background/70">
            <div className="flex items-center justify-between border-b border-border px-4 py-2 text-xs text-muted-foreground">
              <span>
                {props.isLoading
                  ? "Loading directories..."
                  : `${props.listing.entries.length} directories`}
              </span>
              {props.listing.truncated ? <span>Showing the first 200 entries</span> : null}
            </div>
            <div className="max-h-[52vh] overflow-y-auto">
              {props.listing.entries.length > 0 ? (
                props.listing.entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    className="flex w-full items-center gap-3 border-b border-border/40 px-4 py-3 text-left text-sm text-foreground/85 transition-colors last:border-b-0 hover:bg-accent hover:text-foreground"
                    onClick={() => props.onNavigate(entry.path)}
                    disabled={props.isLoading}
                  >
                    <FolderIcon className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/70" />
                  </button>
                ))
              ) : (
                <div className="px-4 py-6 text-sm text-muted-foreground">
                  No subdirectories found in this location.
                </div>
              )}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          {props.onUse ? (
            <Button variant="outline" onClick={props.onUse}>
              {props.useLabel ?? "Use This Folder"}
            </Button>
          ) : null}
          {props.onSubmit ? (
            <Button onClick={props.onSubmit} disabled={props.isSubmitting}>
              {props.isSubmitting ? "Working..." : (props.submitLabel ?? "Continue")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
