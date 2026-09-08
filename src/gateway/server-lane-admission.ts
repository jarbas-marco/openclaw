import type { SubsystemLogger } from "../logging/subsystem.js";
import { startGatewayLaneAdmissionMonitor } from "./server-lanes.js";
import type { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";

export function registerLaneAdmission(
  sample: Parameters<typeof startGatewayLaneAdmissionMonitor>[0],
  log: Pick<SubsystemLogger, "info" | "warn">,
  owner: Pick<ReturnType<typeof createGatewaySidecarStopOwner>, "publish">,
): void {
  owner.publish([
    startGatewayLaneAdmissionMonitor(sample, (transition) => {
      const details = {
        configured: transition.configured,
        effective: transition.effective,
        pressureFactor: transition.pressureFactor,
        pressureLevel: transition.pressureLevel,
        reasons: transition.reasons,
      };
      if (transition.degraded) {
        log.warn("gateway lane admissions reduced under event-loop pressure", details);
      } else if (transition.pressureFactor === 1) {
        log.info("gateway lane admission ceilings restored after event-loop recovery", details);
      } else {
        log.info("gateway lane admissions recovering after event-loop pressure", details);
      }
    }),
  ]);
}
