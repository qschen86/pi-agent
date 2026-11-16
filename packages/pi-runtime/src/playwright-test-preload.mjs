/** Runtime-owned module binding; project tests need no local package installation. */
import {registerHooks,createRequire} from 'node:module';
import {join} from 'node:path';
const root=process.env.PI_RUNTIME_TEST_PACKAGE;
if(!root)throw new Error('Runtime test package is required');
const require=createRequire(join(root,'package.json'));
const aliases=new Map(['@playwright/test','playwright/test','playwright','playwright-core'].map(name=>[name,require.resolve(name)]));
registerHooks({resolve(specifier,context,nextResolve){
  const target=aliases.get(specifier);
  return nextResolve(target&&context.conditions.includes('import')?target.replace(/\.js$/,'.mjs'):target??specifier,context);
}});
