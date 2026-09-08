/** Presentation only: the fetched source remains untouched. Be conservative when
 * an opening horizontal rule is ordinary Markdown rather than frontmatter. */
export function markdownBody(content: string): string {
  const opening = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!opening) return content
  let hasField = false
  for (const line of opening[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const field = line.match(/^[A-Za-z_][\w-]*:[ \t]*(.*)$/)
    if (field) {
      hasField = true
      const value = field[1].trim()
      // Leave malformed/unclosed metadata visible rather than swallowing prose.
      if (value.startsWith('"') && !/^"(?:[^"\\]|\\.)*"(?:\s+#.*)?$/.test(value)) return content
      if (value.startsWith("'") && !/^'(?:[^']|'')*'(?:\s+#.*)?$/.test(value)) return content
      if (value.startsWith('[') && !/\](?:\s+#.*)?$/.test(value)) return content
      if (value.startsWith('{') && !/\}(?:\s+#.*)?$/.test(value)) return content
    } else if (!(hasField && /^\s+\S/.test(line))) return content
  }
  return hasField ? content.slice(opening[0].length) : content
}
