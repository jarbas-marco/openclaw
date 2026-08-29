import path from "node:path";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
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

function portableCasefoldArchivePath(value: string, label: string): string {
  return normalizeArchivePath(value, label).normalize("NFC").toLocaleLowerCase("en-US");
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
          stateDir: readStringValue(parsed.paths.stateDir),
          configPath: readStringValue(parsed.paths.configPath),
          oauthDir: readStringValue(parsed.paths.oauthDir),
          workspaceDirs: Array.isArray(parsed.paths.workspaceDirs)
            ? parsed.paths.workspaceDirs.filter(
                (entry): entry is string => typeof entry === "string",
              )
            : undefined,
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

function verifyBackupRecoveryProfileEntries(
  manifest: BackupManifest,
  entries: readonly string[],
): void {
  const recoveryProfile = manifest.options?.recoveryProfile;
  if (!recoveryProfile) {
    return;
  }
  const stateAssets = manifest.assets.filter((asset) => asset.kind === "state");
  if (stateAssets.length !== 1) {
    throw new Error("Recovery-profile backup manifest must contain exactly one state asset.");
  }
  const stateAsset = stateAssets[0];
  if (!stateAsset) {
    throw new Error("Recovery-profile backup state asset could not be resolved.");
  }
  const stateAssetRoot = normalizeArchivePath(
    stateAsset.archivePath,
    "Backup manifest state asset path",
  );
  const declaredArchivePaths = [
    { kind: "config", sourcePath: manifest.paths?.configPath },
    { kind: "oauth", sourcePath: manifest.paths?.oauthDir },
    ...(manifest.paths?.workspaceDirs ?? []).map((sourcePath) => ({
      kind: "workspace" as const,
      sourcePath,
    })),
  ]
    .filter((entry): entry is { kind: "config" | "oauth" | "workspace"; sourcePath: string } =>
      Boolean(entry.sourcePath),
    )
    .map((entry) => ({
      kind: entry.kind,
      sourcePath: entry.sourcePath,
      archivePath: buildBackupArchivePath(manifest.archiveRoot, entry.sourcePath),
    }));

  for (const root of recoveryProfile.excludedStateRoots) {
    const excludedArchiveRoot = path.posix.join(stateAssetRoot, root);
    for (const declaredPath of declaredArchivePaths) {
      if (isPortableCasefoldWithin(declaredPath.archivePath, excludedArchiveRoot)) {
        throw new Error(
          `Recovery-profile backup manifest cannot declare excluded state path: ${declaredPath.sourcePath}`,
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

    const skippedMatches = (manifest.skipped ?? []).filter((entry) => {
      if (!entry.sourcePath) {
        return false;
      }
      return isPortableCasefoldArchivePathEqual(
        buildBackupArchivePath(manifest.archiveRoot, entry.sourcePath),
        excludedArchiveRoot,
      );
    });
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
