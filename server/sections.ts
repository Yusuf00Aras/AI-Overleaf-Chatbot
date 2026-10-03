import { UserError } from './policy.js';

export interface LatexSection {
  sectionId: string;
  command: string;
  level: number;
  title: string;
  shortTitle?: string;
  starred: boolean;
  start: number;
  bodyStart: number;
  bodyEnd: number;
  singleFileOnly: true;
}
const commands = ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'];
const escaped = (text: string, at: number) => {
  let slashes = 0;
  while (at > 0 && text[--at] === '\\') slashes++;
  return slashes % 2 === 1;
};

/** Lexical parser, not a TeX evaluator: ignores comments, verbatim and escaped commands. */
export function parseSections(text: string): LatexSection[] {
  const masked = text.split('');
  let verbatim: string | undefined;
  for (let i = 0; i < text.length; i++) {
    if (verbatim) {
      const end = `\\end{${verbatim}}`;
      if (text.startsWith(end, i)) { i += end.length - 1; verbatim = undefined; }
      else if (text[i] !== '\n') masked[i] = ' ';
      continue;
    }
    if (text[i] === '%' && !escaped(text, i)) {
      while (i < text.length && text[i] !== '\n') masked[i++] = ' ';
      continue;
    }
    if (text[i] === '\\' && !escaped(text, i)) {
      const env = /^\\begin\{(verbatim\*?|lstlisting|minted)\}/.exec(text.slice(i));
      if (env) { verbatim = env[1]; i += env[0].length - 1; continue; }
      const verb = /^\\verb\*?([^a-zA-Z\s])/.exec(text.slice(i));
      if (verb) {
        const end = text.indexOf(verb[1]!, i + verb[0].length);
        const stop = end < 0 ? text.indexOf('\n', i) : end;
        const until = stop < 0 ? text.length : stop + 1;
        while (i < until) masked[i++] = ' ';
        i--;
      }
    }
  }
  const source = masked.join('');
  const skip = (at: number) => { while (/\s/.test(source[at] ?? '') && at < source.length) at++; return at; };
  const group = (at: number, open: string, close: string): { end: number; value: string } | undefined => {
    if (source[at] !== open) return;
    let depth = 1;
    let braces = 0;
    for (let j = at + 1; j < source.length; j++) {
      if (escaped(source, j)) continue;
      if (open === '[') {
        if (source[j] === '{') braces++;
        if (source[j] === '}') braces--;
        if (braces) continue;
      }
      if (source[j] === open) depth++;
      // Explicit decrement keeps nested braces and optional brackets independent.
      if (source[j] === close) {
        depth--;
        if (!depth) return { end: j + 1, value: source.slice(at + 1, j) };
      }
    }
  };
  const result: LatexSection[] = [];
  const pattern = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(?![a-zA-Z])/g;
  let parsedThrough = 0;
  for (const match of source.matchAll(pattern)) {
    const start = match.index;
    if (start < parsedThrough || escaped(source, start)) continue;
    let at = skip(start + match[0].length);
    const starred = source[at] === '*';
    if (starred) at = skip(at + 1);
    let shortTitle: string | undefined;
    if (source[at] === '[') {
      const short = group(at, '[', ']');
      if (!short) continue;
      shortTitle = short.value;
      at = skip(short.end);
    }
    const title = group(at, '{', '}');
    if (!title) continue;
    parsedThrough = title.end;
    result.push({ sectionId: `section-${start}`, command: match[1]!, level: commands.indexOf(match[1]!),
      title: title.value, ...(shortTitle === undefined ? {} : { shortTitle }), starred,
      start, bodyStart: title.end, bodyEnd: text.length, singleFileOnly: true });
  }
  for (let i = 0; i < result.length; i++) {
    result[i]!.bodyEnd = result.slice(i + 1).find(section => section.level <= result[i]!.level)?.start ?? text.length;
  }
  return result;
}

export function sectionContent(text: string, sectionId: string): LatexSection & { content: string } {
  const section = parseSections(text).find(value => value.sectionId === sectionId);
  if (!section) throw new UserError('SECTION_NOT_FOUND: Abschnitt in dieser Revision nicht gefunden.');
  return { ...section, content: text.slice(section.bodyStart, section.bodyEnd) };
}

/** Replaces only the body, including its whitespace; heading and following sections remain byte-for-byte. */
export function replaceSection(text: string, sectionId: string, body: string): string {
  const section = sectionContent(text, sectionId);
  return text.slice(0, section.bodyStart) + body + text.slice(section.bodyEnd);
}