export interface CommandResult {
	status: number | null;
	stdout: string;
}

export interface PostinstallDeps {
	platform: string;
	arch: string;
	env: Record<string, string | undefined>;
	nodeExecutable: string;
	electronBuilderCli: string;
	patchScript: string;
	nodePtyDir: string;
	fileExists(path: string): boolean;
	listFiles(dir: string): string[];
	capture(file: string, args: string[]): CommandResult;
	/** Runs the command with inherited stdio; returns its exit code (1 when it could not run or was killed). */
	inherit(file: string, args: string[]): number;
	log(message: string): void;
}

export type PostinstallPlan =
	| { rebuild: true; reason: "forced" | "toolchain" | "no-prebuilt" }
	| { rebuild: false; reason: "prebuilt"; prebuiltDir: string };

export interface PostinstallResult {
	exitCode: number;
	plan: PostinstallPlan;
}

export const FORCE_REBUILD_ENV: string;
export function hasCppToolchain(deps: PostinstallDeps): boolean;
export function findPrebuiltDir(deps: PostinstallDeps): string | null;
export function planPostinstall(deps: PostinstallDeps): PostinstallPlan;
export function runPostinstall(deps: PostinstallDeps): PostinstallResult;
