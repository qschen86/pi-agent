/** Frozen pre-structured-facts reader; portable across rebases, shallow clones and source archives. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';

type LegacyReader = Pick<typeof import('../../src/pi-community-profile.js'),'loadPiCommunityProfile'>;

export async function loadLegacyCommunityProfile(outputDir:string):Promise<LegacyReader> {
  const fixture=new URL('./pi-community-profile-v1.ts.txt',import.meta.url);
  const output=join(outputDir,'legacy-community-profile-v1.mjs');
  await build({
    stdin:{
      contents:readFileSync(fixture,'utf8'),
      resolveDir:fileURLToPath(new URL('../../src/',import.meta.url)),
      sourcefile:'legacy-pi-community-profile-v1.ts',
      loader:'ts'
    },
    outfile:output,bundle:true,platform:'node',format:'esm'
  });
  return import(pathToFileURL(output).href) as Promise<LegacyReader>;
}
