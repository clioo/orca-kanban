// MIT Copyright (c) 2026 Lovecast Inc. Ported from Orca's
// src/renderer/src/lib/utils.ts (cn helper) — merged class names with
// Tailwind conflict resolution, same contract as the source of truth.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
