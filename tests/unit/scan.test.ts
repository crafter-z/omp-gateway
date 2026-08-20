import { describe, expect, test } from "bun:test";
import { scanSecrets } from "../../src/util/scan.ts";

describe("scanSecrets — 命中脱敏", () => {
  test("app_secret 裸形态（32 位 hex）被脱敏", () => {
    const secret = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
    const { matched, redacted } = scanSecrets(`token=${secret} done`);
    expect(matched).toEqual([secret]);
    expect(redacted).toBe("token=[REDACTED:app_secret] done");
  });

  test("app_secret 字段赋值形式整段脱敏", () => {
    const { redacted } = scanSecrets("app_secret: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
    expect(redacted).toContain("[REDACTED:app_secret]");
    expect(redacted).not.toContain("a1b2c3d4e5f6a7b8");
    expect(redacted).not.toContain("app_secret:");
  });

  test("sk- 密钥", () => {
    const key = "sk-abc1234567890defghij";
    const { matched, redacted } = scanSecrets(`key=${key}`);
    expect(matched).toContain(key);
    expect(redacted).toBe("key=[REDACTED:sk_key]");
  });

  test("QQBot 鉴权头", () => {
    const { redacted } = scanSecrets("Authorization: QQBot 1234567890.a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
    expect(redacted).toBe("Authorization: [REDACTED:qqbot_token]");
    expect(redacted).not.toContain("QQBot");
    expect(redacted).not.toContain("a1b2c3d4e5f6a7b8");
  });

  test("Bearer JWT", () => {
    const jwt = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.x";
    const { redacted } = scanSecrets(`auth ${jwt}`);
    expect(redacted).toBe("auth [REDACTED:jwt]");
    expect(redacted).not.toContain("eyJ");
  });

  test("AWS AKIA key", () => {
    const key = "AKIAIOSFODNN7EXAMPLE";
    const { matched, redacted } = scanSecrets(`aws ${key}`);
    expect(matched).toContain(key);
    expect(redacted).toBe("aws [REDACTED:aws_key]");
  });

  test("环境变量风格 QQBOT_（键与值分别脱敏）", () => {
    const { redacted } = scanSecrets("export QQBOT_APP_SECRET=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
    expect(redacted).toContain("[REDACTED:qqbot_token]");
    expect(redacted).toContain("[REDACTED:app_secret]");
    expect(redacted).not.toContain("QQBOT_APP_SECRET");
    expect(redacted).not.toContain("a1b2c3d4e5f6a7b8");
  });

  test("重叠命中合并为一次脱敏", () => {
    // sk- 模式与裸 app_secret 模式同时命中同一片段 → 只脱敏一次
    const { redacted } = scanSecrets("key=sk-abc1234567890defghij");
    expect(redacted).toBe("key=[REDACTED:sk_key]");
  });
});

describe("scanSecrets — 无命中", () => {
  test("普通文本原样返回", () => {
    const text = "hello world, today is a good day";
    expect(scanSecrets(text)).toEqual({ matched: [], redacted: text });
  });

  test("短串不误报", () => {
    const text = "key=abc id=xyz";
    expect(scanSecrets(text)).toEqual({ matched: [], redacted: text });
  });

  test("不足 10 字符的 sk- 片段不误报", () => {
    const text = "use sk-x";
    expect(scanSecrets(text)).toEqual({ matched: [], redacted: text });
  });
});
