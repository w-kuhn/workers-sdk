import { existsSync, rmSync } from "fs";
import path from "path";
import { logRaw, stripAnsi, updateStatus } from "@cloudflare/cli";
import { brandColor, dim } from "@cloudflare/cli/colors";
import { isInteractive, spinner } from "@cloudflare/cli/interactive";
import { spawn } from "cross-spawn";
import { getFrameworkCli } from "frameworks/index";
import { quoteShellArgs } from "../common";
import { getLatestPackageVersion } from "./latestPackageVersion";
import { detectPackageManager } from "./packages";
import type { C3Context } from "types";

/**
 * Command is a string array, like ['git', 'commit', '-m', '"Initial commit"']
 */
type Command = string[];

type RunOptions = {
	startText?: string;
	doneText?: string | ((output: string) => string);
	silent?: boolean;
	captureOutput?: boolean;
	useSpinner?: boolean;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	/** If defined this function is called to all you to transform the output from the command into a new string. */
	transformOutput?: (output: string) => string;
	/** If defined, this function is called to return a string that is used if the `transformOutput()` fails. */
	fallbackOutput?: (error: unknown) => string;
};

type MultiRunOptions = RunOptions & {
	commands: Command[];
	startText: string;
};

type PrintOptions<T> = {
	promise: Promise<T> | (() => Promise<T>);
	useSpinner?: boolean;
	startText: string;
	doneText?: string | ((output: T) => string);
};

export const runCommand = async (
	command: Command,
	opts: RunOptions = {}
): Promise<string> => {
	return printAsyncStatus({
		useSpinner: opts.useSpinner ?? opts.silent,
		startText: opts.startText || quoteShellArgs(command),
		doneText: opts.doneText,
		promise() {
			const [executable, ...args] = command;

			const cmd = spawn(executable, [...args], {
				// TODO: ideally inherit stderr, but npm install uses this for warnings
				// stdio: [ioMode, ioMode, "inherit"],
				stdio: opts.silent ? "pipe" : "inherit",
				env: {
					...process.env,
					...opts.env,
				},
				cwd: opts.cwd,
			});

			let output = ``;

			if (opts.captureOutput ?? opts.silent) {
				cmd.stdout?.on("data", (data) => {
					output += data;
				});
				cmd.stderr?.on("data", (data) => {
					output += data;
				});
			}

			return new Promise<string>((resolvePromise, reject) => {
				cmd.on("close", (code) => {
					try {
						if (code !== 0) {
							throw new Error(output, { cause: code });
						}

						// Process any captured output
						const transformOutput =
							opts.transformOutput ?? ((result: string) => result);
						const processedOutput = transformOutput(stripAnsi(output));

						// Send the captured (and processed) output back to the caller
						resolvePromise(processedOutput);
					} catch (e) {
						// Something went wrong.
						// Perhaps the command or the transform failed.
						// If there is a fallback use the result of calling that
						if (opts.fallbackOutput) {
							resolvePromise(opts.fallbackOutput(e));
						} else {
							reject(new Error(output, { cause: e }));
						}
					}
				});

				cmd.on("error", (code) => {
					reject(code);
				});
			});
		},
	});
};

// run multiple commands in sequence (not parallel)
export async function runCommands({ commands, ...opts }: MultiRunOptions) {
	return printAsyncStatus({
		useSpinner: opts.useSpinner ?? opts.silent,
		startText: opts.startText,
		doneText: opts.doneText,
		async promise() {
			const results = [];
			for (const command of commands) {
				results.push(await runCommand(command, { ...opts, useSpinner: false }));
			}
			return results.join("\n");
		},
	});
}

export const printAsyncStatus = async <T>({
	promise,
	...opts
}: PrintOptions<T>): Promise<T> => {
	let s: ReturnType<typeof spinner> | undefined;

	if (opts.useSpinner && isInteractive()) {
		s = spinner();
	}

	s?.start(opts?.startText);

	if (typeof promise === "function") {
		promise = promise();
	}

	try {
		const output = await promise;

		const doneText =
			typeof opts.doneText === "function"
				? opts.doneText(output)
				: opts.doneText;
		s?.stop(doneText);
	} catch (err) {
		s?.stop((err as Error).message);
	} finally {
		s?.stop();
	}

	return promise;
};

export const retry = async <T>(
	{
		times,
		exitCondition,
	}: { times: number; exitCondition?: (e: unknown) => boolean },
	fn: () => Promise<T>
) => {
	let error: unknown = null;
	while (times > 0) {
		try {
			return await fn();
		} catch (e) {
			error = e;
			times--;
			if (exitCondition?.(e)) {
				break;
			}
		}
	}
	throw error;
};

export const runFrameworkGenerator = async (ctx: C3Context, args: string[]) => {
	const cli = getFrameworkCli(ctx, true);
	const { npm, dlx } = detectPackageManager();
	// yarn cannot `yarn create@some-version` and doesn't have an npx equivalent
	// So to retain the ability to lock versions we run it with `npx` and spoof
	// the user agent so scaffolding tools treat the invocation like yarn
	const cmd = [...(npm === "yarn" ? ["npx"] : dlx), cli, ...args];
	const env = npm === "yarn" ? { npm_config_user_agent: "yarn" } : {};

	if (ctx.args.additionalArgs?.length) {
		cmd.push(...ctx.args.additionalArgs);
	}

	updateStatus(
		`Continue with ${ctx.template.displayName} ${dim(
			`via \`${quoteShellArgs(cmd)}\``
		)}`
	);

	// newline
	logRaw("");

	await runCommand(cmd, { env });
};

type InstallConfig = {
	startText?: string;
	doneText?: string;
	dev?: boolean;
};

export const installPackages = async (
	packages: string[],
	config: InstallConfig
) => {
	const { npm } = detectPackageManager();

	let saveFlag;
	let cmd;
	switch (npm) {
		case "yarn":
			cmd = "add";
			saveFlag = config.dev ? "-D" : "";
			break;
		case "bun":
			cmd = "add";
			saveFlag = config.dev ? "-d" : "";
			break;
		case "npm":
		case "pnpm":
		default:
			cmd = "install";
			saveFlag = config.dev ? "--save-dev" : "--save";
			break;
	}

	await runCommand([npm, cmd, saveFlag, ...packages], {
		...config,
		silent: true,
	});
};

/**
 * If a mismatch is detected between the package manager being used and the lockfiles on disk,
 * reset the state by deleting the lockfile and dependencies then re-installing with the package
 * manager used by the calling process.
 *
 * This is needed since some scaffolding tools don't detect and use the pm of the calling process,
 * and instead always use `npm`. With a project in this state, installing additional dependencies
 * with `pnpm` or `yarn` can result in install errors.
 *
 */
export const rectifyPmMismatch = async (ctx: C3Context) => {
	const { npm } = detectPackageManager();

	if (!detectPmMismatch(ctx)) {
		return;
	}

	const nodeModulesPath = path.join(ctx.project.path, "node_modules");
	if (existsSync(nodeModulesPath)) rmSync(nodeModulesPath, { recursive: true });

	const lockfilePath = path.join(ctx.project.path, "package-lock.json");
	if (existsSync(lockfilePath)) rmSync(lockfilePath);

	await runCommand([npm, "install"], {
		silent: true,
		cwd: ctx.project.path,
		startText: "Installing dependencies",
		doneText: `${brandColor("installed")} ${dim(`via \`${npm} install\``)}`,
	});
};

const detectPmMismatch = (ctx: C3Context) => {
	const { npm } = detectPackageManager();
	const projectPath = ctx.project.path;

	switch (npm) {
		case "npm":
			return false;
		case "yarn":
			return !existsSync(path.join(projectPath, "yarn.lock"));
		case "pnpm":
			return !existsSync(path.join(projectPath, "pnpm-lock.yaml"));
		case "bun":
			return !existsSync(path.join(projectPath, "bun.lockb"));
	}
};

export const npmInstall = async (ctx: C3Context) => {
	// Skip this step if packages have already been installed
	const nodeModulesPath = path.join(ctx.project.path, "node_modules");
	if (existsSync(nodeModulesPath)) {
		return;
	}

	const { npm } = detectPackageManager();

	await runCommand([npm, "install"], {
		silent: true,
		startText: "Installing dependencies",
		doneText: `${brandColor("installed")} ${dim(`via \`${npm} install\``)}`,
	});
};

export const installWrangler = async () => {
	const { npm } = detectPackageManager();

	// Exit early if already installed
	if (existsSync(path.resolve("node_modules", "wrangler"))) {
		return;
	}

	await installPackages([`wrangler`], {
		dev: true,
		startText: `Installing wrangler ${dim(
			"A command line tool for building Cloudflare Workers"
		)}`,
		doneText: `${brandColor("installed")} ${dim(
			`via \`${npm} install wrangler --save-dev\``
		)}`,
	});
};

export const isLoggedIn = async () => {
	const { npx } = detectPackageManager();
	try {
		const output = await runCommand([npx, "wrangler", "whoami"], {
			silent: true,
		});
		return /You are logged in/.test(output);
	} catch (error) {
		return false;
	}
};

export const wranglerLogin = async () => {
	const { npx } = detectPackageManager();

	const s = spinner();
	s.start(`Logging into Cloudflare ${dim("checking authentication status")}`);
	const alreadyLoggedIn = await isLoggedIn();
	s.stop(brandColor(alreadyLoggedIn ? "logged in" : "not logged in"));
	if (alreadyLoggedIn) return true;

	s.start(`Logging into Cloudflare ${dim("This will open a browser window")}`);

	// We're using a custom spinner since this is a little complicated.
	// We want to vary the done status based on the output
	const output = await runCommand([npx, "wrangler", "login"], {
		silent: true,
	});
	const success = /Successfully logged in/.test(output);

	const verb = success ? "allowed" : "denied";
	s.stop(`${brandColor(verb)} ${dim("via `wrangler login`")}`);

	return success;
};

export const listAccounts = async () => {
	const { npx } = detectPackageManager();

	const output = await runCommand([npx, "wrangler", "whoami"], {
		silent: true,
	});

	const accounts: Record<string, string> = {};
	output.split("\n").forEach((line) => {
		const match = line.match(/│\s+(.+)\s+│\s+(\w{32})\s+│/);
		if (match) {
			accounts[match[1].trim()] = match[2].trim();
		}
	});

	return accounts;
};

/**
 * Look up the latest release of workerd and use its date as the compatibility_date
 * configuration value for wrangler.toml.
 *
 * If the look up fails then we fall back to a well known date.
 *
 * The date is extracted from the version number of the workerd package tagged as `latest`.
 * The format of the version is `major.yyyymmdd.patch`.
 *
 * @returns The latest compatibility date for workerd in the form "YYYY-MM-DD"
 */
export async function getWorkerdCompatibilityDate() {
	const { compatDate: workerdCompatibilityDate } = await printAsyncStatus<{
		compatDate: string;
		isFallback: boolean;
	}>({
		useSpinner: true,
		startText: "Retrieving current workerd compatibility date",
		doneText: ({ compatDate, isFallback }) =>
			`${brandColor("compatibility date")}${
				isFallback ? dim(" Could not find workerd date, falling back to") : ""
			} ${dim(compatDate)}`,
		async promise() {
			try {
				const latestWorkerdVersion = await getLatestPackageVersion("workerd");

				// The format of the workerd version is `major.yyyymmdd.patch`.
				const match = latestWorkerdVersion.match(
					/\d+\.(\d{4})(\d{2})(\d{2})\.\d+/
				);

				if (match) {
					const [, year, month, date] = match ?? [];
					return { compatDate: `${year}-${month}-${date}`, isFallback: false };
				}
			} catch {}

			return { compatDate: "2023-05-18", isFallback: true };
		},
	});

	return workerdCompatibilityDate;
}
