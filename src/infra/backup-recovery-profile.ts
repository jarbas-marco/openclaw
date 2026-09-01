export const BACKUP_RECOVERY_PROFILE_STATE_ROOTS = ["internal-agent-runs"] as const;

export const BACKUP_RECOVERY_PROFILE_SKIP_KIND = "legacy internal run artifacts";

export const BACKUP_RECOVERY_PROFILE_SKIP_REASON =
  "recovery-profile: non-authoritative legacy internal-run traces excluded in full";

export type BackupRecoveryProfileManifest = {
  excludedStateRoots: string[];
};

export function buildBackupRecoveryProfileManifest(): BackupRecoveryProfileManifest {
  return { excludedStateRoots: [...BACKUP_RECOVERY_PROFILE_STATE_ROOTS] };
}
