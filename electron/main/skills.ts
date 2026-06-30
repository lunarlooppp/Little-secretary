import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface SkillConfig {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
}

export interface LoadedSkill {
  id: string;
  name: string;
  path: string;
  content: string;
}

export async function loadSkill(config: SkillConfig): Promise<LoadedSkill> {
  const skillPath = path.resolve(config.path);
  const stat = await fs.stat(skillPath);
  const skillFile = stat.isDirectory() ? path.join(skillPath, 'SKILL.md') : skillPath;
  const content = await fs.readFile(skillFile, 'utf8');
  const name = config.name.trim() || path.basename(path.dirname(skillFile));

  return {
    id: config.id,
    name,
    path: skillFile,
    content
  };
}

export async function loadEnabledSkills(configs: SkillConfig[]) {
  const loaded: LoadedSkill[] = [];

  for (const config of configs) {
    if (!config.enabled) continue;
    try {
      loaded.push(await loadSkill(config));
    } catch {
      // Ignore broken skills at prompt-build time; the settings panel can still show the configured path.
    }
  }

  return loaded;
}

export function skillsToPrompt(skills: LoadedSkill[]) {
  if (skills.length === 0) return '';

  return [
    '你可以使用以下已导入 Skills。只有当用户需求明显匹配某个 Skill 时才应用其说明：',
    ...skills.map((skill) => `\n[Skill: ${skill.name}]\n${skill.content}`)
  ].join('\n');
}
