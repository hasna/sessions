import type { SessionParser } from "./types.js";

const PARSERS = new Map<string, SessionParser>();

/** Register a parser for a provider (overwrites any existing one for that source). */
export function registerParser(parser: SessionParser): void {
  PARSERS.set(parser.source, parser);
}

export function getParser(source: string): SessionParser | undefined {
  return PARSERS.get(source);
}

export function listParsers(): SessionParser[] {
  return [...PARSERS.values()];
}
