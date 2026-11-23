// 公开版（Homebrew）的两个纯转换：未发布应用的空桩、index.html 裁剪。
// 发行载荷构建（build-homebrew-payload）用它；不含任何个人信息，随公开源码包一起发布（需求 v3.123）。
import ts from 'typescript';
import { omittedAssetPattern, omittedViews } from '../../apps/web/src/app-manifest.mjs';

const EDITION = 'homebrew';

/** 私有应用 / 公开版没带的应用的 TS 源文件：只留空桩，不带真实代码。 */
export function stubExports(source, path = 'stub.ts') {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const names = [];
  for (const statement of ast.statements) if (statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
    if (ts.isClassDeclaration(statement) && statement.name) names.push(`export class ${statement.name.text} {}`);
    else if (ts.isFunctionDeclaration(statement) && statement.name) names.push(`export function ${statement.name.text}(){return undefined}`);
    else if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.push(`export const ${declaration.name.text} = undefined;`);
  }
  return names.join('\n');
}

/** 公开版的 index.html：去掉未发布应用的底栏按钮和静态资源引用（对已经裁剪过的文件是幂等的）。 */
export function transformIndexHtml(html) {
  const hiddenViews = omittedViews(EDITION), excluded = omittedAssetPattern(EDITION);
  let out = html.replace(/[ \t]*<button\b[^>]*data-view="([^"]+)"[\s\S]*?<\/button>/g, (all, view) => hiddenViews.includes(view) ? '' : all);
  out = out.split('\n').filter(line => { const asset = line.match(/(?:src|href)="\/([^"?]+\.(?:js|css))/)?.[1]; return !(asset && excluded.test(asset)); }).join('\n');
  return out;
}
