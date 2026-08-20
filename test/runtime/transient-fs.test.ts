import { describe, expect, it } from "vitest";

import { isTransientFsError, retryTransientFs } from "../../src/fs/transient-fs";

function errnoError(code: string): NodeJS.ErrnoException {
	const error = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

describe("transient fs retry", () => {
	it("classifies the codes a synced volume actually fails with", () => {
		// Observed on Google Drive File Stream; node:fs's own rm loop covers only a
		// subset of these, and rename/writeFile/chmod get no retry option at all.
		for (const code of ["EBUSY", "EPERM", "EACCES", "EINVAL"]) {
			expect(isTransientFsError(errnoError(code))).toBe(true);
		}
	});

	it("does not treat a missing file as transient", () => {
		// ENOENT is a real answer. Retrying it would turn a fast correct result into a
		// slow one, and readFileIfExists depends on getting it promptly.
		expect(isTransientFsError(errnoError("ENOENT"))).toBe(false);
		expect(isTransientFsError(new Error("no code"))).toBe(false);
		expect(isTransientFsError(null)).toBe(false);
	});

	it("retries a transient failure and returns the eventual success", async () => {
		let attempts = 0;
		const result = await retryTransientFs(
			async () => {
				attempts += 1;
				if (attempts < 3) {
					throw errnoError("EINVAL");
				}
				return "written";
			},
			{ baseDelayMs: 1 },
		);

		expect(result).toBe("written");
		expect(attempts).toBe(3);
	});

	it("rethrows the original error once the budget is exhausted", async () => {
		let attempts = 0;
		await expect(
			retryTransientFs(
				async () => {
					attempts += 1;
					throw errnoError("EBUSY");
				},
				{ maxAttempts: 4, baseDelayMs: 1 },
			),
		).rejects.toMatchObject({ code: "EBUSY" });

		expect(attempts).toBe(4);
	});

	it("fails fast on a non-transient error", async () => {
		let attempts = 0;
		await expect(
			retryTransientFs(
				async () => {
					attempts += 1;
					throw errnoError("EXDEV");
				},
				{ baseDelayMs: 1 },
			),
		).rejects.toMatchObject({ code: "EXDEV" });

		// EXDEV means the temp file and destination are on different volumes. Retrying
		// that never succeeds, and it must surface immediately so the cause is obvious.
		expect(attempts).toBe(1);
	});
});
