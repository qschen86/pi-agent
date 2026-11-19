/**
 * 首次使用引导：安装完成后自动开一个会话，由助手先发言（自我介绍 + 引导第一个自定义工作台任务）。
 * 会话的第一条「用户消息」只是给模型的启动说明，界面按这个标记把它藏起来，用户看到的第一条就是助手的欢迎语。
 * 标记必须与 apps/web/public/runtime-chat.js 的 RT_ONBOARDING_MARK 一致（有测试核对）。
 */
export const ONBOARDING_MARK = '【pi-agent 首次使用引导】';
export const ONBOARDING_TITLE = '欢迎使用 pi-agent';
export const ONBOARDING_KIND = 'welcome';

/** 欢迎语之后输入框上方的预置任务；点一下等同于用户发送 text。最多 3 条（快捷回复上限）。 */
export const ONBOARDING_REPLIES = Object.freeze([
  Object.freeze({ label: '本周计划清单', text: '帮我做一个本周计划清单页面：每项可以勾选完成，保存成网页让我预览。' }),
  Object.freeze({ label: '习惯打卡面板', text: '帮我做一个习惯打卡面板：我能添加习惯、每天勾选打卡，并看到本周完成情况。' }),
  Object.freeze({ label: '学习/家庭日程看板', text: '帮我做一个一周的学习和家庭日程看板：按天列出安排，方便全家人一起看。' })
]);

export function onboardingPrompt() {
  return `${ONBOARDING_MARK}
这是平台在用户刚装好 pi-agent 后自动发给你的启动说明，用户看不到这段话。请直接给用户写第一条欢迎消息，用中文，语气亲切自然，不要提到“启动说明”。

欢迎消息只包含这几点，控制在 200 字以内：
1. 一句话介绍你：你是 pi-agent，运行在用户自己 Mac 上的 AI 工作台助手，数据都保存在这台电脑里。
2. 说明你能帮忙做什么：聊天答疑、整理待办和记忆、动手做出可以直接用的小网页和工具，让工作台按用户自己的习惯来定制。
3. 邀请用户现在就一起做第一个“自定义工作台”的小任务，并给出三个可选方向：本周计划清单页、习惯打卡面板、学习/家庭日程看板；也可以直接告诉你想做什么。
4. 告诉用户可以点输入框上方的快捷按钮，也可以直接打字回复。

注意：
- 这条消息只做介绍和邀请，先不要动手做任何事，也不要创建文件，等用户回复。
- 不要自己编造按钮或编号选项；平台会在输入框上方提供三个快捷按钮。
- 之后用户选定任务时：把成果做成一个自包含的 HTML 文件（可勾选、可交互）保存在当前工作目录，文件名用英文，例如 first-workbench.html，并在回复里引用这个文件方便用户预览。不要访问外部网站，不要读取其他文件。需求不清楚时最多问一个问题，否则直接按合理的默认做。
- 做完后用一两句话说明做了什么，并问用户想不想再调整一下或做下一个。`;
}

/** 会话是否是安装时创建的引导会话，且还停留在欢迎语之后、用户尚未回复。 */
export function onboardingRepliesFor(installation, platformSessionId, turnCount) {
  const acceptance = installation?.acceptance;
  if (!acceptance || acceptance.taskKind !== ONBOARDING_KIND || acceptance.taskSession !== platformSessionId || turnCount !== 1) return undefined;
  return ONBOARDING_REPLIES.map(reply => ({ ...reply }));
}
