import { describe, expect, it } from "vitest";
import { generatePassword, DEFAULT_GENERATOR } from "../generator";
import { rate } from "../strength";

describe("força da senha", () => {
  it("classifica senhas fracas, médias e fortes", () => {
    expect(rate("123456")).toBe("weak");
    expect(rate("senha123")).toBe("weak");
    expect(rate("aaaaaaaaaaaa")).toBe("weak");
    expect(rate("qwertyuiop")).toBe("weak");
    expect(rate(generatePassword(DEFAULT_GENERATOR))).toBe("strong");
  });
});
