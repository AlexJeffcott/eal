/**
 * Shared CLI types.
 *
 * `GlobalOptions` is the structured handoff from the argv splitter into
 * each command. Commands parse their own subcommand-level flags from
 * `commandArgs`, never from `process.argv`.
 */

export interface GlobalOptions {
  apiUrl: string;
  tokenPathOverride: string | undefined;
  json: boolean;
  verbose: boolean;
  help: boolean;
  /**
   * Args destined for the subcommand, with global flags already stripped
   * and the subcommand name itself removed. Subcommands parse these
   * directly instead of slicing process.argv, which is brittle when global
   * flags appear before the subcommand.
   */
  commandArgs: string[];
}
