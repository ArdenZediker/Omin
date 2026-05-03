import type { ReactNode } from "react";

export function renderMarkdown(text: string): ReactNode {
  const parts: ReactNode[] = [];
  const lines = text.split("\n");
  let inCodeBlock = false;
  let codeContent = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("```")) {
      if (inCodeBlock) {
        parts.push(
          <pre key={i}>
            <code>{codeContent.trim()}</code>
          </pre>
        );
        codeContent = "";
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeContent += `${line}\n`;
      continue;
    }

    if (line.startsWith("### ")) {
      parts.push(<h3 key={i}>{line.slice(4)}</h3>);
    } else if (line.startsWith("## ")) {
      parts.push(<h2 key={i}>{line.slice(3)}</h2>);
    } else if (line.startsWith("# ")) {
      parts.push(<h1 key={i}>{line.slice(2)}</h1>);
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      parts.push(<li key={i}>{renderInline(line.slice(2))}</li>);
    } else if (line.trim() === "") {
      parts.push(<div key={i} className="h-1.5" />);
    } else {
      parts.push(<p key={i}>{renderInline(line)}</p>);
    }
  }

  return <>{parts}</>;
}

function renderInline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const str = match[0];
    if (str.startsWith("`")) {
      parts.push(<code key={match.index}>{str.slice(1, -1)}</code>);
    } else if (str.startsWith("**")) {
      parts.push(<strong key={match.index}>{str.slice(2, -2)}</strong>);
    } else if (str.startsWith("*")) {
      parts.push(<em key={match.index}>{str.slice(1, -1)}</em>);
    }
    lastIndex = match.index + str.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? <>{parts}</> : text;
}
