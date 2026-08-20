import { describe, expect, test } from "bun:test";
import { loadConfig, applyEnvOverrides, expandHome, ConfigError } from "../../src/config/load.ts";
import { resolveSecret, resolveSecretsDeep } from "../../src/config/secret.ts";
import { gatewayConfigSchema } from "../../src/config/schema.ts";

describe("config schema", () => {
	test("requires qq credentials", () => {
		const r = gatewayConfigSchema.safeParse({});
		expect(r.success).toBe(false);
	});
	test("accepts minimal valid config", () => {
		const r = gatewayConfigSchema.safeParse({
			qq: { app_id: "123", app_secret: "abc" },
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.timezone).toBe("Asia/Shanghai");
			expect(r.data.delivery.default_target).toBe("qq");
		}
	});
	test("rejects bad enum", () => {
		const r = gatewayConfigSchema.safeParse({
			qq: { app_id: "1", app_secret: "2" },
			omp: { approval: "nope" },
		});
		expect(r.success).toBe(false);
	});
	test("rejects bad port", () => {
		const r = gatewayConfigSchema.safeParse({
			qq: { app_id: "1", app_secret: "2" },
			admin: { port: 99999 },
		});
		expect(r.success).toBe(false);
	});
});

describe("secret resolution", () => {
	test("env var expansion", () => {
		process.env.OMP_GW_TEST_VAR = "hello";
		expect(resolveSecret("${OMP_GW_TEST_VAR}")).toBe("hello");
		delete process.env.OMP_GW_TEST_VAR;
	});
	test("fallback syntax", () => {
		delete process.env.OMP_GW_MISSING_VAR;
		expect(resolveSecret("${OMP_GW_MISSING_VAR:-def}")).toBe("def");
	});
	test("unresolved var passes through", () => {
		expect(resolveSecret("${OMP_GW_NEVER_SET}")).toBe("${OMP_GW_NEVER_SET}");
	});
	test("command resolution", () => {
		expect(resolveSecret("!echo abc")).toBe("abc");
	});
	test("command failure throws", () => {
		expect(() => resolveSecret("!exit 3")).toThrow();
	});
	test("deep resolution", () => {
		process.env.OMP_GW_DEEP = "x";
		const out = resolveSecretsDeep({ a: ["${OMP_GW_DEEP}", 1], b: { c: "plain" } });
		expect(out).toEqual({ a: ["x", 1], b: { c: "plain" } });
		delete process.env.OMP_GW_DEEP;
	});
});

describe("env overrides", () => {
	test("maps OMP_GATEWAY_QQ__APP_ID to qq.app_id", () => {
		const prev = process.env.OMP_GATEWAY_QQ__APP_ID;
		process.env.OMP_GATEWAY_QQ__APP_ID = "env-id";
		try {
			const raw = applyEnvOverrides({ qq: { app_id: "file", app_secret: "s" } });
			expect(raw.qq).toMatchObject({ app_id: "env-id", app_secret: "s" });
		} finally {
			if (prev === undefined) delete process.env.OMP_GATEWAY_QQ__APP_ID;
			else process.env.OMP_GATEWAY_QQ__APP_ID = prev;
		}
	});
	test("preserves underscore inside segment", () => {
		const prev = process.env.OMP_GATEWAY_DELIVERY__DEFAULT_TARGET;
		process.env.OMP_GATEWAY_DELIVERY__DEFAULT_TARGET = "file";
		try {
			const raw = applyEnvOverrides({ delivery: { default_target: "qq" } });
			expect(raw.delivery).toMatchObject({ default_target: "file" });
		} finally {
			if (prev === undefined) delete process.env.OMP_GATEWAY_DELIVERY__DEFAULT_TARGET;
			else process.env.OMP_GATEWAY_DELIVERY__DEFAULT_TARGET = prev;
		}
	});
});

describe("expandHome", () => {
	test("expands ~", () => {
		expect(expandHome("~/.omp-gateway/x.yml")).not.toContain("~");
	});
	test("leaves absolute paths", () => {
		expect(expandHome("C:/x/y.yml")).toBe("C:/x/y.yml");
	});
});

describe("loadConfig", () => {
	test("loads valid file", async () => {
		const dir = Bun.spawnSync({ cmd: ["node", "-e", "console.log(require('os').tmpdir())"] }).stdout
			.toString()
			.trim();
		const file = `${dir}/omp-gw-test-${Date.now()}.yml`;
		await Bun.write(
			file,
			"qq:\n  app_id: \"1\"\n  app_secret: \"!echo secret-from-cmd\"\nscheduler:\n  tick_s: 30\n",
		);
		try {
			const cfg = loadConfig(file);
			expect(cfg.qq.app_id).toBe("1");
			expect(cfg.qq.app_secret).toBe("secret-from-cmd");
			expect(cfg.scheduler.tick_s).toBe(30);
			expect(cfg.delivery.home_channel).toBe("");
		} finally {
			Bun.spawnSync({ cmd: ["node", "-e", `require('fs').unlinkSync(${JSON.stringify(file)})`] });
		}
	});
	test("missing file throws ConfigError", () => {
		expect(() => loadConfig("C:/nonexistent/nope.yml")).toThrow(ConfigError);
	});
	test("invalid config throws ConfigError", async () => {
		const dir = Bun.spawnSync({ cmd: ["node", "-e", "console.log(require('os').tmpdir())"] }).stdout
			.toString()
			.trim();
		const file = `${dir}/omp-gw-bad-${Date.now()}.yml`;
		await Bun.write(file, "qq:\n  app_id: \"1\"\nadmin:\n  port: 99999\n");
		try {
			expect(() => loadConfig(file)).toThrow(ConfigError);
		} finally {
			Bun.spawnSync({ cmd: ["node", "-e", `require('fs').unlinkSync(${JSON.stringify(file)})`] });
		}
	});
});
