import { describe, expect, test } from "bun:test";
import {
  TOAST_AUMID,
  asLiteral,
  encodePsCommand,
  macToastScript,
  psLiteral,
  toastCommand,
  windowsToastScript,
} from "./notify";

describe("psLiteral / asLiteral（转义是最容易写错、最难在真机上发现的一段）", () => {
  test("PowerShell：单引号倍增，其余（$ 反引号 换行）原样保留", () => {
    expect(psLiteral("abc")).toBe("'abc'");
    expect(psLiteral("it's")).toBe("'it''s'");
    // `$` 在单引号串里不是变量展开——这正是选单引号而不是双引号的理由
    expect(psLiteral("$env:PATH $(calc)")).toBe("'$env:PATH $(calc)'");
    expect(psLiteral("a\nb")).toBe("'a\nb'");
    // 连续单引号也要逐字符倍增
    expect(psLiteral("''")).toBe("''''''");
  });

  test("AppleScript：反斜杠先转义再转义双引号（顺序反了会双重转义）", () => {
    expect(asLiteral("abc")).toBe('"abc"');
    expect(asLiteral('say "hi"')).toBe('"say \\"hi\\""');
    expect(asLiteral("back\\slash")).toBe('"back\\\\slash"');
  });
});

describe("windowsToastScript", () => {
  const s = windowsToastScript({ title: "小明 发来一条待签收记忆", body: "下周三交报告" });

  test("用官方模板而非手拼 XML（同事名字里有 & < 也不会破坏 XML）", () => {
    expect(s).toContain("ToastTemplateType]::ToastText02");
    expect(s).toContain("CreateTextNode");
    expect(s).not.toContain("<toast");
    const amp = windowsToastScript({ title: "A & B <tag>", body: "x" });
    expect(amp).toContain("'A & B <tag>'");
  });

  test("有 url 才写 activationType/launch（没有就彻底不出现，不写空的）", () => {
    expect(s).not.toContain("activationType");
    const withUrl = windowsToastScript({ title: "t", body: "b", url: "https://c.example/me-inbox" });
    expect(withUrl).toContain("SetAttribute('activationType', 'protocol')");
    expect(withUrl).toContain("SetAttribute('launch', 'https://c.example/me-inbox')");
  });

  test("url 里的单引号同样被转义（不能让正文/链接有机会闭合字符串）", () => {
    const evil = windowsToastScript({ title: "t", body: "b", url: "https://x/?a=';calc;'" });
    expect(evil).toContain("';calc;''");
  });

  test("AUMID 走字面量传参，默认用产品自己的（不是 PowerShell 的）", () => {
    expect(s).toContain(`CreateToastNotifier('${TOAST_AUMID}')`);
    expect(windowsToastScript({ title: "t", body: "b" }, "Custom.Id")).toContain("CreateToastNotifier('Custom.Id')");
  });
});

describe("encodePsCommand", () => {
  test("必须是 UTF-16LE（不是 UTF-8）——编码错了中文会变问号且 PowerShell 报语法错", () => {
    // "A" = 0x41 0x00 → base64 "QQ=="（UTF-8 下会是 "QQ==" 也一样，故用中文区分）
    expect(Buffer.from(encodePsCommand("A"), "base64").toString("utf16le")).toBe("A");
    const cn = "小本本";
    expect(Buffer.from(encodePsCommand(cn), "base64").toString("utf16le")).toBe(cn);
    // 中文在 UTF-16LE 下是 6 字节；若误用 UTF-8 会是 9 字节
    expect(Buffer.from(encodePsCommand(cn), "base64").length).toBe(6);
  });
});

describe("toastCommand（三平台一条出口 → 一次性断言全部）", () => {
  const o = { title: "标题", body: "正文" };

  test("win32：走 -EncodedCommand，正文不出现在命令行里（消掉整类注入面）", () => {
    const c = toastCommand("win32", { ...o, body: "危险';calc;'" })!;
    expect(c.cmd).toBe("powershell.exe");
    expect(c.args).toContain("-NoProfile");
    expect(c.args).toContain("-NonInteractive");
    expect(c.args).toContain("-EncodedCommand");
    expect(c.args.join(" ")).not.toContain("calc"); // 明文绝不进 argv
    const enc = c.args[c.args.indexOf("-EncodedCommand") + 1]!;
    expect(Buffer.from(enc, "base64").toString("utf16le")).toContain("calc");
  });

  test("darwin：osascript display notification，带 title 与 body", () => {
    const c = toastCommand("darwin", o)!;
    expect(c.cmd).toBe("osascript");
    expect(c.args).toEqual(["-e", macToastScript(o)]);
    expect(c.args[1]).toContain("display notification \"正文\" with title \"标题\"");
  });

  test("linux：notify-send + -a 应用名；且**不假装可点**（url 不进参数）", () => {
    const c = toastCommand("linux", { ...o, url: "https://c.example/x" })!;
    expect(c.cmd).toBe("notify-send");
    expect(c.args).toEqual(["-a", "小本本", "标题", "正文"]);
  });

  test("未知平台 / 全空内容 → null（调用方据此静默跳过，而不是拼一条废命令）", () => {
    expect(toastCommand("freebsd" as NodeJS.Platform, o)).toBeNull();
    expect(toastCommand("linux", { title: "", body: "" })).toBeNull();
  });
});
