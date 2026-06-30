function parseCommandLine(line: string) {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(line))) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }

  return tokens;
}

function fence(content: string, language = 'text') {
  return `\`\`\`${language}\n${content.replaceAll('```', '``\\`')}\n\`\`\``;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function runLocalCommand(rawInput: string) {
  const trimmed = rawInput.trim();
  if (!trimmed.startsWith('/')) {
    return { handled: false, content: '' };
  }

  const [firstLine = '', ...bodyLines] = trimmed.split(/\r?\n/);
  const [command = '', ...args] = parseCommandLine(firstLine);
  const normalizedCommand = command.toLowerCase();

  try {
    if (normalizedCommand === '/read') {
      const filePath = args.join(' ').trim();
      if (!filePath) return { handled: true, content: '请提供要读取的文件路径。' };

      const content = await window.littleSecretary.file.read({ filePath });
      const preview = content.length > 120_000 ? `${content.slice(0, 120_000)}\n\n[内容过长，已截断显示]` : content;
      return {
        handled: true,
        content: `已读取：\`${filePath}\`\n\n${fence(preview)}`
      };
    }

    if (normalizedCommand === '/write') {
      const filePath = args.join(' ').trim();
      const content = bodyLines.join('\n');
      if (!filePath) return { handled: true, content: '请提供要写入的文件路径。' };
      if (!content) return { handled: true, content: '请在第二行开始提供要写入的内容。' };

      await window.littleSecretary.file.write({ filePath, content });
      return { handled: true, content: `已写入：\`${filePath}\`` };
    }

    if (normalizedCommand === '/ls') {
      const dirPath = args.join(' ').trim();
      if (!dirPath) return { handled: true, content: '请提供要查看的目录路径。' };

      const entries = await window.littleSecretary.file.listDirectory({ dirPath });
      const rows = entries
        .slice(0, 120)
        .map((entry) => `| ${entry.type === 'directory' ? '目录' : '文件'} | ${entry.name} | ${entry.path} |`)
        .join('\n');
      const suffix = entries.length > 120 ? '\n\n[条目过多，已截断显示]' : '';

      return {
        handled: true,
        content: `| 类型 | 名称 | 路径 |\n| --- | --- | --- |\n${rows || '| - | 空目录 | - |'}${suffix}`
      };
    }

    if (normalizedCommand === '/open') {
      const targetPath = args.join(' ').trim();
      if (!targetPath) return { handled: true, content: '请提供要打开的路径。' };

      const error = await window.littleSecretary.file.openPath(targetPath);
      if (error) throw new Error(error);
      return { handled: true, content: `已打开：\`${targetPath}\`` };
    }

    if (normalizedCommand === '/chart') {
      const rawChart = bodyLines.join('\n').trim() || args.join(' ').trim();
      if (!rawChart) {
        return {
          handled: true,
          content:
            '请提供 Chart.js JSON 配置。示例：\n\n```text\n/chart\n{\"type\":\"bar\",\"data\":{\"labels\":[\"A\",\"B\"],\"datasets\":[{\"label\":\"数量\",\"data\":[12,19]}]}}\n```'
        };
      }

      JSON.parse(rawChart);
      return {
        handled: true,
        content: `已生成图表：\n\n\`\`\`chart\n${rawChart}\n\`\`\``
      };
    }

    return { handled: false, content: '' };
  } catch (error) {
    return {
      handled: true,
      content: `本地文件操作失败：${formatError(error)}`
    };
  }
}
