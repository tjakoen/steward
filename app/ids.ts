// ID helpers. Ticket IDs are human-facing codes; entity IDs are opaque.

import type { Person } from './domain/types.ts';

/** Derive the 4-char code segment from a customer's primary family name. */
export function customerCodeFromPersons(persons: Person[]): string {
  const family = persons[0]?.family ?? 'XXXX';
  const letters = family.replace(/[^A-Za-z]/g, '').toUpperCase();
  return (letters + 'XXXX').slice(0, 4);
}

/**
 * Build a ticket id: `TX` + 4-char customer code + 4-digit zero-padded sequence.
 * e.g. code "DOEX", seq 1 → "TXDOEX0001".
 */
export function makeTicketId(customerCode: string, seq: number): string {
  const code = (customerCode + 'XXXX').slice(0, 4).toUpperCase();
  return `TX${code}${String(seq).padStart(4, '0')}`;
}

/** Opaque unique id. Prefixed for readability in logs/audit. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}
