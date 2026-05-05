/**
 * Single source of truth for the four production screens.
 * Sidebar / providers / mockups have been retired — settings now
 * absorbs credential management as its first sub-page.
 */
export type ScreenId = "generate" | "edit" | "history" | "settings";

export const SCREENS: { id: ScreenId; label: string; kbd: string }[] = [
  { id: "generate", label: "生成", kbd: "1" },
  { id: "edit", label: "编辑", kbd: "2" },
  { id: "history", label: "任务", kbd: "3" },
  { id: "settings", label: "设置", kbd: "4" },
];

export function isScreenId(value: unknown): value is ScreenId {
  return (
    value === "generate" ||
    value === "edit" ||
    value === "history" ||
    value === "settings"
  );
}
