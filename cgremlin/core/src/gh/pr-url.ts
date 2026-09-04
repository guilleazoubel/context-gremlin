export interface PrRef {
  owner: string;
  repo: string;
  number: number;
  slug: string;
  url: string;
}

export class InvalidPrUrlError extends Error {
  constructor(input: string) {
    super(`Not a GitHub pull request URL: ${input}`);
    this.name = 'InvalidPrUrlError';
  }
}

const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/;

export function parsePrUrl(input: string): PrRef {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new InvalidPrUrlError(input);
  }
  if (parsed.host !== 'github.com') {
    throw new InvalidPrUrlError(input);
  }
  const match = PR_PATH.exec(parsed.pathname);
  if (!match) {
    throw new InvalidPrUrlError(input);
  }
  const [, owner, repo, numberText] = match;
  return {
    owner,
    repo,
    number: Number(numberText),
    slug: `${owner}/${repo}`,
    url: `https://github.com/${owner}/${repo}/pull/${numberText}`,
  };
}
