/**
 * @module utils/prompt
 * @description Interactive CLI prompt utilities using Node.js built-in readline.
 *
 * Provides simple helpers for collecting user input in an interactive terminal
 * session: text input, secret input (masked), yes/no confirmation, and
 * single-select from a list of choices.
 *
 * No external dependencies — uses only `node:readline`.
 */

import * as readline from "node:readline";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a one-shot readline interface, ask a single question, then close.
 *
 * @param question - The prompt string shown to the user.
 * @param options  - Optional readline interface overrides (e.g. muted output).
 * @returns The trimmed answer string.
 */
function ask(
  question: string,
  options?: Partial<readline.ReadLineOptions>,
): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      ...options,
    });

    // Handle Ctrl+C gracefully
    rl.on("close", () => {
      // If closed without an answer (Ctrl+C), exit cleanly
    });

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Prompt the user for text input.
 *
 * If a `defaultValue` is provided it is shown in brackets and returned when
 * the user presses Enter without typing anything.
 *
 * @param question     - The prompt label (e.g. `"Your name"`).
 * @param defaultValue - Optional fallback value.
 * @returns The user's input, or `defaultValue` if the input was empty.
 */
export async function promptText(
  question: string,
  defaultValue?: string,
): Promise<string> {
  const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : "";
  const answer = await ask(`${question}${suffix}: `);
  return answer || defaultValue || "";
}

/**
 * Prompt the user for a secret value (e.g. API key, token).
 *
 * Input characters are **not** echoed to the terminal. A newline is printed
 * after the user presses Enter so subsequent output is aligned.
 *
 * @param question - The prompt label.
 * @returns The secret string entered by the user.
 */
export async function promptSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Mute output after the question is printed
    const stdout = process.stdout;
    let muted = false;

    const originalWrite = stdout.write.bind(stdout);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stdout.write = function (chunk: any, ...args: any[]): boolean {
      if (muted) return true;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      return originalWrite(chunk, ...args);
    } as typeof stdout.write;

    rl.question(`${question}: `, (answer) => {
      muted = false;
      stdout.write = originalWrite;
      // Print newline since input was hidden
      stdout.write("\n");
      rl.close();
      resolve(answer.trim());
    });

    // Start muting after the question text has been flushed
    muted = true;
  });
}

/**
 * Prompt the user for a yes / no confirmation.
 *
 * The hint `(Y/n)` or `(y/N)` is shown depending on `defaultValue`.
 *
 * @param question     - The confirmation question.
 * @param defaultValue - Default answer when the user presses Enter. Defaults
 *                       to `false`.
 * @returns `true` for yes, `false` for no.
 */
export async function promptConfirm(
  question: string,
  defaultValue: boolean = false,
): Promise<boolean> {
  const hint = defaultValue ? "(Y/n)" : "(y/N)";
  const answer = await ask(`${question} ${hint}: `);

  if (answer === "") return defaultValue;

  return answer.toLowerCase().startsWith("y");
}

/**
 * Prompt the user to select one option from a numbered list.
 *
 * Each choice is printed with a 1-based index. The user types the number of
 * their selection.
 *
 * @param question - Introductory question shown above the list.
 * @param choices  - Array of choice labels.
 * @returns The label of the selected choice.
 */
export async function promptSelect(
  question: string,
  choices: string[],
): Promise<string> {
  console.log(`\n${question}`);
  choices.forEach((choice, index) => {
    console.log(`  ${index + 1}. ${choice}`);
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answer = await ask("\nSelect an option: ");
    const num = parseInt(answer, 10);

    if (num >= 1 && num <= choices.length) {
      return choices[num - 1];
    }

    console.log(`  ⚠ Please enter a number between 1 and ${choices.length}.`);
  }
}

/**
 * Prompt the user for a file path and read its contents.
 *
 * Validates that the file exists and is readable. Re-prompts on failure.
 *
 * @param question - The prompt label describing what file is expected.
 * @returns The raw file contents as a string.
 */
export async function promptFilePath(question: string): Promise<string> {
  const { existsSync, readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const raw = await ask(`${question}: `);
    if (!raw) {
      console.log("  ⚠ Please enter a file path.");
      continue;
    }

    const filePath = resolve(raw.replace(/^~/, process.env.HOME || "~"));

    if (!existsSync(filePath)) {
      console.log(`  ⚠ File not found: ${filePath}`);
      continue;
    }

    try {
      return readFileSync(filePath, "utf-8");
    } catch {
      console.log(`  ⚠ Could not read file: ${filePath}`);
    }
  }
}
