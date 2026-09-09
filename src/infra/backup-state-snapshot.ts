import fs from "node:fs/promises";
import path from "node:path";
import type { BackupResourceInventory } from "../commands/backup-resource-inventory.js";
import { createBackupSqliteSnapshotPlan } from "./backup-sqlite-snapshot.js";
import {
  createLegacyAuditBackupCapture,
  hasLegacyAuditBackupSources,
  legacyAuditBackupCapturesMatch,
  LegacyAuditBackupStateChangedError,
  type LegacyAuditBackupSnapshot,
} from "./state-migrations.audit-backup.js";
import { withLegacyAuditMigrationLease } from "./state-migrations.audit-coordination.js";

const MAX_LEGACY_AUDIT_CAPTURE_ATTEMPTS = 3;

type ConsistentStateSnapshotPlan = {
  legacyAuditSnapshots: LegacyAuditBackupSnapshot[];
  stateSqliteBackup: Awaited<ReturnType<typeof createBackupSqliteSnapshotPlan>>;
};

export async function createConsistentStateSnapshotPlan(params: {
  inventory: BackupResourceInventory;
  stateDir?: string;
  tempDir: string;
  onlyConfig: boolean;
}): Promise<ConsistentStateSnapshotPlan> {
  if (params.onlyConfig) {
    return {
      legacyAuditSnapshots: [],
      stateSqliteBackup: { snapshots: [], discoveredSourcePaths: new Set<string>() },
    };
  }
  if (!params.stateDir) {
    return {
      legacyAuditSnapshots: [],
      stateSqliteBackup: await createBackupSqliteSnapshotPlan({
        inventory: params.inventory,
        tempDir: params.tempDir,
        legacyAuditSnapshots: [],
      }),
    };
  }

  const stateDir = params.stateDir;
  if (!(await hasLegacyAuditBackupSources(stateDir))) {
    const fastAttemptDir = path.join(params.tempDir, "state-snapshot-no-legacy");
    await fs.mkdir(fastAttemptDir, { recursive: true });
    const stateSqliteBackup = await createBackupSqliteSnapshotPlan({
      inventory: params.inventory,
      tempDir: fastAttemptDir,
      legacyAuditSnapshots: [],
    });
    if (!(await hasLegacyAuditBackupSources(stateDir))) {
      return { legacyAuditSnapshots: [], stateSqliteBackup };
    }
    await fs.rm(fastAttemptDir, { recursive: true, force: true });
  }

  let lastStateChangeMessage: string | undefined;
  for (let attempt = 0; attempt < MAX_LEGACY_AUDIT_CAPTURE_ATTEMPTS; attempt += 1) {
    const attemptDir = path.join(params.tempDir, `state-snapshot-attempt-${attempt + 1}`);
    const verificationDir = path.join(attemptDir, "legacy-verification");
    await fs.mkdir(attemptDir, { recursive: true });
    try {
      const firstCapture = await withLegacyAuditMigrationLease(stateDir, () =>
        createLegacyAuditBackupCapture({ stateDir, tempDir: attemptDir }),
      );
      const stateSqliteBackup = await createBackupSqliteSnapshotPlan({
        inventory: params.inventory,
        tempDir: attemptDir,
        legacyAuditSnapshots: firstCapture.snapshots,
        legacyAuditDatabaseWitness: firstCapture.databaseWitness,
      });
      await fs.mkdir(verificationDir, { recursive: true });
      const secondCapture = await withLegacyAuditMigrationLease(stateDir, () =>
        createLegacyAuditBackupCapture({ stateDir, tempDir: verificationDir }),
      );
      if (!legacyAuditBackupCapturesMatch(firstCapture, secondCapture)) {
        throw new LegacyAuditBackupStateChangedError();
      }
      await fs.rm(verificationDir, { recursive: true, force: true });
      return { legacyAuditSnapshots: firstCapture.snapshots, stateSqliteBackup };
    } catch (error) {
      await fs.rm(attemptDir, { recursive: true, force: true });
      if (!(error instanceof LegacyAuditBackupStateChangedError)) {
        throw error;
      }
      lastStateChangeMessage = error.message;
    }
  }
  throw new LegacyAuditBackupStateChangedError(
    `${lastStateChangeMessage ?? "Legacy audit state changed while backup was capturing it"}; retry backup after legacy audit migration settles`,
  );
}
