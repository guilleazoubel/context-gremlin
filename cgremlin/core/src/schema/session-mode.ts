import { z } from 'zod';

export const SessionModeSchema = z.enum(['review', 'investigation', 'development']);
export type SessionMode = z.infer<typeof SessionModeSchema>;
