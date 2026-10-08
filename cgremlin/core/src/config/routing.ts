import { z } from 'zod';
import { STAGE_NAMES, type StageName } from '../schema/stage';

export const RUNNER_KINDS = ['claude-code', 'codex'] as const;
export type RunnerKind = (typeof RUNNER_KINDS)[number];

/** Claude Code `--effort` levels (CLI 2.1.294). `max` is never a default (R118e). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/** One runner · model · effort choice. Strict: a misspelt key is a problem, never a silent default. */
export const RouteTargetSchema = z
  .object({
    runner: z.enum(RUNNER_KINDS),
    model: z.string().min(1).optional(),
    effort: z.enum(EFFORT_LEVELS).optional(),
  })
  .strict();
export type RouteTarget = z.infer<typeof RouteTargetSchema>;

/** S2-30 — an escalation step may also name an advisor (`--advisor fable`, §17). Validated; inert in step 2. */
export const EscalationTargetSchema = RouteTargetSchema.extend({ advisor: z.string().min(1).optional() }).strict();

const CODEX_HAS_NO_MAX = "codex has no 'max' reasoning effort; use 'xhigh'";

/**
 * R116 / §17 — one stage's route. `escalate` (fix round 2, 3+ …) and `secondOpinion` (a
 * report-only second judge) are validated here and consumed by later steps; step 2 runs the
 * primary route only. Codex is allowed in them (inert); as the primary runner it is refused by
 * parseRouting (S2-21).
 */
export const StageRouteSchema = RouteTargetSchema.extend({
  escalate: z.array(EscalationTargetSchema).optional(),
  secondOpinion: RouteTargetSchema.optional(),
})
  .strict()
  .superRefine((route, ctx) => {
    const targets: Array<{ target: RouteTarget; path: Array<string | number> }> = [
      { target: route, path: [] },
      ...(route.escalate ?? []).map((target, i) => ({ target, path: ['escalate', i] })),
      ...(route.secondOpinion ? [{ target: route.secondOpinion, path: ['secondOpinion'] }] : []),
    ];
    for (const { target, path } of targets) {
      if (target.runner === 'codex' && target.effort === 'max') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'effort'], message: CODEX_HAS_NO_MAX });
      }
    }
  });
export type StageRoute = z.infer<typeof StageRouteSchema>;

export interface ParsedRouting {
  routes: Partial<Record<StageName, StageRoute>>;
  /**
   * One line per ignored entry, naming it: `routing.<key>: <why>; using the legacy runner` for an
   * invalid entry or a codex primary, `routing.<key>: unknown stage (…); ignored` for an unknown
   * stage, and a single `routing: expected an object …` line when the whole key is not an object.
   * The engine logs each as `config: <line>` once per boot.
   */
  problems: string[];
}

const STAGE_SET: ReadonlySet<string> = new Set(STAGE_NAMES);

/**
 * D3 / S2-23 — `core.json`'s raw `routing`, parsed entry by entry. A bad entry (unknown stage,
 * invalid shape, or codex as a primary runner, S2-21) becomes ONE problem line and is left out,
 * so that stage uses the legacy runner; the other entries still apply. Never throws: the engine
 * must boot whatever this key holds.
 */
export function parseRouting(raw: unknown): ParsedRouting {
  const routes: Partial<Record<StageName, StageRoute>> = {};
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { routes, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { routes, problems: ['routing: expected an object of stage routes; ignoring it, every stage uses the legacy runner'] };
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!STAGE_SET.has(key)) {
      problems.push(`routing.${key}: unknown stage (expected one of ${STAGE_NAMES.join(', ')}); ignored`);
      continue;
    }
    const result = StageRouteSchema.safeParse(value);
    if (!result.success) {
      const why = result.error.issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : 'entry'}: ${i.message}`).join('; ');
      problems.push(`routing.${key}: ${why}; using the legacy runner`);
      continue;
    }
    if (result.data.runner === 'codex') {
      problems.push(`routing.${key}: codex is report-only in v1 and may not be a primary stage runner (R116); using the legacy runner`);
      continue;
    }
    routes[key as StageName] = result.data;
  }
  return { routes, problems };
}

export interface ResolvedRoute {
  stage: StageName;
  runner: RunnerKind;
  model: string | null;
  effort: Effort | null;
  /** 'routing' = a valid `routing.<stage>` entry; 'legacy' = the engine-wide `runner`/`runnerOptions`. */
  source: 'routing' | 'legacy';
}

/** What routing resolves against: the legacy keys plus the routes parseRouting accepted. */
export interface RoutingConfigView {
  runner: RunnerKind;
  runnerOptions: { model?: string };
  routing?: Partial<Record<StageName, StageRoute>>;
}

/**
 * R116 — the runner, model and effort for one stage. No (valid) entry → the engine-wide runner
 * and `runnerOptions.model`, no effort (exactly today). An entry with no model inherits
 * `runnerOptions.model` only when it names the same runner family.
 */
export function resolveStageRoute(cfg: RoutingConfigView, stage: StageName): ResolvedRoute {
  const route = cfg.routing?.[stage];
  if (route === undefined) {
    return { stage, runner: cfg.runner, model: cfg.runnerOptions.model ?? null, effort: null, source: 'legacy' };
  }
  const model = route.model ?? (route.runner === cfg.runner ? (cfg.runnerOptions.model ?? null) : null);
  return { stage, runner: route.runner, model, effort: route.effort ?? null, source: 'routing' };
}
