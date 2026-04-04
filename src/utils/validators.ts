/**
 * @module utils/validators
 * @description Input validation utilities for common data patterns.
 */

import { z } from "zod";

/**
 * Validate that a string is a non-empty, trimmed value.
 *
 * @param value - The string to validate.
 * @returns `true` when the string contains non-whitespace characters.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate that a value looks like a Telegram user ID (positive integer as string or number).
 *
 * @param value - The value to validate.
 * @returns `true` when the value is a positive integer (or its string representation).
 */
export function isValidTelegramUserId(value: unknown): boolean {
  const num = typeof value === "string" ? Number(value) : value;
  return typeof num === "number" && Number.isInteger(num) && num > 0;
}

/**
 * Zod schema for a kebab-case identifier (e.g. plugin IDs).
 */
export const KebabCaseIdSchema = z.string().regex(
  /^[a-z0-9]+(-[a-z0-9]+)*$/,
  "Must be kebab-case (lowercase letters, numbers, and hyphens)",
);
