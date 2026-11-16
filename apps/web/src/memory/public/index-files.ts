import { createHash } from 'node:crypto';

/**
 * 公共记忆“按需查阅”索引的文件命名：每个项目三个文件（主题地图 / 目录 / 详情），另有 global.* 与 README.md。
 * 内容由 pipeline/topic-index.ts 生成；文件由平台写、只读，内容变了才重写。
 */
export function slugOf(project: string): string {
  const base = project.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 60) || 'project';
  return base === project ? base : `${base}-${createHash('sha256').update(project).digest('hex').slice(0, 6)}`;
}

/** 一个项目的三个文件：主题地图（很短，先读它）、目录（一行一条，按 #模块 / 关键词 grep）、详情（按编号 grep -A）。 */
export const indexFileNames = (project: string | null): { map: string; catalog: string; details: string } => {
  const base = project ? slugOf(project) : 'global';
  return { map: `${base}.md`, catalog: `${base}.catalog.md`, details: `${base}.details.md` };
};
