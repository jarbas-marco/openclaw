import { enableSessionSuspensionWritesForGatewayStart } from "../agents/session-suspension.js";
// Gateway command-lane concurrency applier.
// Pushes config-derived agent/cron limits into the process command queue.
import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import { resolveCronMaxConcurrentRuns } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getCommandLaneSnapshot,
  publishLaneConfiguration,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import type { GatewayEventLoopHealth } from "./server/event-loop-health.js";

type GatewayLaneConcurrency = {
  cron: number;
  /**
   * Width of the hook lane, or 0 when hooks are disabled.
   *
   * Zero is meaningful: a steady-state hooks-off publication creates no group,
   * so a deployment that does not use hooks keeps the full cron budget and sees
   * no behaviour change from this feature.
   */
  hookDispatch: number;
  main: number;
  subagent: number;
};

type GatewayLaneHealthSample = Pick<GatewayEventLoopHealth, "degraded"> &
  Partial<Pick<GatewayEventLoopHealth, "reasons">>;

type GatewayLanePressureTransition = {
  configured: GatewayLaneConcurrency;
  degraded: boolean;
  effective: GatewayLaneConcurrency;
  pressureFactor: number;
  pressureLevel: number;
  reasons: GatewayEventLoopHealth["reasons"];
};

/** Capacity held inside the cron budget so hook dispatch cannot be starved. */
const HOOK_DISPATCH_LANE_RESERVATION = 1;

/** Group bounding cron inner work and hook dispatch to one shared budget. */
const CRON_HOOK_LANE_GROUP = "cron-hooks";

// Five seconds is longer than the event-loop monitor's one-second load window,
// yet reacts well before its 60-second persistent-degradation warning.
const GATEWAY_LANE_HEALTH_SAMPLE_INTERVAL_MS = 5_000;
// Fifteen healthy seconds per step prevents one quiet sample from reopening a
// bursty queue and immediately re-triggering pressure.
const GATEWAY_LANE_HEALTHY_SAMPLES_TO_RECOVER = 3;
// Ratchet capacity over three samples instead of collapsing on one spike; the
// positive-lane floor below keeps every configured capability available.
const GATEWAY_LANE_PRESSURE_FACTORS = [1, 0.75, 0.5, 0.25] as const;

let configuredGatewayLaneConcurrency: GatewayLaneConcurrency | undefined;
let gatewayLanePressureLevel = 0;
let consecutiveHealthyGatewayLaneSamples = 0;
let lastObservedGatewayLaneHealth: GatewayLaneHealthSample | undefined;

export function resolveGatewayLaneConcurrency(cfg: OpenClawConfig): GatewayLaneConcurrency {
  const cron = resolveCronMaxConcurrentRuns();
  return {
    cron,
    // The reservation guarantees one slot, but hooks may use every free slot
    // inside the shared budget. A one-wide lane would serialize unrelated hooks.
    hookDispatch: cfg.hooks?.enabled === true ? cron : 0,
    main: resolveAgentMaxConcurrent(cfg),
    subagent: resolveSubagentMaxConcurrent(cfg),
  };
}

export function applyGatewayLaneConcurrency(
  concurrency: GatewayLaneConcurrency,
  opts: { gatewayStart?: boolean } = {},
): void {
  if (opts.gatewayStart) {
    enableSessionSuspensionWritesForGatewayStart();
    gatewayLanePressureLevel = 0;
    consecutiveHealthyGatewayLaneSamples = 0;
    lastObservedGatewayLaneHealth = undefined;
  }
  configuredGatewayLaneConcurrency = { ...concurrency };
  applyEffectiveGatewayLaneConcurrency(scaleGatewayLaneConcurrency(concurrency), opts);
  setCommandLaneConcurrency("model-run-live", 2);
  setCommandLaneConcurrency("model-run-maintenance", 1);
}

/** Adjusts only future admissions while preserving configured healthy ceilings. */
function observeGatewayLaneHealth(
  health: GatewayLaneHealthSample | undefined,
): GatewayLanePressureTransition | undefined {
  // `snapshot()` returns its cached object when no fresh measurement exists.
  // Count equal-valued new objects as new samples, but never ratchet twice on
  // the same cached reference observed by adjacent lifecycle consumers.
  if (!health || !configuredGatewayLaneConcurrency || health === lastObservedGatewayLaneHealth) {
    return undefined;
  }
  lastObservedGatewayLaneHealth = health;
  const previousPressureLevel = gatewayLanePressureLevel;
  if (health.degraded) {
    consecutiveHealthyGatewayLaneSamples = 0;
    gatewayLanePressureLevel = Math.min(
      GATEWAY_LANE_PRESSURE_FACTORS.length - 1,
      gatewayLanePressureLevel + 1,
    );
  } else if (gatewayLanePressureLevel > 0) {
    consecutiveHealthyGatewayLaneSamples += 1;
    if (consecutiveHealthyGatewayLaneSamples >= GATEWAY_LANE_HEALTHY_SAMPLES_TO_RECOVER) {
      consecutiveHealthyGatewayLaneSamples = 0;
      gatewayLanePressureLevel -= 1;
    }
  } else {
    consecutiveHealthyGatewayLaneSamples = 0;
  }
  if (gatewayLanePressureLevel === previousPressureLevel) {
    return undefined;
  }
  const effective = scaleGatewayLaneConcurrency(configuredGatewayLaneConcurrency);
  applyEffectiveGatewayLaneConcurrency(effective);
  return {
    configured: { ...configuredGatewayLaneConcurrency },
    degraded: health.degraded,
    effective,
    pressureFactor: resolveGatewayLanePressureFactor(),
    pressureLevel: gatewayLanePressureLevel,
    reasons: health.reasons ?? [],
  };
}

/** Starts the lifecycle-owned event-loop sampler that controls new admissions. */
export function startGatewayLaneAdmissionMonitor(
  sampleHealth: () => GatewayLaneHealthSample | undefined,
  onPressureTransition?: (transition: GatewayLanePressureTransition) => void,
): { stop: () => void } {
  const timer = setInterval(() => {
    try {
      const transition = observeGatewayLaneHealth(sampleHealth());
      if (transition) {
        onPressureTransition?.(transition);
      }
    } catch {
      // Health sampling and observability callbacks are advisory. A faulty
      // probe/logger must not escape its timer and terminate the gateway.
    }
  }, GATEWAY_LANE_HEALTH_SAMPLE_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

function scaleGatewayLaneConcurrency(concurrency: GatewayLaneConcurrency): GatewayLaneConcurrency {
  const factor = resolveGatewayLanePressureFactor();
  const scale = (value: number) => (value <= 0 ? 0 : Math.max(1, Math.floor(value * factor)));
  return {
    cron: scale(concurrency.cron),
    hookDispatch: scale(concurrency.hookDispatch),
    main: scale(concurrency.main),
    subagent: scale(concurrency.subagent),
  };
}

function resolveGatewayLanePressureFactor(): number {
  return GATEWAY_LANE_PRESSURE_FACTORS[gatewayLanePressureLevel] ?? 1;
}

function applyEffectiveGatewayLaneConcurrency(
  concurrency: GatewayLaneConcurrency,
  opts: { gatewayStart?: boolean } = {},
): void {
  // Resolution is deliberately separate: this commit-edge applier only updates
  // live queue state and cannot reject a config midway through publication.
  setCommandLaneConcurrency(CommandLane.Cron, concurrency.cron);
  // `cron-nested` (cron inner agent work) and `hook-dispatch` (external hook
  // agent runs) are published as ONE transaction together with the group that
  // bounds them. Applying them with the per-lane setter would drain each lane
  // the moment it went positive — before the group existed — so both could
  // dispatch up to their individual maxima and exceed the shared budget. That
  // is precisely the additive-capacity behaviour openclaw#98813 was held for.
  const hooksEnabled = concurrency.hookDispatch > 0;
  const hookSnapshot = getCommandLaneSnapshot(CommandLane.HookDispatch);
  // Closing hooks must not detach already-running hook work from the shared
  // budget while cron immediately expands back to its full width. Retain the
  // group without a reservation until a later publication sees no active hook.
  const retainInFlightHookBudget = !hooksEnabled && hookSnapshot.activeCount > 0;
  publishLaneConfiguration({
    lanes: {
      [CommandLane.CronNested]: concurrency.cron,
      [CommandLane.HookDispatch]: concurrency.hookDispatch,
    },
    // Opt-in. A clean hooks-off publication installs no group and
    // `cron-nested` keeps the entire cron budget. During an enabled-to-disabled
    // transition, a zero-reservation group may remain while in-flight hooks
    // finish so aggregate work stays bounded without withholding idle capacity.
    groups:
      hooksEnabled || retainInFlightHookBudget
        ? {
            // Budget equals the existing cron cap, so the hook lane costs
            // nothing in AGGREGATE concurrency; it reserves one slot inside
            // that cap rather than adding one outside it. Cron inner work
            // trades one slot for the guarantee that hooks cannot be starved.
            [CRON_HOOK_LANE_GROUP]: {
              budget: concurrency.cron,
              members: [CommandLane.CronNested, CommandLane.HookDispatch],
              reservations: hooksEnabled
                ? { [CommandLane.HookDispatch]: HOOK_DISPATCH_LANE_RESERVATION }
                : undefined,
            },
          }
        : undefined,
    clearGroups: hooksEnabled || retainInFlightHookBudget ? undefined : [CRON_HOOK_LANE_GROUP],
  });
  setCommandLaneConcurrency(CommandLane.Main, concurrency.main);
  if (opts.gatewayStart) {
    // sessions.send work uses a shared nested lane with no config knob.
    setCommandLaneConcurrency(CommandLane.Nested, 1);
  }
  setCommandLaneConcurrency(CommandLane.Subagent, concurrency.subagent);
}
