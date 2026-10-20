/**
 * Defaults of the workbench's configuration that more than one package needs. The one place a default lives: the
 * CLI's deep links, `serve`, and the web dev proxy all read it from here.
 */

/** The port `serve` binds and deep links point at when `config.toml` sets no `port`. */
export const DEFAULT_PORT = 1859;

/**
 * The project data directory when neither `--data-dir` nor config.toml's `data_dir` gives one: relative, resolved
 * against the working directory (hard contract 「产品与执行边界」 item 2).
 */
export const DEFAULT_DATA_DIR = "./literatures";
