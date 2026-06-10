import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type BackgroundRemoveDependencyStatus = {
  installed: boolean;
  version: string | null;
  error: string | null;
};

export type BackgroundRemoveEnvironment = {
  ready: boolean;
  scriptPath: string;
  scriptExists: boolean;
  python: {
    resolved: string | null;
    version: string | null;
  };
  dependencies: {
    rembg: BackgroundRemoveDependencyStatus;
    pillow: BackgroundRemoveDependencyStatus;
    numpy: BackgroundRemoveDependencyStatus;
  };
  methods: {
    rembg: { available: boolean };
    builtin: { available: boolean };
  };
  installHints: string[];
};

export type BackgroundRemoveItemResult = {
  input: string | null;
  success: boolean;
  file: string | null;
  method: string | null;
  fallbackFrom: string | null;
  error: string | null;
};

export type BackgroundRemoveRunResult = {
  success: boolean;
  results: BackgroundRemoveItemResult[];
  python: string | null;
  pythonVersion: string | null;
  scriptPath: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  payload: Record<string, unknown> | null;
  error: string | null;
};

export type BackgroundRemoveInstallResult = {
  attempted: boolean;
  ok: boolean;
  python: string | null;
  pythonVersion: string | null;
  usedUserSite: boolean;
  requestedDependencies: Array<"rembg" | "pillow" | "numpy">;
  requestedPackages: string[];
  alreadySatisfied: Array<"rembg" | "pillow" | "numpy">;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  environmentBefore: BackgroundRemoveEnvironment;
  environmentAfter: BackgroundRemoveEnvironment;
  command: string[];
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPT_PATH = path.join(SCRIPT_DIR, "background_remove.py");

export function runBackgroundRemove(inputPath: string, outputPath: string, method = "rembg"): BackgroundRemoveRunResult {
  return runBackgroundRemoveCommand({
    inputs: [inputPath],
    output: outputPath,
    method,
  });
}

export function runBackgroundRemoveCommand(input: {
  inputs: string[];
  output?: string;
  method?: string;
}) : BackgroundRemoveRunResult {
  const pythonInfo = resolvePythonExecutableInfo();
  const scriptPath = resolveScriptPath();
  if (!pythonInfo.command) {
    return failedRunResult({
      scriptPath,
      error: "No Python runtime found for background_remove.py.",
    });
  }
  const args = [scriptPath, "--input", ...input.inputs];
  if (input.output) {
    args.push("--output", input.output);
  }
  args.push("--method", input.method || "rembg", "--json-only");
  const result = childProcess.spawnSync(
    pythonInfo.command,
    args,
    {
      encoding: "utf8",
    },
  );
  if (result.error) {
    return failedRunResult({
      scriptPath,
      python: pythonInfo.command,
      pythonVersion: pythonInfo.version,
      exitCode: result.status,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      error: result.error.message,
    });
  }
  const payload = parseJsonPayload(result.stdout || "");
  const normalizedResults = normalizeRunResults(payload, input.inputs);
  const error =
    summarizeRunError(payload) ||
    (result.status === 0 ? null : (result.stderr || result.stdout || "").trim() || "background_remove.py failed.");
  return {
    success:
      result.status === 0 &&
      normalizedResults.length > 0 &&
      normalizedResults.every((entry) => entry.success),
    results: normalizedResults,
    python: pythonInfo.command,
    pythonVersion: pythonInfo.version,
    scriptPath,
    exitCode: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    payload,
    error,
  };
}

export function inspectBackgroundRemoveEnvironment(): BackgroundRemoveEnvironment {
  const scriptPath = resolveScriptPath();
  const pythonInfo = resolvePythonExecutableInfo();
  const dependencyDefaults = {
    rembg: { installed: false, version: null, error: null },
    pillow: { installed: false, version: null, error: null },
    numpy: { installed: false, version: null, error: null },
  };
  if (!pythonInfo.command) {
    return {
      ready: false,
      scriptPath,
      scriptExists: fs.existsSync(scriptPath),
      python: { resolved: null, version: null },
      dependencies: dependencyDefaults,
      methods: {
        rembg: { available: false },
        builtin: { available: false },
      },
      installHints: [
        "Install Python 3 so background removal can run locally.",
        "Then run: pip install Pillow rembg",
      ],
    };
  }
  const probe = childProcess.spawnSync(
    pythonInfo.command,
    [
      "-c",
      [
        "import importlib, json",
        "def check(name):",
        "  try:",
        "    module = importlib.import_module(name)",
        "    return {'installed': True, 'version': getattr(module, '__version__', None), 'error': None}",
        "  except Exception as exc:",
        "    return {'installed': False, 'version': None, 'error': str(exc)}",
        "print(json.dumps({'rembg': check('rembg'), 'pillow': check('PIL'), 'numpy': check('numpy')}))",
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  const parsed = parseJsonPayload(probe.stdout || "") as Record<string, BackgroundRemoveDependencyStatus> | null;
  const dependencies = {
    rembg: normalizeDependencyStatus(parsed?.rembg, probe, "rembg"),
    pillow: normalizeDependencyStatus(parsed?.pillow, probe, "PIL"),
    numpy: normalizeDependencyStatus(parsed?.numpy, probe, "numpy"),
  };
  const scriptExists = fs.existsSync(scriptPath);
  const methods = {
    rembg: { available: scriptExists && dependencies.rembg.installed && dependencies.pillow.installed },
    builtin: { available: scriptExists && dependencies.pillow.installed },
  };
  const installHints: string[] = [];
  if (!scriptExists) {
    installHints.push("background_remove.py is missing from the installed package. Reinstall gpt-image-2-skill.");
  }
  if (!dependencies.pillow.installed) {
    installHints.push("Install Pillow: pip install Pillow");
  }
  if (!dependencies.rembg.installed) {
    installHints.push("Install rembg for AI removal: pip install rembg[gpu] or pip install rembg");
  }
  return {
    ready: methods.rembg.available || methods.builtin.available,
    scriptPath,
    scriptExists,
    python: {
      resolved: pythonInfo.command,
      version: pythonInfo.version,
    },
    dependencies,
    methods,
    installHints,
  };
}

export function installBackgroundRemoveDependencies(input?: {
  includeOptional?: boolean;
}): BackgroundRemoveInstallResult {
  const environmentBefore = inspectBackgroundRemoveEnvironment();
  const pythonInfo = resolvePythonExecutableInfo();
  const includeOptional = input?.includeOptional ?? true;
  const requestedDependencies = dependenciesToInstall(environmentBefore, includeOptional);
  const alreadySatisfied = (["pillow", "rembg", "numpy"] as const).filter((dependency) => !requestedDependencies.includes(dependency));
  if (!pythonInfo.command) {
    return {
      attempted: false,
      ok: false,
      python: null,
      pythonVersion: null,
      usedUserSite: false,
      requestedDependencies,
      requestedPackages: requestedDependencies.map((dependency) => packageNameForDependency(dependency)),
      alreadySatisfied,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: "No Python runtime found for background dependency installation.",
      environmentBefore,
      environmentAfter: environmentBefore,
      command: [],
    };
  }
  if (requestedDependencies.length === 0) {
    return {
      attempted: false,
      ok: environmentBefore.ready,
      python: pythonInfo.command,
      pythonVersion: pythonInfo.version,
      usedUserSite: false,
      requestedDependencies: [],
      requestedPackages: [],
      alreadySatisfied,
      exitCode: 0,
      stdout: "",
      stderr: "",
      error: null,
      environmentBefore,
      environmentAfter: environmentBefore,
      command: [],
    };
  }
  const requestedPackages = requestedDependencies.map((dependency) => packageNameForDependency(dependency));
  const command = ["-m", "pip", "install"];
  const usedUserSite = shouldUseUserSiteInstall();
  if (usedUserSite) {
    command.push("--user");
  }
  command.push(...requestedPackages);
  const result = childProcess.spawnSync(
    pythonInfo.command,
    command,
    {
      encoding: "utf8",
    },
  );
  const environmentAfter = inspectBackgroundRemoveEnvironment();
  const installSucceeded = requestedDependencies.every((dependency) => dependencyInstalled(environmentAfter, dependency));
  const error =
    result.error?.message ||
    (result.status === 0 && installSucceeded
      ? null
      : (result.stderr || result.stdout || "").trim() || "Background dependency installation failed.");
  return {
    attempted: true,
    ok: !error,
    python: pythonInfo.command,
    pythonVersion: pythonInfo.version,
    usedUserSite,
    requestedDependencies,
    requestedPackages,
    alreadySatisfied,
    exitCode: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error,
    environmentBefore,
    environmentAfter,
    command,
  };
}

function normalizeDependencyStatus(
  value: BackgroundRemoveDependencyStatus | undefined,
  probe: childProcess.SpawnSyncReturns<string>,
  moduleName: string,
): BackgroundRemoveDependencyStatus {
  if (value) return value;
  if (probe.error) {
    return {
      installed: false,
      version: null,
      error: probe.error.message,
    };
  }
  if (probe.status !== 0) {
    return {
      installed: false,
      version: null,
      error: `${moduleName} probe failed.`,
    };
  }
  return {
    installed: false,
    version: null,
    error: `${moduleName} probe returned no data.`,
  };
}

function normalizeRunResults(
  payload: Record<string, unknown> | null,
  inputs: string[],
): BackgroundRemoveItemResult[] {
  if (!payload) {
    return inputs.map((input) => ({
      input,
      success: false,
      file: null,
      method: null,
      fallbackFrom: null,
      error: "background_remove.py returned no JSON payload.",
    }));
  }
  const rawResults = Array.isArray(payload.results) ? payload.results : [payload];
  return rawResults.map((entry, index) => {
    const value = (entry ?? {}) as Record<string, unknown>;
    const success = value.success === true && typeof value.file === "string";
    return {
      input: typeof value.input === "string" ? value.input : inputs[index] ?? inputs[0] ?? null,
      success,
      file: typeof value.file === "string" ? value.file : null,
      method: typeof value.method === "string" ? value.method : null,
      fallbackFrom: typeof value.fallback_from === "string" ? value.fallback_from : null,
      error: typeof value.error === "string" ? value.error : success ? null : "background_remove.py failed.",
    };
  });
}

function summarizeRunError(payload: Record<string, unknown> | null) {
  if (!payload) return null;
  if (typeof payload.error === "string") return payload.error;
  if (Array.isArray(payload.results)) {
    const messages = payload.results
      .map((entry) => (entry && typeof entry === "object" && "error" in entry ? (entry as { error?: unknown }).error : null))
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (messages.length) return messages.join("; ");
  }
  return null;
}

function dependenciesToInstall(environment: BackgroundRemoveEnvironment, includeOptional: boolean) {
  const requested: Array<"rembg" | "pillow" | "numpy"> = [];
  if (!environment.dependencies.pillow.installed) requested.push("pillow");
  if (!environment.dependencies.rembg.installed) requested.push("rembg");
  if (includeOptional && !environment.dependencies.numpy.installed) requested.push("numpy");
  return requested;
}

function dependencyInstalled(
  environment: BackgroundRemoveEnvironment,
  dependency: "rembg" | "pillow" | "numpy",
) {
  return environment.dependencies[dependency].installed;
}

function packageNameForDependency(dependency: "rembg" | "pillow" | "numpy") {
  switch (dependency) {
    case "pillow":
      return "Pillow";
    case "rembg":
      return "rembg";
    case "numpy":
      return "numpy";
  }
}

function shouldUseUserSiteInstall() {
  const override = process.env.GPT_IMAGE_2_BG_REMOVE_PIP_USER?.trim();
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;
  return !process.env.VIRTUAL_ENV && !process.env.CONDA_PREFIX;
}

function failedRunResult(input: {
  scriptPath: string;
  python?: string | null;
  pythonVersion?: string | null;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error: string;
}) : BackgroundRemoveRunResult {
  return {
    success: false,
    results: [],
    python: input.python ?? null,
    pythonVersion: input.pythonVersion ?? null,
    scriptPath: input.scriptPath,
    exitCode: input.exitCode ?? null,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
    payload: null,
    error: input.error,
  };
}

function resolveScriptPath() {
  return process.env.GPT_IMAGE_2_BG_REMOVE_SCRIPT?.trim() || DEFAULT_SCRIPT_PATH;
}

function parseJsonPayload(stdout: string) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]) as Record<string, unknown>;
      } catch {
        continue;
      }
    }
    return null;
  }
}

function resolvePythonExecutableInfo() {
  const preferred = process.env.GPT_IMAGE_2_BG_REMOVE_PYTHON?.trim();
  const candidates = preferred ? [preferred] : ["python3", "python"];
  for (const candidate of candidates) {
    const probe = childProcess.spawnSync(candidate, ["--version"], {
      encoding: "utf8",
    });
    if (!probe.error && probe.status === 0) {
      return {
        command: candidate,
        version: (probe.stdout || probe.stderr || "").trim() || null,
      };
    }
  }
  return {
    command: null,
    version: null,
  };
}
