import { z } from 'zod';

/**
 * R51 — a FOURTH mode, `respond`: addressing the reviews on MY OWN pull
 * request. Both session unions are discriminated on `mode`, so every session
 * already on disk keeps matching its own branch and the change is additive
 * and migration-safe. The v1 union is deliberately NOT extended: there were
 * no respond sessions before Phase 9, so a v1 respond document cannot exist.
 */
export const SessionModeSchema = z.enum(['review', 'investigation', 'development', 'respond']);
export type SessionMode = z.infer<typeof SessionModeSchema>;
