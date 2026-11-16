/** 发布资格按文件用途判断；设计稿里的 HTML/JS 和测试代码都不能冒充产品实现。 */
export function isFunctionalDeployPath(path: string): boolean {
  if (/(^|\/)(?:designs?|docs?|documentation|artifacts?|evidence|screenshots?|videos?|reports?|coverage|dist|test|tests|__tests__|__snapshots__|fixtures|\.platform-browser|\.diagnostics|\.agents|\.codex)(\/|$)/i.test(path)) return false;
  if (/(?:^|\/)(?:readme|changelog|license|agents)(?:\.|$)|\.(?:test|spec)\.[^/]+$/i.test(path)) return false;
  // 源码、页面、样式以及影响构建/运行的配置；Markdown、PDF、设计元数据等不计入。
  return /\.(?:[cm]?[jt]sx?|vue|svelte|css|scss|sass|less|html?|kt|kts|java|swift|m|mm|c|h|cpp|hpp|rs|go|py|sh|bash|zsh|sql|json|ya?ml|toml|xml|gradle|properties)$/i.test(path)
    || /(?:^|\/)(?:Dockerfile|Makefile|Caddyfile|Gemfile|Procfile)(?:\.[^/]+)?$/.test(path);
}

export const NO_FUNCTIONAL_DEPLOY_CHANGES = "没有有效代码变动可提交：仅有设计稿、文档、测试或其他非功能文件变动，不能提交部署。";
