const TICKET_KEY_PATTERN = /\b([A-Z][A-Z0-9]+-\d+)\b/;

export function extractTicketKey(text: string): string | null {
  const match = TICKET_KEY_PATTERN.exec(text);
  return match ? match[1] : null;
}
