import { describe, expect, it } from "vitest";
import { renderTitleInput, sessionTitlePrompt, titleInputParts } from "../src/session-title-prompt.js";

/**
 * 生成标题只认引用对象的标题：会话引用去掉 ID / 运行时 / 原生会话 ID / 工作目录，
 * 待办只留首行、平台记忆只留一句话规则、推荐任务只用推荐标题，正文与背景都不进标题输入。
 */
describe("title input references", () => {
  it("keeps only the referenced session title and drops its metadata", () => {
    const text = `参考 [@上传诊断](http://chat.test/#/rt/target)（会话 ID：target；运行时：codex；原生会话 ID：native-target；工作目录："\\/workspace\\/app"）继续看日志`;
    const parts = titleInputParts(text);
    expect(parts.references).toEqual([{ kind: "session", title: "上传诊断" }]);
    expect(parts.message).toBe("参考 继续看日志");
    const rendered = renderTitleInput(parts);
    expect(rendered).toContain("- session: 上传诊断");
    expect(rendered).toContain("User message:\n参考 继续看日志");
    expect(rendered).not.toContain("native-target");
    expect(rendered).not.toContain("/workspace/app");
    expect(rendered).not.toContain("会话 ID");
  });

  it("unescapes a bracketed session title and survives a reference without metadata", () => {
    const parts = titleInputParts(`[@诊断 \\[旧\\]](http://chat.test/#/rt/a)\n[@无元数据](http://chat.test/#/rt/b)`);
    expect(parts.references).toEqual([{ kind: "session", title: "诊断 [旧]" }, { kind: "session", title: "无元数据" }]);
    expect(parts.message).toBe("");
    expect(renderTitleInput(parts)).toBe("Referenced items (titles only, not the task):\n- session: 诊断 [旧]\n- session: 无元数据");
  });

  it("keeps the first line of a todo quote and drops the body, schedule and image note", () => {
    const text = [
      "引用待办记录（记于 2026-10-19 09:35）：",
      "",
      "> 整理登录报错",
      ">",
      "> 步骤：复现 500、看日志、补回归测试",
      "",
      "日程：今天 20:00",
      "",
      "（这条记录附带的图片见附件）"
    ].join("\n");
    const parts = titleInputParts(text);
    expect(parts.references).toEqual([{ kind: "todo", title: "整理登录报错" }]);
    expect(parts.message).toBe("");
    expect(renderTitleInput(parts)).not.toContain("复现 500");
    expect(renderTitleInput(parts)).not.toContain("日程");
    expect(renderTitleInput(parts)).not.toContain("附件");
  });

  it("keeps the memory statement only, not its background evidence", () => {
    const text = [
      "引用平台记忆（编号 t-abc · 项目「pi-agent」 · 明确指令）：",
      "",
      "> 手机键盘弹起时主操作仍可见",
      ">",
      "> 背景：",
      "> - 归属与消费：项目 · 明确指令 · 生效",
      "> - 依据：2026-03-08 你说过「键盘不能挡住按钮」（会话 rt-1a2b3c4d，明确指令）",
      "",
      "这条还适用吗"
    ].join("\n");
    const parts = titleInputParts(text);
    expect(parts.references).toEqual([{ kind: "memory", title: "手机键盘弹起时主操作仍可见" }]);
    expect(parts.message).toBe("这条还适用吗");
    expect(renderTitleInput(parts)).not.toContain("依据");
  });

  it("lists several reference kinds in order and dedupes repeated ones", () => {
    const text = [
      "引用待办记录（记于 2026-10-19 09:35）：",
      "",
      "> 补齐会话标题",
      "",
      "[@上传诊断](http://chat.test/#/rt/t)（会话 ID：t；运行时：codex）",
      "[@上传诊断](http://chat.test/#/rt/t)（会话 ID：t；运行时：codex）",
      "参考这两个"
    ].join("\n");
    expect(titleInputParts(text).references).toEqual([{ kind: "todo", title: "补齐会话标题" }, { kind: "session", title: "上传诊断" }]);
  });

  it("leaves a message without references untouched so the prompt stays identical", () => {
    const text = "你做个持仓小应用\n\n标的用腾讯";
    const parts = titleInputParts(text);
    expect(parts.references).toEqual([]);
    expect(renderTitleInput(parts)).toBe(text);
    expect(sessionTitlePrompt(renderTitleInput(parts))).toContain(`User prompt:\n${text}`);
  });

  it("tells the model that referenced items are titles only and the title is for the new session", () => {
    const prompt = sessionTitlePrompt(renderTitleInput(titleInputParts("[@上传诊断](http://chat.test/#/rt/t)", [{ kind: "recommended task", title: "补齐会话标题" }])));
    expect(prompt).toContain("Referenced items (titles only, not the task):");
    expect(prompt).toContain("- recommended task: 补齐会话标题");
    expect(prompt).toContain("never infer, describe or fetch anything about them beyond that title");
    expect(prompt).toContain("Always title the NEW session being created");
    expect(prompt).not.toContain("User message:");
  });
});
