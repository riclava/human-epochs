const placeholder = '\n\n*正在整理图示…*\n\n'

// While a reply streams, an event log or diagram fence is still raw JSON. Show a placeholder in its place until the
// published reply replaces the preview with the validated view.
export function previewReplyText(text: string) {
  return text
    .replace(/^```(?:event_log|diagram)[ \t]*\n[\s\S]*?(?:\n```[ \t]*$|(?![\s\S]))/gmu, placeholder)
    // A fence whose first line is still arriving would flash as code.
    .replace(/\n?```[a-z_]*$/u, '')
}
