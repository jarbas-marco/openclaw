// Gateway command-lane concurrency applier.
// Pushes config-derived agent/cron limits into the process command queue.
import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import { resolveCronMaxConcurrentRuns } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import type { GatewayEventLoopHealth } from "./server/event-loop-health.js";

type GatewayLaneConcurrency = {
  cron: number;
  main: number;
  subagent: number;
};

type GatewayLaneHealthSample = Pick<GatewayEventLoopHealth, "degraded"> &
  Partial<Pick<GatewayEventLoopHealth, "reasons">>;

export type GatewayLanePressureTransition = {
  configured: GatewayLaneConcurrency;
  degraded: boolean;
  effective: GatewayLaneConcurrency;
  pressureFactor: number;
  pressureLevel: number;
  reasons: GatewayEventLoopHealth["reasons"];
};

const GATEWAY_LANE_HEALTH_SAMPLE_INTERVAL_MS = 5_000;
const GATEWAY_LANE_HEALTHY_SAMPLES_TO_RECOVER = 3;
const GATEWAY_LANE_PRESSURE_FACTORS = [1, 0.75, 0.5, 0.25] as const;

let configuredGatewayLaneConcurrency: GatewayLaneConcurrency | undefined;
let gatewayLanePressureLevel = 0;
let consecutiveHealthyGatewayLaneSamples = 0;
let lastObservedGatewayLaneHealth: GatewayLaneHealthSample | undefined;

function resolveGatewayLaneConcurrency(cfg: OpenClawConfig): GatewayLaneConcurrency {
  return {
    cron: resolveCronMaxConcurrentRuns(cfg.cron),
    main: resolveAgentMaxConcurrent(cfg),
    subagent: resolveSubagentMaxConcurrent(cfg),
  };
}

export function applyGatewayLaneConcurrency(
  cfg: OpenClawConfig,
  opts: { gatewayStart?: boolean } = {},
): void {
  if (opts.gatewayStart) {
    gatewayLanePressureLevel = 0;
    consecutiveHealthyGatewayLaneSamples = 0;
    lastObservedGatewayLaneHealth = undefined;
  }
  configuredGatewayLaneConcurrency = resolveGatewayLaneConcurrency(cfg);
  applyEffectiveGatewayLaneConcurrency(
    scaleGatewayLaneConcurrency(configuredGatewayLaneConcurrency),
  );
}

function observeGatewayLaneHealth(
  health: GatewayLaneHealthSample | undefined,
): GatewayLanePressureTransition | undefined {
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
      // Sampling and observability are advisory and must never terminate the gateway.
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
    main: scale(concurrency.main),
    subagent: scale(concurrency.subagent),
  };
}

function resolveGatewayLanePressureFactor(): number {
  return GATEWAY_LANE_PRESSURE_FACTORS[gatewayLanePressureLevel] ?? 1;
}

function applyEffectiveGatewayLaneConcurrency(concurrency: GatewayLaneConcurrency): void {
  setCommandLaneConcurrency(CommandLane.Cron, concurrency.cron);
  // Cron isolated agent turns remap inner LLM work to this lane.
  setCommandLaneConcurrency(CommandLane.CronNested, concurrency.cron);
  setCommandLaneConcurrency(CommandLane.Main, concurrency.main);
  setCommandLaneConcurrency(CommandLane.Subagent, concurrency.subagent);
}
