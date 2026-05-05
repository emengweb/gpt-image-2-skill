export type AppUpdateState =
  | { status: "unavailable"; reason: "not-tauri" }
  | { status: "up-to-date"; currentVersion: string }
  | { status: "available"; update: AppUpdateInfo };

export type AppUpdateInfo = {
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
};

export type UpdateInstallProgress =
  | { phase: "starting"; contentLength?: number }
  | { phase: "downloading"; downloadedBytes: number; contentLength?: number }
  | { phase: "installing" };

const LAST_AUTO_CHECK_KEY = "gpt2.updater.lastAutoCheck";
const AUTO_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

function isTauriRuntime() {
  if (typeof window === "undefined") return false;
  const w = window as Window & {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  return Boolean(w.__TAURI__ || w.__TAURI_INTERNALS__);
}

function toInfo(update: {
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
}): AppUpdateInfo {
  return {
    currentVersion: update.currentVersion,
    version: update.version,
    date: update.date,
    body: update.body,
  };
}

export function shouldAutoCheckForUpdates() {
  if (!import.meta.env.PROD || !isTauriRuntime()) return false;
  try {
    const last = Number(localStorage.getItem(LAST_AUTO_CHECK_KEY) ?? "0");
    if (Number.isFinite(last) && Date.now() - last < AUTO_CHECK_INTERVAL_MS) {
      return false;
    }
    localStorage.setItem(LAST_AUTO_CHECK_KEY, String(Date.now()));
  } catch {
    /* localStorage can fail in hardened contexts; still allow one check. */
  }
  return true;
}

export async function checkForAppUpdate(): Promise<AppUpdateState> {
  if (!isTauriRuntime()) return { status: "unavailable", reason: "not-tauri" };

  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();

  if (!update) {
    return { status: "up-to-date", currentVersion: __APP_VERSION__ };
  }

  return { status: "available", update: toInfo(update) };
}

export async function installAppUpdate(
  onProgress?: (progress: UpdateInstallProgress) => void,
): Promise<AppUpdateState> {
  if (!isTauriRuntime()) return { status: "unavailable", reason: "not-tauri" };

  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();

  if (!update) {
    return { status: "up-to-date", currentVersion: __APP_VERSION__ };
  }

  let contentLength: number | undefined;
  let downloadedBytes = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      contentLength = event.data.contentLength;
      downloadedBytes = 0;
      onProgress?.({ phase: "starting", contentLength });
      return;
    }
    if (event.event === "Progress") {
      downloadedBytes += event.data.chunkLength;
      onProgress?.({
        phase: "downloading",
        downloadedBytes,
        contentLength,
      });
      return;
    }
    onProgress?.({ phase: "installing" });
  });

  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
  return { status: "available", update: toInfo(update) };
}
