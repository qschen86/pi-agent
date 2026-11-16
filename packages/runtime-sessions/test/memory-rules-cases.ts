/**
 * 检测规则的用例表（规则实现由模型写，用这张表验收）：[名字, 本回合证据, 应判违规]。
 * 验收用例 = 写规则时给模型看过失败项的；留出用例 = 模型从没见过，用来测泛化。scripts/draft-enforcement-rule.ts 和测试共用。
 */
export interface CaseEvidence { assistantText: string; editInputs: string[]; commandInputs?: string[] }
export type RuleCase = [name: string, ev: CaseEvidence, shouldFail: boolean];
const T = (assistantText: string, commandInputs?: string[]): CaseEvidence => ({ assistantText, editInputs: [], ...(commandInputs ? { commandInputs } : {}) });

export const ACCEPTANCE: Record<string, RuleCase[]> = {
  "entry-domain": [
    ["没有任何网址", T("已改好，测试通过。"), false],
    ["给出旧入口链接", T("已上线：[打开](https://gui.harness.fund/#/rt/abc)"), true],
    ["给出国内入口链接", T("已上线：[打开](https://gui-backup-cn.harness.fund/#/rt/abc)"), false],
    ["裸网址旧入口", T("入口：https://gui.harness.fund/#/memory 可以看。"), true],
    ["代码块 / 行内代码 / 引用行 / 说明旧入口 / 本地地址都不算", T(["已上线：https://gui-backup-cn.harness.fund/", "```", "https://gui.harness.fund/log", "```", "日志里是 `https://gui.harness.fund/x`", "> 平台通知：https://gui.harness.fund 已上线", "不再用 https://gui.harness.fund 这个旧入口。", "本地 http://127.0.0.1:8780/ 已验证"].join("\n")), false],
    ["curl 旧入口验收", T("验收完成。", ["curl -s https://gui.harness.fund/api/health"]), true],
    ["curl 国内入口验收", T("验收完成。", ["curl -s https://gui-backup-cn.harness.fund/api/health"]), false],
    ["浏览器工具打开旧入口", T("", ['{"url":"https://gui.harness.fund/#/memory"}']), true],
    ["只提到域名文字、没有链接", T("主入口 gui.harness.fund 同步，国内入口是 gui-backup-cn.harness.fund。"), false],
    ["旧域名当作子串出现的无关网址", T("参考 https://notgui.harness.fund.example.com/x"), false]
  ],
  "beijing-time": [
    ["没有带时区的时刻", T("明天 14:30 开会。"), false],
    ["泛泛提到 UTC", T("用 UTC 存储，不展示给用户。"), false],
    ["只写 UTC 的时刻", T("定时任务下次运行：06:30 UTC。"), true],
    ["只写洛杉矶时间", T("账单窗口 11-12 09:00 洛杉矶时间截止。"), true],
    ["北京时间为主、UTC 补充", T("下次运行：14:30 北京时间（06:30 UTC）。"), false],
    ["UTC+8 写法", T("下次运行：14:30 UTC+8，约 06:30 UTC。"), false],
    ["代码块和行内代码里的时间戳不算", T("日志：`2026-11-12 06:30 UTC` 已写入。\n```\n06:30 UTC job done\n```"), false],
    ["本机时间", T("提醒时间 08:00 本机时间。"), true],
    ["两行：第二行才违规", T("- 14:30 北京时间\n- 07:00 PDT"), true],
    ["纯北京时间", T("每天 09:00 北京时间提醒。"), false]
  ]
};

export const HOLDOUT: Record<string, RuleCase[]> = {
  "entry-domain": [
    ["markdown 链接旧入口", T("[入口](https://gui.harness.fund)"), true],
    ["curl 带参数访问旧入口", T("", ["curl -sS -o /dev/null -w '%{http_code}' https://gui.harness.fund/"]), true],
    ["&& 串联：访问国内入口 + grep 旧域名", T("", ["cd x && curl -s https://gui-backup-cn.harness.fund/ && grep gui.harness.fund log.txt"]), false],
    ["说明旧入口仍可访问但请用国内入口", T("旧入口 https://gui.harness.fund 仍可访问，但请用 https://gui-backup-cn.harness.fund"), false],
    ["「访问 … 查看」给旧入口", T("访问 https://gui.harness.fund/#/rt/1 查看结果"), true],
    ["引用行里的平台通知", T("> 已上线 https://gui.harness.fund/\n已核对，国内入口 https://gui-backup-cn.harness.fund/ 正常。"), false],
    ["open 旧入口", T("", ["open https://gui.harness.fund"]), true],
    ["大写域名", T("入口 https://GUI.HARNESS.FUND/x"), true],
    ["先给国内、再给旧入口（无说明）", T("入口：https://gui-backup-cn.harness.fund/a\n备用：https://gui.harness.fund/a"), true],
    ["表格单元格里的旧入口", T("| 入口 | https://gui.harness.fund/ |\n| --- | --- |"), true],
    ["波浪线围栏里的旧入口", T("~~~\ncurl https://gui.harness.fund\n~~~\n完成。"), false],
    ["完全无关的网址", T("参考 https://example.com/docs"), false]
  ],
  "beijing-time": [
    ["ISO 串 + 下次运行 + UTC", T("下次运行时间：2026-11-13 06:00 UTC"), true],
    ["账单窗口洛杉矶时间", T("账单窗口 11-01 00:00 至 11-30 23:59 洛杉矶时间"), true],
    ["北京时间为主 UTC 补充", T("- 下次运行 2026-11-13 14:00 北京时间（06:00 UTC）"), false],
    ["无时刻泛泛提时区", T("用户在 UTC-8 时区，服务端用 UTC。"), false],
    ["每天 8 点 PST 执行", T("定时任务每天 8 点 PST 执行"), true],
    ["说明日志时间戳", T("日志时间戳 2026-11-12T06:30:00Z 是 UTC 时间"), false],
    ["纯北京时间口语", T("明天上午 9 点开会。"), false],
    ["换算对照", T("UTC 10:00 = 北京时间 18:00"), false],
    ["本机时间", T("提醒设在本机时间 08:00"), true],
    ["cron 说明不含时刻词", T("Cron 表达式是 0 6 * * *（UTC）。"), false],
    ["两行：第一行合规第二行 UTC", T("- 14:30 北京时间\n- 下次运行 07:00 UTC"), true],
    ["按你问的时区", T("按你问的美国时间：09:00 PST。"), false]
  ]
};
