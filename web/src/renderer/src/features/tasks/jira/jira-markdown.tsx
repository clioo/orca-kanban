// MIT Copyright (c) 2026 Lovecast Inc. Behavior ported from Orca's
// src/renderer/src/components/sidebar/CommentMarkdown.tsx contract (the
// Jira workspace renders ADF-derived markdown with it): the bounded subset
// the daemon's ADF→markdown port produces — paragraphs, headings, nested
// lists, fenced code, blockquotes, rules, images and links — rendered as
// React elements, never raw HTML. Everything else stays literal text.
import React, { useMemo } from "react";
import { cn } from "../cn";

type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; text: string }
  | { kind: "quote"; lines: string[] }
  | { kind: "list"; ordered: boolean; start: number; items: string[]; indent: number }
  | { kind: "rule" }
  | { kind: "paragraph"; lines: string[] };

function splitBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let index = 0;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", lines: [...paragraph] });
      paragraph = [];
    }
  };

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      flushParagraph();
      index += 1;
      continue;
    }
    const fence = line.match(/^```/);
    if (fence) {
      flushParagraph();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1; // consume the closing fence (or run off the end honestly)
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      flushParagraph();
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", lines: quote });
      continue;
    }
    const item = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (item) {
      flushParagraph();
      const ordered = /\d/.test(item[2]);
      const start = ordered ? Number.parseInt(item[2], 10) : 1;
      const indent = item[1].length;
      const items: string[] = [];
      while (index < lines.length) {
        const next = lines[index].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (!next || /\d/.test(next[2]) !== ordered || next[1].length !== indent) {
          break;
        }
        items.push(next[3]);
        index += 1;
      }
      blocks.push({ kind: "list", ordered, start, items, indent });
      continue;
    }
    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  return blocks;
}

/** Bounded inline subset: images, links, inline code, bold, italic. */
export function renderInlineMarkdown(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    key += 1;
    if (match[1] !== undefined) {
      nodes.push(
        <img
          key={`${keyPrefix}-${key}`}
          src={match[2]}
          alt={match[1]}
          className="max-w-full rounded-md border border-border/50"
        />,
      );
    } else if (match[3] !== undefined) {
      nodes.push(
        <a
          key={`${keyPrefix}-${key}`}
          href={match[4]}
          target="_blank"
          rel="noreferrer"
          className="text-primary underline underline-offset-2"
        >
          {match[3]}
        </a>,
      );
    } else if (match[5] !== undefined) {
      nodes.push(
        <code
          key={`${keyPrefix}-${key}`}
          className="rounded-sm bg-muted px-1 py-0.5 text-[0.9em]"
        >
          {match[5]}
        </code>,
      );
    } else if (match[6] !== undefined) {
      nodes.push(
        <strong key={`${keyPrefix}-${key}`}>{match[6]}</strong>,
      );
    } else if (match[7] !== undefined) {
      nodes.push(<em key={`${keyPrefix}-${key}`}>{match[7]}</em>);
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes;
}

/**
 * Renders the markdown the daemon produces from Jira ADF (see
// crates/drogon-core/src/jira/adf.rs) for the issue workspace. Server/DC
 * wiki strings pass through as paragraphs.
 */
export function JiraMarkdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}): React.JSX.Element {
  const blocks = useMemo(() => splitBlocks(content), [content]);
  return (
    <div className={cn("whitespace-pre-wrap break-words", className)}>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading": {
            const Tag = (
              { 1: "h1", 2: "h2", 3: "h3", 4: "h4", 5: "h5", 6: "h6" } as const
            )[block.level] as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
            return (
              <Tag
                key={index}
                className="mt-2 mb-1 font-semibold first:mt-0"
              >
                {renderInlineMarkdown(block.text, `h${index}`)}
              </Tag>
            );
          }
          case "code":
            return (
              <pre
                key={index}
                className="my-2 overflow-x-auto rounded-md bg-muted p-2 text-[0.9em]"
              >
                <code>{block.text}</code>
              </pre>
            );
          case "quote":
            return (
              <blockquote
                key={index}
                className="my-2 border-l-2 border-border pl-3 text-muted-foreground"
              >
                {block.lines.map((line, lineIndex) => (
                  <p key={lineIndex}>{renderInlineMarkdown(line, `q${index}-${lineIndex}`)}</p>
                ))}
              </blockquote>
            );
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag
                key={index}
                className={cn(
                  "my-1 list-outside",
                  block.ordered ? "list-decimal" : "list-disc",
                )}
                style={{ marginLeft: `${block.indent + 16}px` }}
              >
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    {renderInlineMarkdown(item, `l${index}-${itemIndex}`)}
                  </li>
                ))}
              </Tag>
            );
          }
          case "rule":
            return <hr key={index} className="my-3 border-border" />;
          case "paragraph":
            return (
              <p key={index} className="my-1 first:mt-0 last:mb-0">
                {block.lines.map((line, lineIndex) => (
                  <React.Fragment key={lineIndex}>
                    {lineIndex > 0 ? <br /> : null}
                    {renderInlineMarkdown(line, `p${index}-${lineIndex}`)}
                  </React.Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
