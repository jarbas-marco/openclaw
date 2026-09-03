import path from "node:path";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import {
  isArchivePathWithin,
  normalizeArchivePath,
  normalizeArchiveRoot,
} from "../infra/backup-archive-path-policy.js";
import {
  BACKUP_RECOVERY_PROFILE_SKIP_KIND,
  BACKUP_RECOVERY_PROFILE_SKIP_REASON,
  BACKUP_RECOVERY_PROFILE_STATE_ROOTS,
  type BackupRecoveryProfileManifest,
} from "../infra/backup-recovery-profile.js";
import { normalizeWindowsPathForComparison } from "../infra/path-guards.js";
import { isRecord } from "../utils.js";
import { buildBackupArchivePath } from "./backup-shared.js";

export type BackupManifest = {
  schemaVersion: number;
  createdAt: string;
  archiveRoot: string;
  runtimeVersion: string;
  platform: string;
  nodeVersion: string;
  options?: {
    includeWorkspace?: boolean;
    onlyConfig?: boolean;
    recoveryProfile?: BackupRecoveryProfileManifest;
  };
  paths?: {
    stateDir?: string;
    configPath?: string;
    oauthDir?: string;
    workspaceDirs?: string[];
    agentRoots?: Array<{ agentId: string; sourcePath: string }>;
  };
  assets: Array<{
    kind: string;
    sourcePath: string;
    archivePath: string;
  }>;
  skipped?: Array<{
    kind?: string;
    sourcePath?: string;
    reason?: string;
    coveredBy?: string;
  }>;
};

function parseOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function parseBackupManifestSourcePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`Backup manifest ${label} has an invalid sourcePath.`);
  }
  const windowsPath = /^[A-Za-z]:[\\/]/u.test(value);
  const normalized = windowsPath ? path.win32.normalize(value) : path.posix.normalize(value);
  if ((!windowsPath && !value.startsWith("/")) || normalized !== value) {
    throw new Error(`Backup manifest ${label} sourcePath must be absolute and normalized.`);
  }
  return value;
}

function parseBackupManifestAgentRoots(
  value: unknown,
): Array<{ agentId: string; sourcePath: string }> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Backup manifest agentRoots must be an array.");
  }

  const agentRoots: Array<{ agentId: string; sourcePath: string }> = [];
  const seenAgentIds = new Set<string>();
  const seenSourcePaths = new Set<string>();
  for (const agentRoot of value) {
    if (
      !isRecord(agentRoot) ||
      Object.keys(agentRoot).length !== 2 ||
      !Object.hasOwn(agentRoot, "agentId") ||
      !Object.hasOwn(agentRoot, "sourcePath")
    ) {
      throw new Error("Backup manifest agent root must contain only agentId and sourcePath.");
    }
    const { agentId, sourcePath } = agentRoot;
    if (typeof agentId !== "string" || !agentId || normalizeAgentId(agentId) !== agentId) {
      throw new Error("Backup manifest agent root has an invalid or noncanonical agentId.");
    }
    const normalizedSourcePath = parseBackupManifestSourcePath(sourcePath, "agent root");
    const windowsPath = /^[A-Za-z]:[\\/]/u.test(normalizedSourcePath);
    const sourcePathKey = windowsPath
      ? normalizeWindowsPathForComparison(normalizedSourcePath)
      : normalizedSourcePath;
    if (seenAgentIds.has(agentId) || seenSourcePaths.has(sourcePathKey)) {
      throw new Error("Backup manifest contains duplicate agent root ownership.");
    }
    seenAgentIds.add(agentId);
    seenSourcePaths.add(sourcePathKey);
    agentRoots.push({ agentId, sourcePath: normalizedSourcePath });
  }
  return agentRoots;
}

function parseBackupManifestSourcePaths(value: unknown, label: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`Backup manifest ${label} must be an array.`);
  }
  return value.map((entry) => parseBackupManifestSourcePath(entry, label));
}

function parseBackupRecoveryProfile(value: unknown): BackupRecoveryProfileManifest | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("Backup manifest recoveryProfile must declare excludedStateRoots.");
  }
  const excludedStateRoots = value.excludedStateRoots;
  if (!Array.isArray(excludedStateRoots)) {
    throw new Error("Backup manifest recoveryProfile must declare excludedStateRoots.");
  }
  if (
    excludedStateRoots.length !== BACKUP_RECOVERY_PROFILE_STATE_ROOTS.length ||
    !BACKUP_RECOVERY_PROFILE_STATE_ROOTS.every((root, index) => excludedStateRoots[index] === root)
  ) {
    throw new Error("Backup manifest recoveryProfile declares unsupported state exclusions.");
  }
  return { excludedStateRoots: [...BACKUP_RECOVERY_PROFILE_STATE_ROOTS] };
}

function parseSkippedEntries(value: unknown): BackupManifest["skipped"] {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Backup manifest skipped entries must be an array.");
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("Backup manifest contains a non-object skipped entry.");
    }
    const parsed: NonNullable<BackupManifest["skipped"]>[number] = {};
    for (const field of ["kind", "sourcePath", "reason", "coveredBy"] as const) {
      const fieldValue = entry[field];
      if (fieldValue !== undefined && typeof fieldValue !== "string") {
        throw new Error(`Backup manifest skipped entry ${field} must be a string.`);
      }
      if (fieldValue !== undefined) {
        parsed[field] = fieldValue;
      }
    }
    return parsed;
  });
}

export function parseBackupManifest(raw: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error("Backup manifest is not valid JSON.", { cause: err });
  }

  if (!isRecord(parsed)) {
    throw new Error("Backup manifest must be an object.");
  }
  if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) {
    throw new Error(`Unsupported backup manifest schemaVersion: ${String(parsed.schemaVersion)}`);
  }
  if (typeof parsed.archiveRoot !== "string" || !parsed.archiveRoot.trim()) {
    throw new Error("Backup manifest is missing archiveRoot.");
  }
  if (typeof parsed.createdAt !== "string" || !parsed.createdAt.trim()) {
    throw new Error("Backup manifest is missing createdAt.");
  }
  if (!Array.isArray(parsed.assets)) {
    throw new Error("Backup manifest is missing assets.");
  }

  const assets: BackupManifest["assets"] = [];
  for (const asset of parsed.assets) {
    if (!isRecord(asset)) {
      throw new Error("Backup manifest contains a non-object asset.");
    }
    if (typeof asset.kind !== "string" || !asset.kind.trim()) {
      throw new Error("Backup manifest asset is missing kind.");
    }
    if (typeof asset.sourcePath !== "string" || !asset.sourcePath.trim()) {
      throw new Error("Backup manifest asset is missing sourcePath.");
    }
    if (typeof asset.archivePath !== "string" || !asset.archivePath.trim()) {
      throw new Error("Backup manifest asset is missing archivePath.");
    }
    assets.push({
      kind: asset.kind,
      sourcePath: asset.sourcePath,
      archivePath: asset.archivePath,
    });
  }

  const recoveryProfile = isRecord(parsed.options)
    ? parseBackupRecoveryProfile(parsed.options.recoveryProfile)
    : undefined;
  if (parsed.schemaVersion === 1 && recoveryProfile) {
    throw new Error("Backup manifest schemaVersion 1 cannot declare a recoveryProfile.");
  }
  if (parsed.schemaVersion === 2 && !recoveryProfile) {
    throw new Error("Backup manifest schemaVersion 2 must declare a recoveryProfile.");
  }
  if (recoveryProfile && isRecord(parsed.options) && parsed.options.onlyConfig === true) {
    throw new Error("Backup manifest recoveryProfile cannot be combined with onlyConfig.");
  }

  return {
    schemaVersion: parsed.schemaVersion,
    archiveRoot: parsed.archiveRoot,
    createdAt: parsed.createdAt,
    runtimeVersion:
      typeof parsed.runtimeVersion === "string" && parsed.runtimeVersion.trim()
        ? parsed.runtimeVersion
        : "unknown",
    platform: typeof parsed.platform === "string" ? parsed.platform : "unknown",
    nodeVersion: typeof parsed.nodeVersion === "string" ? parsed.nodeVersion : "unknown",
    options: isRecord(parsed.options)
      ? {
          includeWorkspace: parseOptionalBoolean(
            parsed.options.includeWorkspace,
            "Backup manifest includeWorkspace",
          ),
          onlyConfig: parseOptionalBoolean(parsed.options.onlyConfig, "Backup manifest onlyConfig"),
          recoveryProfile,
        }
      : undefined,
    paths: isRecord(parsed.paths)
      ? {
          ...(parsed.paths.stateDir === undefined
            ? {}
            : {
                stateDir: parseBackupManifestSourcePath(parsed.paths.stateDir, "state directory"),
              }),
          ...(parsed.paths.configPath === undefined
            ? {}
            : { configPath: parseBackupManifestSourcePath(parsed.paths.configPath, "config") }),
          ...(parsed.paths.oauthDir === undefined
            ? {}
            : {
                oauthDir: parseBackupManifestSourcePath(parsed.paths.oauthDir, "oauth directory"),
              }),
          workspaceDirs: parseBackupManifestSourcePaths(
            parsed.paths.workspaceDirs,
            "workspace directory",
          ),
          agentRoots: parseBackupManifestAgentRoots(parsed.paths.agentRoots),
        }
      : undefined,
    assets,
    skipped: parseSkippedEntries(parsed.skipped),
  };
}

export function isRootBackupManifestEntry(entryPath: string): boolean {
  const parts = entryPath.split("/");
  return parts.length === 2 && parts[0] !== "" && parts[1] === "manifest.json";
}

function portableCasefoldArchivePath(value: string, label: string): string {
  return normalizeArchivePath(value, label).normalize("NFC").toLowerCase();
}

function isPortableCasefoldWithin(child: string, parent: string): boolean {
  const normalizedChild = portableCasefoldArchivePath(child, "Backup archive entry path");
  const normalizedParent = portableCasefoldArchivePath(parent, "Backup archive path");
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

function isPortableCasefoldArchivePathEqual(left: string, right: string): boolean {
  return (
    portableCasefoldArchivePath(left, "Backup archive path") ===
    portableCasefoldArchivePath(right, "Backup archive path")
  );
}

function verifyBackupRecoveryProfileEntries(
  manifest: BackupManifest,
  entries: readonly string[],
): void {
  const recoveryProfile = manifest.options?.recoveryProfile;
  if (!recoveryProfile) {
    return;
  }
  const stateAssets = manifest.assets.filter((asset) => asset.kind === "state");
  if (stateAssets.length !== 1 || !stateAssets[0]) {
    throw new Error("Recovery-profile backup manifest must contain exactly one state asset.");
  }
  const stateAsset = stateAssets[0];
  const archiveRoot = normalizeArchiveRoot(manifest.archiveRoot);
  const stateAssetRoot = normalizeArchivePath(
    stateAsset.archivePath,
    "Backup manifest state asset path",
  );
  const expectedStateAssetRoot = normalizeArchivePath(
    buildBackupArchivePath(archiveRoot, stateAsset.sourcePath),
    "Backup manifest expected state asset path",
  );
  if (stateAssetRoot !== expectedStateAssetRoot) {
    throw new Error(
      "Recovery-profile backup manifest state asset archivePath does not match its sourcePath.",
    );
  }
  const declaredStateDir = manifest.paths?.stateDir;
  if (!declaredStateDir) {
    throw new Error("Recovery-profile backup manifest must declare paths.stateDir.");
  }
  const declaredStateAssetRoot = normalizeArchivePath(
    buildBackupArchivePath(archiveRoot, declaredStateDir),
    "Backup manifest declared state directory path",
  );
  if (stateAssetRoot !== declaredStateAssetRoot) {
    throw new Error(
      "Recovery-profile backup manifest state asset sourcePath does not match paths.stateDir.",
    );
  }

  const declaredSourcePaths = [
    manifest.paths?.configPath,
    manifest.paths?.oauthDir,
    ...(manifest.paths?.workspaceDirs ?? []),
    ...(manifest.paths?.agentRoots ?? []).map((root) => root.sourcePath),
  ].filter((sourcePath): sourcePath is string => Boolean(sourcePath));

  for (const root of recoveryProfile.excludedStateRoots) {
    const excludedArchiveRoot = path.posix.join(stateAssetRoot, root);
    for (const sourcePath of declaredSourcePaths) {
      if (
        isPortableCasefoldWithin(
          buildBackupArchivePath(archiveRoot, sourcePath),
          excludedArchiveRoot,
        )
      ) {
        throw new Error(
          `Recovery-profile backup manifest cannot declare excluded state path: ${sourcePath}`,
        );
      }
    }
    const unexpectedEntry = entries.find((entry) =>
      isPortableCasefoldWithin(entry, excludedArchiveRoot),
    );
    if (unexpectedEntry) {
      throw new Error(
        `Recovery-profile archive contains excluded state payload: ${unexpectedEntry}`,
      );
    }

    const skippedMatches = (manifest.skipped ?? []).filter((entry) =>
      entry.sourcePath
        ? isPortableCasefoldArchivePathEqual(
            buildBackupArchivePath(archiveRoot, entry.sourcePath),
            excludedArchiveRoot,
          )
        : false,
    );
    if (
      skippedMatches.length !== 1 ||
      skippedMatches[0]?.kind !== BACKUP_RECOVERY_PROFILE_SKIP_KIND ||
      skippedMatches[0]?.reason !== BACKUP_RECOVERY_PROFILE_SKIP_REASON
    ) {
      throw new Error(
        `Recovery-profile backup manifest is missing verified exclusion metadata for ${root}.`,
      );
    }
  }
}

export function verifyBackupManifestEntries(manifest: BackupManifest, entries: Set<string>): void {
  const archiveRoot = normalizeArchiveRoot(manifest.archiveRoot);
  const manifestEntryPath = path.posix.join(archiveRoot, "manifest.json");
  const normalizedEntries = [...entries];
  const normalizedEntrySet = new Set(normalizedEntries);

  if (!normalizedEntrySet.has(manifestEntryPath)) {
    throw new Error(`Archive is missing manifest entry: ${manifestEntryPath}`);
  }

  for (const entry of normalizedEntries) {
    if (!isArchivePathWithin(entry, archiveRoot)) {
      throw new Error(`Archive entry is outside the declared archive root: ${entry}`);
    }
  }

  const payloadRoot = path.posix.join(archiveRoot, "payload");
  for (const asset of manifest.assets) {
    const assetArchivePath = normalizeArchivePath(asset.archivePath, "Backup manifest asset path");
    if (!isArchivePathWithin(assetArchivePath, payloadRoot)) {
      throw new Error(`Manifest asset path is outside payload root: ${asset.archivePath}`);
    }
    const exact = normalizedEntrySet.has(assetArchivePath);
    const nested = normalizedEntries.some(
      (entry) => entry !== assetArchivePath && isArchivePathWithin(entry, assetArchivePath),
    );
    if (!exact && !nested) {
      throw new Error(`Archive is missing payload for manifest asset: ${assetArchivePath}`);
    }
  }
  verifyBackupRecoveryProfileEntries(manifest, normalizedEntries);
}
