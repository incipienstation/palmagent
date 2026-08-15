import type { TaskStatus } from "@palmagent/shared";

// Single source of truth for human-readable task-status copy. The raw TaskStatus
// enum (awaiting_input, idle, …) is an internal contract and must NEVER reach the
// UI. The inbox badges (chips), the inbox section headers, and the task-detail
// badge all read from here so the three never drift.

// Short badge label — sits in a tinted pill next to a task title.
//   idle is the "turn finished, your move" state; idle + interrupted means the
//   turn was stopped/recovered (resumable), surfaced as the word "Stopped".
export function statusLabel(status: TaskStatus, interrupted?: boolean): string {
  switch (status) {
    case "awaiting_input":
      return "Needs answer";
    case "awaiting_approval":
      return "Needs approval";
    case "running":
      return "Working";
    case "queued":
      return "Queued";
    case "idle":
      return interrupted ? "Stopped" : "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "archived":
      return "Archived";
  }
}

// Inbox section header — a calmer, fuller phrasing than the badge.
export function statusSection(status: TaskStatus): string {
  switch (status) {
    case "awaiting_input":
      return "Needs your answer";
    case "awaiting_approval":
      return "Needs your approval";
    case "running":
      return "Working now";
    case "queued":
      return "Up next";
    case "idle":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "archived":
      return "Archived";
  }
}
