import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { BLOCK_HINT } from '../checks/blocked.js';
import { analyze as defaultAnalyze, BlockedError } from '../index.js';
import { renderJson } from '../output/json.js';
import { renderTerminal, shouldUseColor } from '../output/terminal.js';
import { escapeControlChars } from '../text.js';
import { VERSION } from '../version.js';
import { EXIT_BELOW_MIN_SCORE, EXIT_OK, EXIT_UNREACHABLE, EXIT_USAGE } from './exit-codes.js';
import { InvalidUrlError, normalizeUrl } from './url.js';

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  stdoutIsTTY: boolean;
}

type Analyze = typeof defaultAnalyze;

interface CliOptions {
  format: 'text' | 'json';
  minScore?: number;
}

/** Error messages can quote server data (e.g. a Location header), so control characters are escaped. */
function reportError(io: Io, prefix: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  io.stderr(`${prefix}: ${escapeControlChars(message)}\n`);
  if (io.env['DEBUG'] === 'sitecheck' && err instanceof Error && err.stack) {
    io.stderr(`${err.stack}\n`);
  }
}

function parseMinScore(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) > 100) {
    throw new InvalidArgumentError('Must be an integer from 0 to 100.');
  }
  return Number(value);
}

async function execute(
  rawUrl: string,
  options: CliOptions,
  io: Io,
  analyze: Analyze,
): Promise<number> {
  let url: string;
  try {
    url = normalizeUrl(rawUrl);
  } catch (err) {
    if (err instanceof InvalidUrlError) {
      io.stderr(`Error: ${err.message}\n`);
      return EXIT_USAGE;
    }
    throw err;
  }

  let report;
  try {
    report = await analyze(url, { onNotice: (message) => io.stderr(`Notice: ${message}\n`) });
  } catch (err) {
    if (err instanceof BlockedError) {
      io.stderr(`Access not allowed: ${err.message}\n${BLOCK_HINT}\n`);
    } else {
      reportError(io, 'Error', err);
    }
    return EXIT_UNREACHABLE;
  }

  io.stdout(
    options.format === 'json'
      ? renderJson(report)
      : renderTerminal(report, { color: shouldUseColor(io.env, io.stdoutIsTTY) }),
  );

  const errored = report.checks.filter((c) => c.status === 'error').length;
  if (errored > 0) {
    io.stderr(
      `Warning: ${errored} ${errored === 1 ? 'check' : 'checks'} failed to run and ${errored === 1 ? 'is' : 'are'} not included in the score.\n`,
    );
  }

  if (options.minScore !== undefined && report.score < options.minScore) {
    io.stderr(`Score ${report.score} is below the minimum of ${options.minScore}.\n`);
    return EXIT_BELOW_MIN_SCORE;
  }
  return EXIT_OK;
}

/** Runs the CLI and returns the exit code. Results go to stdout, errors and diagnostics to stderr. */
export async function main(
  argv: string[],
  io: Io,
  analyze: Analyze = defaultAnalyze,
): Promise<number> {
  let exitCode = EXIT_OK;
  const program = new Command()
    .name('sitecheck')
    .description('Check a website for availability, security, SEO and accessibility.')
    .version(VERSION)
    .argument('<url>', 'URL to check (https:// is assumed if no scheme is given)')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .option('--min-score <n>', 'exit with code 1 if the score is below n (0-100)', parseMinScore)
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .exitOverride()
    .action(async (url: string, options: CliOptions) => {
      try {
        exitCode = await execute(url, options, io, analyze);
      } catch (err) {
        reportError(io, 'Unexpected error', err);
        exitCode = EXIT_UNREACHABLE;
      }
    });

  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // Commander has already printed help, version or the parse error.
      return err.exitCode === 0 ? EXIT_OK : EXIT_USAGE;
    }
    throw err;
  }
  return exitCode;
}
