/**
 * R110 — what "a session can post" looks like on disk, pinned by value and
 * shared by every test that checks it: the files the engine writes for the
 * scoped post helpers, and the deny rules a headless review carries instead.
 * Literals on purpose — a test that imported the production lists would
 * agree with whatever they became.
 */
export const HELPER_FILES: string[] = ['.cgremlin/post-review', '.cgremlin/post-comment', '.cgremlin/package.json'];

export const HELPER_DENIES: string[] = [
  'Bash(.cgremlin/post-review:*)',
  'Bash(./.cgremlin/post-review:*)',
  'Bash(.cgremlin/post-comment:*)',
  'Bash(./.cgremlin/post-comment:*)',
];
